import { beforeAll, expect, it } from "bun:test";
import { createServer, type Socket } from "node:net";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentOptions, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { AcpPresentation } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-presentation";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	cfgRetryEnabled,
	cfgRetryBaseDelayMs,
	cfgRetryMaxDelayMs,
	cfgRetryMaxRetries,
	cfgRetryModelFallback,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { encodeTspHelloQuery, encodeTspJson, encodeTspMessage, type TspHello } from "@oh-my-pi/pi-tui/native/encode";
import { connectTspTransport, type TspTransport } from "@oh-my-pi/pi-tui/native/transport";
import { getCurrentThemeName, initTheme } from "@oh-my-pi/pi-tui/theme";
import { TSP_KINDS, type TspEvent, type TspNode } from "@oh-my-pi/pi-wire";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AgentSideConnection, type AnyMessage, ClientSideConnection } from "@oh-my-pi/pi-utils/acp";
import { ManualScheduler, TspTestTerminal, tspEvent } from "../../tui/test/native/tsp-harness";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

beforeAll(async () => {
	if (getCurrentThemeName() === undefined) await initTheme(false);
});

/** Ordinary protocol bytes go through the reference terminal applier, including replies and acks. */
class PresentationChannel implements TspTransport {
	readonly terminal = new TspTestTerminal({ cols: 100 });
	readonly columns = 100;
	// Do not change the process-wide terminal appearance in this in-process fixture.
	readonly appearance = undefined;
	pendingOutputBytes = 0;
	readonly helloReply: TspHello = {
		r: "hello",
		v: 1,
		term: "acp-live-test",
		kinds: TSP_KINDS,
		features: ["settle", "dock"],
		cols: 100,
		credits: 1,
		reduceMotion: true,
	};
	readonly hello = Promise.resolve(this.helloReply);
	readonly #closed = Promise.withResolvers<void>();
	readonly closed = this.#closed.promise;
	readonly #input = new Set<(sequence: string) => void>();
	#change = Promise.withResolvers<void>();
	closeCalls = 0;
	inputCalls = 0;

	constructor() {
		this.terminal.start(sequence => {
			this.inputCalls++;
			for (const listener of this.#input) listener(sequence);
		});
	}

	write(data: string): void {
		this.terminal.write(data);
		this.#change.resolve();
		this.#change = Promise.withResolvers<void>();
		// Never deliver the ack reentrantly while the backend is still writing its frame.
		queueMicrotask(() => {
			while (this.terminal.deliver()) {
				// Drain terminal-generated replies and acknowledgements in wire order.
			}
		});
	}

	onInput(callback: (sequence: string) => void): () => void {
		this.#input.add(callback);
		return () => this.#input.delete(callback);
	}

	event(event: TspEvent): void {
		this.input(tspEvent(event));
	}

	input(sequence: string): void {
		this.terminal.send(sequence);
		while (this.terminal.deliver()) {
			// Deliver the event and any acknowledgements already queued ahead of it.
		}
	}

	nodes(surface = this.terminal.surface): TspNode[] {
		const root = surface && this.terminal.docs.get(surface)?.snapshot();
		const visit = (node: TspNode): TspNode[] => [node, ...(node.c ?? []).flatMap(visit)];
		return root ? visit(root) : [];
	}

	async until(predicate: () => boolean): Promise<void> {
		while (!predicate()) await this.#change.promise;
	}

	close(): Promise<void> {
		this.closeCalls++;
		this.terminal.stop();
		this.#input.clear();
		this.#closed.resolve();
		return this.closed;
	}
}

function texts(nodes: readonly TspNode[]): string[] {
	return nodes.flatMap(node =>
		node.k === "text"
			? [node.p?.text ?? node.p?.spans?.map(span => span.t).join("") ?? ""]
			: node.p && "text" in node.p && typeof node.p.text === "string"
				? [node.p.text]
				: [],
	);
}

it("keeps real streamed text and tool results in one transcript through persistence, replay and close", async () => {
	using tempDir = TempDir.createSync("@pi-acp-live-presentation-");
	const authStorage = createInMemoryAuthStorage();
	const mock = createMockModel({ responses: [{ content: ["Found the answer."] }, { content: ["Still headless."] }] });
	authStorage.keys.setRuntime(mock.provider, "test-key");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"display.showTokenUsage": false,
		"display.showTurnTime": false,
		"display.hideToolActivity": false,
		"display.cacheMissMarker": false,
	});
	const stream = new AssistantMessageEventStream();
	const providerStarted = Promise.withResolvers<void>();
	const finishTool = Promise.withResolvers<void>();
	let calls = 0;
	const tool: AgentTool = {
		name: "lookup_thing",
		label: "Lookup",
		description: "Look up a test value",
		parameters: type({ q: "string" }),
		async execute(_id, _args, _signal, onUpdate) {
			onUpdate?.({ content: [{ type: "text", text: "Searching the index…" }] });
			await finishTool.promise;
			return { content: [{ type: "text", text: "The answer is 42." }] };
		},
	};
	const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: ["Test"], tools: [tool], messages: [] },
		convertToLlm,
		streamFn: (model, context, options) => {
			if (calls++ > 0) return mock.stream(model, context, options);
			providerStarted.resolve();
			return stream;
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: new ModelRegistry(authStorage),
		toolRegistry: new Map([[tool.name, tool]]),
	});
	const channel = new PresentationChannel();
	const presentation = new AcpPresentation(channel, channel.helloReply);
	let restoredSession: AgentSession | undefined;
	try {
		presentation.showSession(session);
		const prompt = session.sendUserMessage("Find the answer.");
		// Attach a rejection handler immediately, even if an intermediate assertion fails.
		void prompt.catch(() => {});
		await providerStarted.promise;
		const initial: AssistantMessage = {
			...createAssistantMessage("Looking"),
			api: mock.api,
			provider: mock.provider,
			model: mock.id,
		};
		stream.push({ type: "start", partial: initial });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "Looking", partial: initial });
		await channel.until(() => channel.nodes().some(node => node.k === "md" && node.p?.text === "Looking"));
		const md = channel.nodes().find(node => node.k === "md" && node.p?.text === "Looking")!;
		expect(md.p).toMatchObject({ text: "Looking", stream: true });
		const user = channel.nodes().filter(node => node.p?.role === "omp.user");
		expect(user).toHaveLength(1);
		const beforeAppend = channel.terminal.frames.length;

		const extended: AssistantMessage = { ...initial, content: [{ type: "text", text: "Looking up the answer" }] };
		stream.push({ type: "text_delta", contentIndex: 0, delta: " up the answer", partial: extended });
		await channel.until(() => {
			const current = channel.terminal.docs.get(channel.terminal.surface!)?.get(md.id);
			return current?.k === "md" && current.p?.text === "Looking up the answer";
		});
		expect(channel.terminal.frames.slice(beforeAppend).flatMap(frame => frame.ops)).toContainEqual([
			"text",
			md.id,
			"append",
			" up the answer",
		]);
		expect(
			channel
				.nodes()
				.filter(node => node.k === "md" && node.p?.text === "Looking up the answer")
				.map(node => node.id),
		).toEqual([md.id]);

		const toolCall = { type: "toolCall" as const, id: "lookup-1", name: tool.name, arguments: { q: "answer" } };
		const withTool: AssistantMessage = {
			...extended,
			content: [...extended.content, toolCall],
			stopReason: "toolUse",
		};
		stream.push({ type: "toolcall_start", contentIndex: 1, partial: withTool });
		stream.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial: withTool });
		await channel.until(() => channel.nodes().some(node => node.k === "tool" && node.p?.key === toolCall.id));
		const card = channel.nodes().find(node => node.k === "tool" && node.p?.key === toolCall.id)!;
		expect(card.p).toMatchObject({ role: "omp.tool.lookup_thing", status: "pending" });
		stream.push({ type: "done", reason: "toolUse", message: withTool });
		await channel.until(() => texts(channel.nodes()).some(text => text.includes("Searching the index…")));
		expect(channel.terminal.docs.get(channel.terminal.surface!)?.get(md.id)?.p).not.toHaveProperty("stream");
		expect(
			channel
				.nodes()
				.filter(node => node.k === "tool")
				.map(node => node.id),
		).toEqual([card.id]);
		expect(channel.terminal.docs.get(channel.terminal.surface!)?.get(card.id)?.p).toMatchObject({
			status: "running",
		});

		finishTool.resolve();
		await prompt;
		await session.waitForIdle();
		await channel.until(() => {
			const current = channel.terminal.docs.get(channel.terminal.surface!)?.get(card.id);
			return (
				current?.k === "tool" &&
				current.p?.status === "done" &&
				texts(channel.nodes()).includes("Found the answer.")
			);
		});
		expect(channel.terminal.docs.get(channel.terminal.surface!)?.get(md.id)?.p).toMatchObject({
			text: "Looking up the answer",
		});
		expect(
			channel
				.nodes()
				.filter(node => node.k === "tool")
				.map(node => node.id),
		).toEqual([card.id]);
		expect(
			channel
				.nodes()
				.filter(node => node.p?.role === "omp.user")
				.map(node => node.id),
		).toEqual(user.map(node => node.id));
		for (const text of ["Find the answer.", "Looking up the answer", "Found the answer."]) {
			expect(texts(channel.nodes()).filter(value => value === text)).toHaveLength(1);
		}
		expect(texts(channel.nodes()).some(text => text.includes("The answer is 42."))).toBe(true);

		channel.event({ ev: "toggle", sf: channel.terminal.surface!, id: card.id, collapsed: false });
		await channel.until(() => {
			const current = channel.terminal.docs.get(channel.terminal.surface!)?.get(card.id);
			return current?.k === "tool" && current.p?.collapsed === false;
		});
		channel.event({ ev: "toggle", sf: channel.terminal.surface!, id: card.id, collapsed: true });
		await channel.until(() => {
			const current = channel.terminal.docs.get(channel.terminal.surface!)?.get(card.id);
			return current?.k === "tool" && current.p?.collapsed === true;
		});

		await session.flushToDisk();
		const reopened = await SessionManager.open(manager.getSessionFile()!);
		restoredSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mock, systemPrompt: ["Test"], tools: [tool], messages: session.messages },
				convertToLlm,
				streamFn: mock.stream,
			}),
			sessionManager: reopened,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map([[tool.name, tool]]),
		});
		presentation.showSession(restoredSession);
		await channel.until(() => channel.nodes().some(node => node.k === "tool" && node.id !== card.id));
		// Both the branch journal and the agent's completed-message snapshot are present:
		// rebuilding must not render either user/assistant/tool twice.
		expect(channel.nodes().filter(node => node.p?.role === "omp.user")).toHaveLength(1);
		expect(channel.nodes().filter(node => node.k === "tool")).toHaveLength(1);
		for (const text of ["Find the answer.", "Looking up the answer", "Found the answer."]) {
			expect(texts(channel.nodes()).filter(value => value === text)).toHaveLength(1);
		}
		expect(channel.terminal.errors).toEqual([]);

		const surface = channel.terminal.surface!;
		await presentation.close();
		await presentation.close();
		expect(channel.closeCalls).toBe(1);
		expect(channel.terminal.log.at(-1)).toEqual({ verb: "x", body: { id: surface, keep: true } });
		const writesAfterClose = channel.terminal.log.length;
		await session.sendUserMessage("Continue without a presentation.");
		await session.waitForIdle();
		expect(session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Still headless." }],
		});
		expect(channel.terminal.log.length).toBe(writesAfterClose);
		expect(texts(channel.nodes(surface))).toContain("Found the answer.");
	} finally {
		finishTool.resolve();
		stream.end({
			...createAssistantMessage(""),
			api: mock.api,
			provider: mock.provider,
			model: mock.id,
			stopReason: "aborted",
		});
		await presentation.close();
		await session.dispose();
		await restoredSession?.dispose();
		settings.cancelPendingSaves();
		authStorage.close();
	}
});

interface PresentationFixture {
	session: AgentSession;
	channel: PresentationChannel;
	presentation: AcpPresentation;
	settings: Settings;
	dispose(): Promise<void>;
}

/** Real session/agent fixtures share the ordinary TSP reference-document loopback above. */
async function createPresentationFixture(
	manager: SessionManager,
	options: AgentOptions = {},
	extensionFactory?: ExtensionFactory,
	collapseCompactedHistory = false,
	sideStreamFn?: StreamFn,
): Promise<PresentationFixture> {
	const authStorage = createInMemoryAuthStorage();
	const mock = createMockModel({ responses: [] });
	authStorage.keys.setRuntime(mock.provider, "test-key");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"compaction.autoContinue": false,
		"compaction.keepRecentTokens": 1,
		"compaction.methodOrder": ["soft"],
		"display.collapseCompacted": collapseCompactedHistory,
		hideThinkingBlock: false,
		proseOnlyThinking: false,
		expandThinkingBlocks: true,
		"display.showTokenUsage": false,
		"display.showTurnTime": false,
		"display.hideToolActivity": false,
		"display.cacheMissMarker": false,
	});
	const registry = new ModelRegistry(authStorage);
	let extensionRunner: ExtensionRunner | undefined;
	if (extensionFactory) {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			extensionFactory,
			manager.getCwd(),
			new EventBus(),
			runtime,
			"presentation-test",
		);
		extensionRunner = new ExtensionRunner([extension], runtime, manager.getCwd(), manager, registry);
	}
	const agent = new Agent({
		getApiKey: () => "test-key",
		convertToLlm,
		streamFn: mock.stream,
		...options,
		initialState: { model: mock, systemPrompt: ["Test"], tools: [], messages: [], ...options.initialState },
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		extensionRunner,
		sideStreamFn,
	});
	const channel = new PresentationChannel();
	const presentation = new AcpPresentation(channel, channel.helloReply);
	return {
		session,
		channel,
		presentation,
		settings,
		async dispose() {
			await presentation.close();
			await session.dispose();
			settings.cancelPendingSaves();
			authStorage.close();
		},
	};
}

/** Shared real ACP loopback for compact, handoff and shake history consumers. */
function createPresentationControl(fixture: Pick<PresentationFixture, "session" | "presentation">) {
	const toAgent = new TransformStream<AnyMessage>();
	const toClient = new TransformStream<AnyMessage>();
	const agentConnection = new AgentSideConnection(
		connection =>
			new AcpAgent(
				connection,
				async () => ({ session: fixture.session, setToolUIContext: () => {} }),
				fixture.session,
				fixture.presentation,
			),
		{ readable: toAgent.readable, writable: toClient.writable },
	);
	const client = new ClientSideConnection(
		() => ({
			sessionUpdate: () => {},
			requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
		}),
		{ readable: toClient.readable, writable: toAgent.writable },
	);
	return {
		client,
		async close() {
			await Promise.all([toAgent.writable.close(), toClient.writable.close()]);
			await Promise.all([agentConnection.closed, client.closed]);
		},
	};
}

it("closes only presentation when a peer exceeds the incomplete input budget", async () => {
	using tempDir = TempDir.createSync("@pi-acp-presentation-input-budget-");
	const fixture = await createPresentationFixture(SessionManager.create(tempDir.path(), tempDir.join("sessions")));
	const control = createPresentationControl(fixture);
	try {
		await control.client.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const created = await control.client.newSession({ cwd: tempDir.path(), mcpServers: [] });
		const prefix = encodeTspMessage("e", "x".repeat(1024 * 1024), { c: "wedged", m: "1" }, 2 * 1024 * 1024);
		for (let index = 0; index < 17 && fixture.channel.closeCalls === 0; index++) fixture.channel.input(prefix);
		await fixture.channel.closed;
		expect(fixture.channel.closeCalls).toBe(1);
		const response = await control.client.prompt({
			sessionId: created.sessionId,
			prompt: [{ type: "text", text: "/shake thinking" }],
		});
		expect(response.stopReason).toBe("end_turn");
		await control.client.closeSession({ sessionId: created.sessionId });
	} finally {
		await fixture.dispose();
		await control.close();
	}
});

it("coalesces ACP transcript updates while output is backpressured and paints all completed turns after drain", async () => {
	using tempDir = TempDir.createSync("@pi-acp-presentation-drain-");
	const reply = createMockModel({ responses: [{ content: ["First result."] }, { content: ["Second result."] }] });
	const fixture = await createPresentationFixture(SessionManager.create(tempDir.path(), tempDir.join("sessions")), {
		streamFn: reply.stream,
	});
	try {
		fixture.channel.pendingOutputBytes = 300_000;
		fixture.presentation.showSession(fixture.session);
		await fixture.session.sendUserMessage("First request.");
		await fixture.session.sendUserMessage("Second request.");
		expect(texts(fixture.channel.nodes())).not.toContain("First result.");
		expect(texts(fixture.channel.nodes())).not.toContain("Second result.");
		fixture.channel.pendingOutputBytes = 0;
		await fixture.channel.until(() => texts(fixture.channel.nodes()).includes("Second result."));
		const rendered = texts(fixture.channel.nodes());
		expect(rendered.filter(text => text === "First request.")).toHaveLength(1);
		expect(rendered.filter(text => text === "First result.")).toHaveLength(1);
		expect(rendered.filter(text => text === "Second request.")).toHaveLength(1);
		expect(rendered.filter(text => text === "Second result.")).toHaveLength(1);
		expect(fixture.channel.terminal.errors).toEqual([]);
	} finally {
		await fixture.dispose();
	}
});

it.skipIf(process.platform === "win32")(
	"keeps real ACP control usable after a non-reading TSP peer trips the drain watchdog",
	async () => {
		using tempDir = TempDir.createSync("@pi-acp-wedged-peer-");
		const socketPath = tempDir.join("tsp.sock");
		const accepted = Promise.withResolvers<Socket>();
		const hello: TspHello = {
			r: "hello",
			v: 1,
			term: "wedged-test-host",
			kinds: TSP_KINDS,
			apc: 8192,
			credits: 2,
		};
		const server = createServer(socket => {
			let input = "";
			socket.setEncoding("utf8");
			socket.on("error", () => {});
			socket.on("data", (data: string) => {
				input += data;
				if (!input.includes(encodeTspHelloQuery())) return;
				socket.pause();
				socket.write(encodeTspJson("r", hello));
				accepted.resolve(socket);
			});
		});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(socketPath, listening.resolve);
		await listening.promise;
		const scheduler = new ManualScheduler();
		const transport = await connectTspTransport(socketPath, scheduler);
		const peer = await accepted.promise;
		await transport.hello;
		const authStorage = createInMemoryAuthStorage();
		const model = createMockModel({ responses: [] });
		const settings = Settings.isolated({ "compaction.enabled": false });
		const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		manager.appendMessage({ role: "user", content: "A retained large transcript.", timestamp: 1 });
		manager.appendMessage(createAssistantMessage("x".repeat(1024 * 1024)));
		const session = new AgentSession({
			agent: new Agent({
				convertToLlm,
				streamFn: model.stream,
				getApiKey: () => "test-key",
				initialState: {
					model,
					tools: [],
					systemPrompt: ["Test"],
					messages: manager.buildSessionContext().messages,
				},
			}),
			sessionManager: manager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		const presentation = new AcpPresentation(transport, hello);
		const control = createPresentationControl({ session, presentation });
		try {
			await control.client.initialize({ protocolVersion: 1, clientCapabilities: {} });
			const created = await control.client.newSession({ cwd: tempDir.path(), mcpServers: [] });
			expect(transport.pendingOutputBytes).toBeGreaterThan(256 * 1024);
			scheduler.flush(60_250);
			await transport.closed;
			expect(transport.pendingOutputBytes).toBe(0);
			const response = await control.client.prompt({
				sessionId: created.sessionId,
				prompt: [{ type: "text", text: "/shake thinking" }],
			});
			expect(response.stopReason).toBe("end_turn");
			await control.client.closeSession({ sessionId: created.sessionId });
		} finally {
			await presentation.close();
			await session.dispose();
			await control.close();
			settings.cancelPendingSaves();
			authStorage.close();
			peer.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
		}
	},
);

it("restores historical secrets once and preserves custom display and summary chronology", async () => {
	using tempDir = TempDir.createSync("@pi-acp-history-presentation-");
	const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
	const obfuscator = new SecretObfuscator([{ type: "plain", content: "tok_historical_secret" }], "history-key");
	const restoredText = "Use tok_historical_secret once.";
	const placeholderText = obfuscator.obfuscate(restoredText);
	const first = manager.appendMessage({ role: "user", content: "Historical request.", timestamp: 0 });
	manager.appendMessage({ ...createAssistantMessage(placeholderText), timestamp: 1 });
	const answer = manager.appendMessage({ ...createAssistantMessage("Before branching."), timestamp: 2 });
	manager.branchWithSummary(answer, "Abandoned branch summary.");
	manager.appendCustomMessageEntry("history-note", "Visible historical note.", true);
	manager.appendCustomMessageEntry("hidden-note", "Hidden historical note.", false);
	manager.appendMessage({ role: "user", content: "Before compacting.", timestamp: 3 });
	manager.appendCompaction("Recorded compaction summary.", undefined, first, 100);
	manager.appendMessage({ role: "user", content: "After compacting.", timestamp: 4 });
	const fixture = await createPresentationFixture(manager, {
		initialState: {
			messages: [
				...manager.buildSessionContext().messages,
				// A distinct completed assistant can share its persisted sibling's identity.
				{ ...createAssistantMessage("Completed before persistence."), timestamp: 1 },
			],
		},
	});
	fixture.session.setObfuscator(obfuscator);
	try {
		fixture.presentation.showSession(fixture.session);
		await fixture.channel.until(() => texts(fixture.channel.nodes()).includes("After compacting."));
		const rendered = texts(fixture.channel.nodes());
		expect(rendered.filter(text => text === restoredText)).toHaveLength(1);
		expect(rendered).not.toContain(placeholderText);
		expect(rendered).not.toContain("Hidden historical note.");
		const sequence = [
			restoredText,
			"Before branching.",
			"Abandoned branch summary.",
			"Visible historical note.",
			"Before compacting.",
			"Recorded compaction summary.",
			"After compacting.",
			"Completed before persistence.",
		];
		const positions = sequence.map(text => rendered.findIndex(value => value.includes(text)));
		expect(positions.every(position => position >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((left, right) => left - right));
		for (const text of sequence) expect(rendered.filter(value => value.includes(text))).toHaveLength(1);
		expect(fixture.channel.terminal.errors).toEqual([]);
	} finally {
		await fixture.dispose();
	}
});

it.each(["builtin", "command", "event"] as const)(
	"refreshes the selected native history only after successful manual %s compaction",
	async path => {
		using tempDir = TempDir.createSync("@pi-acp-compact-presentation-");
		const manager = SessionManager.inMemory(tempDir.path());
		manager.appendMessage({ role: "user", content: "Old request to collapse.", timestamp: 1 });
		manager.appendMessage({ ...createAssistantMessage("Old answer to collapse."), timestamp: 2 });
		const retained = manager.appendMessage({ role: "user", content: "Retained request.", timestamp: 3 });
		manager.appendMessage({ ...createAssistantMessage("Retained answer."), timestamp: 4 });
		let veto = true;
		let compactFromEvent: (() => Promise<void>) | undefined;
		const fixture = await createPresentationFixture(
			manager,
			{ initialState: { messages: manager.buildSessionContext().messages } },
			pi => {
				pi.on("session_start", (_event, context) => {
					compactFromEvent = () => context.compact();
				});
				pi.on("session_before_compact", event => {
					if (veto) return { cancel: true };
					return {
						compaction: {
							summary: "Fresh compact summary.",
							firstKeptEntryId: retained,
							tokensBefore: event.preparation.tokensBefore,
						},
					};
				});
				pi.registerCommand("compact_test", {
					handler: async (_args, context) => context.compact(),
				});
			},
			true,
		);
		const control = createPresentationControl(fixture);
		const { client } = control;
		try {
			await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
			const created = await client.newSession({ cwd: tempDir.path(), mcpServers: [] });
			await fixture.channel.until(() => texts(fixture.channel.nodes()).includes("Retained answer."));
			const originalUser = fixture.channel.nodes().find(node => node.p?.role === "omp.user")!;
			const runCompact = async () => {
				if (path === "event") {
					if (!compactFromEvent) throw new Error("Expected extension session_start context");
					await compactFromEvent();
				} else {
					await client.prompt({
						sessionId: created.sessionId,
						prompt: [{ type: "text", text: path === "builtin" ? "/compact" : "/compact_test" }],
					});
				}
			};
			if (path === "event") await expect(runCompact()).rejects.toThrow();
			else await runCompact();
			expect(texts(fixture.channel.nodes())).toContain("Old request to collapse.");
			expect(texts(fixture.channel.nodes())).not.toContain("Fresh compact summary.");
			expect(fixture.channel.nodes().find(node => node.p?.role === "omp.user")?.id).toBe(originalUser.id);
			veto = false;
			await runCompact();
			await fixture.channel.until(() => texts(fixture.channel.nodes()).includes("Fresh compact summary."));
			const rendered = texts(fixture.channel.nodes());
			expect(rendered).not.toContain("Old request to collapse.");
			expect(rendered).not.toContain("Old answer to collapse.");
			expect(rendered.filter(text => text === "Retained request.")).toHaveLength(1);
			expect(rendered.filter(text => text === "Retained answer.")).toHaveLength(1);
			expect(rendered.indexOf("Retained answer.")).toBeLessThan(rendered.indexOf("Fresh compact summary."));
			expect(fixture.channel.terminal.errors).toEqual([]);
			await client.closeSession({ sessionId: created.sessionId });
		} finally {
			await fixture.dispose();
			await control.close();
		}
	},
);

it("replaces a mid-transform Cursor preview with the authoritative completed tool result", async () => {
	using tempDir = TempDir.createSync("@pi-acp-cursor-presentation-");
	const gate = Promise.withResolvers<void>();
	const transformStarted = Promise.withResolvers<void>();
	const assistantReady = Promise.withResolvers<void>();
	const toolCall = {
		type: "toolCall" as const,
		id: "cursor-transform-tool",
		name: "lookup_thing",
		arguments: { q: "answer" },
		[kCursorExecResolved]: true,
	};
	const assistant: AssistantMessage = { ...createAssistantMessage("Cursor lookup"), content: [toolCall] };
	const provisional: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: "Provisional cursor output." }],
		isError: false,
		timestamp: 10,
	};
	const fixture = await createPresentationFixture(SessionManager.inMemory(tempDir.path()), {
		cursorOnToolResult: async message => {
			transformStarted.resolve();
			await gate.promise;
			return { ...message, content: [{ type: "text", text: "Authoritative transformed output." }] };
		},
		streamFn: (_model, _context, options) => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: assistant });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: assistant });
				void options?.cursorOnToolResult?.(provisional);
				stream.push({ type: "done", reason: "stop", message: assistant });
			});
			return stream;
		},
	});
	fixture.session.subscribe(event => {
		if (event.type === "message_update" && event.message.role === "assistant") assistantReady.resolve();
	});
	let prompt: Promise<void> | undefined;
	try {
		prompt = fixture.session.sendUserMessage("Attach during the cursor transform.");
		void prompt.catch(() => {});
		await transformStarted.promise;
		await assistantReady.promise;
		fixture.presentation.showSession(fixture.session);
		await fixture.channel.until(() =>
			texts(fixture.channel.nodes()).some(text => text.includes("Provisional cursor output.")),
		);
		const card = fixture.channel.nodes().find(node => node.k === "tool" && node.p?.key === toolCall.id)!;
		if (card.k !== "tool") throw new Error("Expected Cursor tool card");
		expect(card.p?.status).not.toBe("done");
		gate.resolve();
		await prompt;
		await fixture.session.waitForIdle();
		await fixture.channel.until(() =>
			texts(fixture.channel.nodes()).some(text => text.includes("Authoritative transformed output.")),
		);
		expect(
			fixture.channel
				.nodes()
				.filter(node => node.k === "tool")
				.map(node => node.id),
		).toEqual([card.id]);
		const completed = fixture.channel.terminal.docs.get(fixture.channel.terminal.surface!)?.get(card.id);
		if (completed?.k !== "tool") throw new Error("Expected completed Cursor tool card");
		expect(completed.p?.status).toBe("done");
		expect(texts(fixture.channel.nodes()).some(text => text.includes("Provisional cursor output."))).toBe(false);
		expect(
			texts(fixture.channel.nodes()).filter(text => text.includes("Authoritative transformed output.")),
		).toHaveLength(1);
		expect(fixture.channel.terminal.errors).toEqual([]);
	} finally {
		gate.resolve();
		await prompt?.catch(() => {});
		await fixture.dispose();
	}
});

it("normalizes a live provider-original secret snapshot when refreshing persisted display history", async () => {
	using tempDir = TempDir.createSync("@pi-acp-live-secret-presentation-");
	const obfuscator = new SecretObfuscator([{ type: "plain", content: "tok_live_secret" }], "live-secret-key");
	const restoredText = "The restored credential is tok_live_secret.";
	const providerText = obfuscator.obfuscate(restoredText);
	const reply = createMockModel({ responses: [{ content: [providerText] }] });
	const fixture = await createPresentationFixture(SessionManager.create(tempDir.path(), tempDir.join("sessions")), {
		streamFn: reply.stream,
	});
	fixture.session.setObfuscator(obfuscator);
	try {
		fixture.presentation.showSession(fixture.session);
		await fixture.session.sendUserMessage("Echo the credential from the provider context.");
		await fixture.session.waitForIdle();
		await fixture.channel.until(() => texts(fixture.channel.nodes()).includes(restoredText));
		const original = fixture.channel.nodes().find(node => node.k === "md" && node.p?.text === restoredText)!;
		await fixture.session.flushToDisk();
		fixture.presentation.refreshSession(fixture.session);
		await fixture.channel.until(() =>
			fixture.channel
				.nodes()
				.some(node => node.k === "md" && node.p?.text === restoredText && node.id !== original.id),
		);
		const rendered = texts(fixture.channel.nodes());
		expect(rendered.filter(text => text === restoredText)).toHaveLength(1);
		expect(rendered).not.toContain(providerText);
		expect(fixture.channel.nodes().filter(node => node.p?.role === "omp.user")).toHaveLength(1);
		expect(fixture.channel.terminal.errors).toEqual([]);
	} finally {
		await fixture.dispose();
	}
});

it("keeps an already-attached Cursor execution-end provisional until its asynchronous result rewrite completes", async () => {
	using tempDir = TempDir.createSync("@pi-acp-attached-cursor-presentation-");
	const gate = Promise.withResolvers<void>();
	const transformStarted = Promise.withResolvers<void>();
	const assistantReady = Promise.withResolvers<void>();
	const toolCall = {
		type: "toolCall" as const,
		id: "attached-cursor-transform-tool",
		name: "lookup_thing",
		arguments: { q: "answer" },
		[kCursorExecResolved]: true,
	};
	const assistant: AssistantMessage = { ...createAssistantMessage("Cursor lookup"), content: [toolCall] };
	const provisional: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: "Execution-end cursor preview." }],
		isError: false,
		timestamp: 10,
	};
	const fixture = await createPresentationFixture(SessionManager.inMemory(tempDir.path()), {
		cursorOnToolResult: async message => {
			transformStarted.resolve();
			await gate.promise;
			return { ...message, content: [{ type: "text", text: "Rewritten attached cursor result." }] };
		},
		streamFn: (_model, _context, options) => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(async () => {
				stream.push({ type: "start", partial: assistant });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: assistant });
				await assistantReady.promise;
				fixture.session.agent.emitExternalEvent({
					type: "tool_execution_start",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					args: toolCall.arguments,
				});
				// Cursor's bridge reports execution completion before invoking the
				// optional transformer; the display must still accept message_end.
				fixture.session.agent.emitExternalEvent({
					type: "tool_execution_end",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					result: { content: provisional.content },
					isError: false,
				});
				void options?.cursorOnToolResult?.(provisional);
				stream.push({ type: "done", reason: "stop", message: assistant });
			});
			return stream;
		},
	});
	fixture.session.subscribe(event => {
		if (event.type === "message_update" && event.message.role === "assistant") assistantReady.resolve();
	});
	let prompt: Promise<void> | undefined;
	try {
		fixture.presentation.showSession(fixture.session);
		prompt = fixture.session.sendUserMessage("Remain attached while Cursor rewrites the execution result.");
		void prompt.catch(() => {});
		await transformStarted.promise;
		await fixture.channel.until(() =>
			texts(fixture.channel.nodes()).some(text => text.includes("Execution-end cursor preview.")),
		);
		const card = fixture.channel.nodes().find(node => node.k === "tool" && node.p?.key === toolCall.id)!;
		if (card.k !== "tool") throw new Error("Expected attached Cursor tool card");
		expect(card.p?.status).toBe("running");
		gate.resolve();
		await prompt;
		await fixture.session.waitForIdle();
		await fixture.channel.until(() =>
			texts(fixture.channel.nodes()).some(text => text.includes("Rewritten attached cursor result.")),
		);
		expect(
			fixture.channel
				.nodes()
				.filter(node => node.k === "tool")
				.map(node => node.id),
		).toEqual([card.id]);
		const completed = fixture.channel.terminal.docs.get(fixture.channel.terminal.surface!)?.get(card.id);
		if (completed?.k !== "tool") throw new Error("Expected rewritten attached Cursor tool card");
		expect(completed.p?.status).toBe("done");
		expect(texts(fixture.channel.nodes()).some(text => text.includes("Execution-end cursor preview."))).toBe(false);
		expect(
			texts(fixture.channel.nodes()).filter(text => text.includes("Rewritten attached cursor result.")),
		).toHaveLength(1);
		expect(fixture.channel.terminal.errors).toEqual([]);
	} finally {
		gate.resolve();
		await prompt?.catch(() => {});
		await fixture.dispose();
	}
});

it("refreshes a successful handoff summary while failed generation preserves the selected native history", async () => {
	using tempDir = TempDir.createSync("@pi-acp-handoff-presentation-");
	const manager = SessionManager.inMemory(tempDir.path());
	manager.appendMessage({ role: "user", content: "Older handoff request.", timestamp: 1 });
	manager.appendMessage({ ...createAssistantMessage("Older handoff answer."), timestamp: 2 });
	manager.appendMessage({ role: "user", content: "Continue this work.", timestamp: 3 });
	manager.appendMessage({ ...createAssistantMessage("Latest handoff answer."), timestamp: 4 });
	const handoffText = "## Goal\nNative handoff summary: continue this work.";
	const side = createMockModel({ responses: [{ content: [] }, { content: [handoffText] }] });
	const fixture = await createPresentationFixture(
		manager,
		{ initialState: { messages: manager.buildSessionContext().messages } },
		undefined,
		true,
		side.stream,
	);
	const control = createPresentationControl(fixture);
	try {
		await control.client.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const created = await control.client.newSession({ cwd: tempDir.path(), mcpServers: [] });
		await fixture.channel.until(() => texts(fixture.channel.nodes()).includes("Latest handoff answer."));
		const originalUser = fixture.channel.nodes().find(node => node.p?.role === "omp.user")!;
		const prompt = () =>
			control.client.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "/handoff" }] });
		await prompt();
		expect(texts(fixture.channel.nodes())).toContain("Older handoff request.");
		expect(texts(fixture.channel.nodes()).some(text => text.includes("Native handoff summary"))).toBe(false);
		expect(fixture.channel.nodes().find(node => node.p?.role === "omp.user")?.id).toBe(originalUser.id);
		await prompt();
		await fixture.channel.until(() =>
			texts(fixture.channel.nodes()).some(text => text.includes("Native handoff summary")),
		);
		const rendered = texts(fixture.channel.nodes());
		expect(rendered).not.toContain("Older handoff request.");
		expect(rendered).not.toContain("Older handoff answer.");
		expect(rendered.filter(text => text.includes("Native handoff summary"))).toHaveLength(1);
		expect(fixture.channel.nodes().filter(node => node.p?.role === "omp.compaction")).toHaveLength(1);
		expect(fixture.channel.terminal.errors).toEqual([]);
		await control.client.closeSession({ sessionId: created.sessionId });
	} finally {
		await fixture.dispose();
		await control.close();
	}
});

it.each(["thinking", "images"] as const)(
	"refreshes shaken %s in the selected native document without prompting the model",
	async mode => {
		using tempDir = TempDir.createSync("@pi-acp-shake-presentation-");
		const manager = SessionManager.inMemory(tempDir.path());
		manager.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "Keep this visible request." },
				{
					type: "image",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNf8AAAAASUVORK5CYII=",
					mimeType: "image/png",
				},
			],
			timestamp: 1,
		});
		manager.appendMessage({
			...createAssistantMessage("Keep this visible answer."),
			content: [
				{ type: "thinking", thinking: "Thinking worth removing." },
				{ type: "text", text: "Keep this visible answer." },
			],
			timestamp: 2,
		});
		const fixture = await createPresentationFixture(manager, {
			initialState: { messages: manager.buildSessionContext().messages },
			streamFn: () => {
				throw new Error("Local history rewrites must not invoke the model");
			},
		});
		const control = createPresentationControl(fixture);
		try {
			await control.client.initialize({ protocolVersion: 1, clientCapabilities: {} });
			const created = await control.client.newSession({ cwd: tempDir.path(), mcpServers: [] });
			await fixture.channel.until(() => texts(fixture.channel.nodes()).includes("Keep this visible answer."));
			expect(texts(fixture.channel.nodes())).toContain("Thinking worth removing.");
			expect(fixture.channel.nodes().filter(node => node.k === "image")).toHaveLength(1);
			const originalUser = fixture.channel.nodes().find(node => node.p?.role === "omp.user")!;
			const prompt = (text: string) =>
				control.client.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text }] });
			await prompt("/shake invalid");
			expect(fixture.channel.nodes().find(node => node.p?.role === "omp.user")?.id).toBe(originalUser.id);
			expect(texts(fixture.channel.nodes())).toContain("Thinking worth removing.");
			expect(fixture.channel.nodes().filter(node => node.k === "image")).toHaveLength(1);
			await prompt(`/shake ${mode}`);
			await fixture.channel.until(() =>
				mode === "thinking"
					? !texts(fixture.channel.nodes()).includes("Thinking worth removing.")
					: fixture.channel.nodes().every(node => node.k !== "image"),
			);
			const rendered = texts(fixture.channel.nodes());
			expect(rendered.filter(text => text === "Keep this visible request.")).toHaveLength(1);
			expect(rendered.filter(text => text === "Keep this visible answer.")).toHaveLength(1);
			expect(rendered.includes("Thinking worth removing.")).toBe(mode === "images");
			expect(fixture.channel.nodes().filter(node => node.k === "image")).toHaveLength(mode === "thinking" ? 1 : 0);
			const refreshedUser = fixture.channel.nodes().find(node => node.p?.role === "omp.user")!;
			await prompt(`/shake ${mode}`);
			expect(fixture.channel.nodes().find(node => node.p?.role === "omp.user")?.id).toBe(refreshedUser.id);
			expect(fixture.channel.terminal.errors).toEqual([]);
			await control.client.closeSession({ sessionId: created.sessionId });
		} finally {
			await fixture.dispose();
			await control.close();
		}
	},
);

async function createRetryPresentationFixture(
	manager: SessionManager,
	options: AgentOptions,
): Promise<PresentationFixture> {
	const fixture = await createPresentationFixture(manager, options);
	cfgRetryEnabled.override(fixture.settings, true);
	cfgRetryBaseDelayMs.override(fixture.settings, 5);
	cfgRetryMaxDelayMs.override(fixture.settings, 100);
	cfgRetryMaxRetries.override(fixture.settings, 1);
	cfgRetryModelFallback.override(fixture.settings, false);
	return fixture;
}

it.each(["recovered", "exhausted"] as const)(
	"replaces superseded retry failure cards with the ordinary %s presentation",
	async outcome => {
		using tempDir = TempDir.createSync("@pi-acp-retry-presentation-");
		const retryStarted = Promise.withResolvers<void>();
		const finishRetry = Promise.withResolvers<void>();
		const error = "503 service unavailable: overloaded_error";
		const mock = createMockModel({
			responses: [
				{ throw: error },
				async () => {
					retryStarted.resolve();
					await finishRetry.promise;
					return outcome === "recovered" ? { content: ["Recovered ACP answer."] } : { throw: error };
				},
			],
		});
		const fixture = await createRetryPresentationFixture(
			SessionManager.create(tempDir.path(), tempDir.join("sessions")),
			{ streamFn: mock.stream },
		);
		let prompt: Promise<void> | undefined;
		try {
			fixture.presentation.showSession(fixture.session);
			prompt = fixture.session.sendUserMessage("Retry the unavailable request.");
			void prompt.catch(() => {});
			await retryStarted.promise;
			await fixture.channel.until(() => fixture.channel.nodes().some(node => node.p?.role === "omp.error"));
			expect(fixture.channel.nodes().filter(node => node.p?.role === "omp.error")).toHaveLength(1);
			const originalErrorId = fixture.channel.nodes().find(node => node.p?.role === "omp.error")!.id;
			finishRetry.resolve();
			await prompt;
			await fixture.session.waitForIdle();
			await fixture.channel.until(() =>
				outcome === "recovered"
					? fixture.channel.nodes().some(node => node.p?.role === "omp.assistant.recovered")
					: fixture.channel.nodes().filter(node => node.p?.role === "omp.error").length === 1 &&
						fixture.channel.nodes().every(node => node.p?.role !== "omp.error" || node.id !== originalErrorId),
			);
			const entries = fixture.session.sessionManager
				.getEntries()
				.filter(entry => entry.type === "message" && entry.message.role === "assistant");
			expect(entries).toHaveLength(2);
			expect(entries[0]).toMatchObject({
				message: { retryRecovery: { status: outcome === "recovered" ? "recovered" : "superseded" } },
			});
			expect(mock.calls).toHaveLength(2);
			expect(fixture.channel.nodes().filter(node => node.p?.role === "omp.error")).toHaveLength(
				outcome === "recovered" ? 0 : 1,
			);
			expect(fixture.channel.nodes().filter(node => node.p?.role === "omp.assistant.recovered")).toHaveLength(
				outcome === "recovered" ? 1 : 0,
			);
			if (outcome === "recovered") {
				expect(texts(fixture.channel.nodes()).filter(text => text === "Recovered ACP answer.")).toHaveLength(1);
			} else {
				const errors = fixture.channel.nodes().filter(node => node.p?.role === "omp.error.message");
				expect(texts(errors).filter(text => text.includes(error))).toHaveLength(1);
			}
			expect(fixture.channel.terminal.errors).toEqual([]);
		} finally {
			finishRetry.resolve();
			await prompt?.catch(() => {});
			await fixture.dispose();
		}
	},
);

it("restores a running recovered tool during the deferred retry-history refresh", async () => {
	using tempDir = TempDir.createSync("@pi-acp-retry-live-tool-");
	const finishTool = Promise.withResolvers<void>();
	const toolStarted = Promise.withResolvers<void>();
	const tool: AgentTool = {
		name: "retry_lookup",
		label: "Retry lookup",
		description: "Look up the retried answer",
		parameters: type({}),
		async execute(_id, _args, _signal, onUpdate) {
			onUpdate?.({ content: [{ type: "text", text: "Recovered lookup is running." }] });
			toolStarted.resolve();
			await finishTool.promise;
			return { content: [{ type: "text", text: "Recovered lookup result." }] };
		},
	};
	const mock = createMockModel({
		responses: [
			{ throw: "503 service unavailable: overloaded_error" },
			{ content: [{ type: "toolCall", id: "retry-lookup-1", name: tool.name, arguments: {} }] },
			{ content: ["Answer after the recovered lookup."] },
		],
	});
	const fixture = await createRetryPresentationFixture(SessionManager.inMemory(tempDir.path()), {
		streamFn: mock.stream,
		initialState: { tools: [tool] },
	});
	let prompt: Promise<void> | undefined;
	try {
		fixture.presentation.showSession(fixture.session);
		prompt = fixture.session.sendUserMessage("Retry with a live lookup.");
		void prompt.catch(() => {});
		await toolStarted.promise;
		await fixture.channel.until(
			() =>
				fixture.channel.nodes().some(node => node.p?.role === "omp.assistant.recovered") &&
				fixture.channel.nodes().some(node => node.k === "tool" && node.p?.status === "running"),
		);
		expect(fixture.session.isStreaming).toBe(true);
		const cards = fixture.channel.nodes().filter(node => node.k === "tool");
		expect(cards).toHaveLength(1);
		expect(cards[0]?.p).toMatchObject({ key: "retry-lookup-1", status: "running" });
		expect(texts(fixture.channel.nodes())).toContain("Recovered lookup is running.");
		expect(fixture.channel.nodes().filter(node => node.p?.role === "omp.error")).toHaveLength(0);
		finishTool.resolve();
		await prompt;
		await fixture.session.waitForIdle();
		await fixture.channel.until(() => texts(fixture.channel.nodes()).includes("Answer after the recovered lookup."));
		expect(
			fixture.channel
				.nodes()
				.filter(node => node.k === "tool")
				.map(node => node.id),
		).toEqual(cards.map(node => node.id));
		const completed = fixture.channel.nodes().find(node => node.id === cards[0]?.id);
		expect(completed?.p).toMatchObject({ status: "done" });
		expect(texts(fixture.channel.nodes()).filter(text => text.includes("Recovered lookup result."))).toHaveLength(1);
		expect(texts(fixture.channel.nodes()).filter(text => text === "Answer after the recovered lookup.")).toHaveLength(
			1,
		);
		expect(mock.calls).toHaveLength(3);
		expect(fixture.channel.terminal.errors).toEqual([]);
	} finally {
		finishTool.resolve();
		await prompt?.catch(() => {});
		await fixture.dispose();
	}
});

it("does not let a queued retry refresh steal a newly selected live session", async () => {
	using tempDir = TempDir.createSync("@pi-acp-retry-selection-");
	const finishRetry = Promise.withResolvers<void>();
	const retryStarted = Promise.withResolvers<void>();
	const mock = createMockModel({
		responses: [
			{ throw: "503 service unavailable: overloaded_error" },
			async () => {
				retryStarted.resolve();
				await finishRetry.promise;
				return { content: ["Background recovered answer."] };
			},
		],
	});
	const fixture = await createRetryPresentationFixture(SessionManager.inMemory(tempDir.path()), {
		streamFn: mock.stream,
	});
	const stream = new AssistantMessageEventStream();
	const liveStarted = Promise.withResolvers<void>();
	const selected = await createPresentationFixture(SessionManager.inMemory(tempDir.path()), {
		streamFn: () => {
			liveStarted.resolve();
			return stream;
		},
	});
	let prompt: Promise<void> | undefined;
	let livePrompt: Promise<void> | undefined;
	let selections = 0;
	fixture.presentation.showSession(fixture.session);
	const unsubscribe = fixture.session.subscribe(event => {
		if (event.type !== "auto_retry_end" || !event.retryErrors?.length) return;
		selections++;
		// Run after the presentation listener queues its retry refresh, before
		// dispatch unwinds. The selected session is already streaming.
		fixture.presentation.showSession(selected.session);
	});
	try {
		prompt = fixture.session.sendUserMessage("Recover in the background.");
		void prompt.catch(() => {});
		await retryStarted.promise;
		livePrompt = selected.session.sendUserMessage("Keep this selected stream.");
		void livePrompt.catch(() => {});
		await liveStarted.promise;
		const partial = createAssistantMessage("Selected live preview.");
		// Subscribe before pushing deltas so even immediate delivery is observed.
		const previewReady = Promise.withResolvers<void>();
		const stopPreview = selected.session.subscribe(event => {
			if (event.type !== "message_update") return;
			stopPreview();
			previewReady.resolve();
		});
		stream.push({ type: "start", partial });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "Selected live preview.", partial });
		await previewReady.promise;
		finishRetry.resolve();
		await prompt;
		await fixture.session.waitForIdle();
		await fixture.channel.until(() => texts(fixture.channel.nodes()).includes("Selected live preview."));
		expect(selections).toBe(1);
		expect(texts(fixture.channel.nodes())).not.toContain("Background recovered answer.");
		expect(texts(fixture.channel.nodes()).filter(text => text === "Keep this selected stream.")).toHaveLength(1);
		const liveNode = fixture.channel
			.nodes()
			.find(node => node.k === "md" && node.p?.text === "Selected live preview.")!;
		expect(liveNode.p).toMatchObject({ stream: true });
		const completed = { ...partial, content: [{ type: "text" as const, text: "Selected live answer." }] };
		stream.push({ type: "text_delta", contentIndex: 0, delta: "Selected live answer.", partial: completed });
		stream.push({ type: "done", reason: "stop", message: completed });
		await livePrompt;
		await selected.session.waitForIdle();
		await fixture.channel.until(() => texts(fixture.channel.nodes()).includes("Selected live answer."));
		expect(
			fixture.channel.nodes().find(node => node.k === "md" && node.p?.text === "Selected live answer.")?.id,
		).toBe(liveNode.id);
		expect(texts(fixture.channel.nodes())).not.toContain("Background recovered answer.");
		expect(fixture.channel.terminal.errors).toEqual([]);
	} finally {
		unsubscribe();
		finishRetry.resolve();
		stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Selection test finished.") });
		await prompt?.catch(() => {});
		await livePrompt?.catch(() => {});
		await fixture.dispose();
		await selected.dispose();
	}
});
