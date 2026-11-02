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
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { AcpPresentation } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-presentation";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
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
import type { Client, CreateElicitationResponse, RequestPermissionResponse } from "@oh-my-pi/pi-utils/acp";
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

	constructor(features: readonly string[] = ["settle", "dock"]) {
		this.helloReply = { ...this.helloReply, features };
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
	cockpit = false,
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
		toolRegistry: new Map((options.initialState?.tools ?? []).map(tool => [tool.name, tool])),
	});
	const channel = new PresentationChannel(cockpit ? ["settle", "dock", "viewers", "keys"] : undefined);
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
function createPresentationControl(
	fixture: Pick<PresentationFixture, "session" | "presentation">,
	handlers: Partial<Client> = {},
	setToolUIContext: (ui: ExtensionUIContext, hasUI: boolean) => void = () => {},
) {
	const toAgent = new TransformStream<AnyMessage>();
	const messages: AnyMessage[] = [];
	const toClient = new TransformStream<AnyMessage, AnyMessage>({
		transform(message, controller) {
			messages.push(message);
			controller.enqueue(message);
		},
	});
	const agentConnection = new AgentSideConnection(
		connection =>
			new AcpAgent(
				connection,
				async () => ({ session: fixture.session, setToolUIContext }),
				fixture.session,
				fixture.presentation,
			),
		{ readable: toAgent.readable, writable: toClient.writable },
	);
	const client = new ClientSideConnection(
		() => ({
			sessionUpdate: () => {},
			requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
			...handlers,
		}),
		{ readable: toClient.readable, writable: toAgent.writable },
	);
	return {
		messages,
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

it.each([
	["allow_once", "once", 1],
	["allow_always", "session", 1],
	["reject_once", "denied", 0],
	["reject_always", "denied", 0],
] as const)(
	"projects a held ACP permission as a confirm card and settles %s only over ACP",
	async (optionId, approved, expectedExecutions) => {
		using tempDir = TempDir.createSync("@pi-acp-cockpit-permission-");
		let executions = 0;
		const tool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Permission-gated fixture",
			parameters: type({ command: "string" }),
			async execute() {
				executions++;
				return { content: [{ type: "text", text: "Executed once." }] };
			},
		};
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "approval-tool-1",
							name: tool.name,
							arguments: { command: "echo permission" },
						},
					],
				},
				{ content: ["Permission turn finished."] },
			],
		});
		const fixture = await createPresentationFixture(
			SessionManager.inMemory(tempDir.path()),
			{ streamFn: mock.stream, initialState: { tools: [tool] } },
			undefined,
			false,
			undefined,
			true,
		);
		const requested = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<RequestPermissionResponse>();
		const control = createPresentationControl(fixture, {
			requestPermission: () => {
				requested.resolve();
				return answer.promise;
			},
		});
		let prompt: Promise<unknown> | undefined;
		try {
			await control.client.initialize({ protocolVersion: 1, clientCapabilities: {} });
			const created = await control.client.newSession({ cwd: tempDir.path(), mcpServers: [] });
			const shared = fixture.channel.terminal.surface!;
			prompt = control.client.prompt({
				sessionId: created.sessionId,
				prompt: [{ type: "text", text: "Run the gated command." }],
			});
			void prompt.catch(() => {});
			await requested.promise;
			await fixture.channel.until(() =>
				fixture.channel.nodes(shared).some(node => node.k === "tool" && node.p?.status === "ask"),
			);
			const card = fixture.channel
				.nodes(shared)
				.find(node => node.k === "tool" && node.p?.key === "approval-tool-1")!;
			expect(card.p).toMatchObject({
				status: "ask",
				confirm: "card",
				ask: { allow: "Allow once", always: "Always allow", deny: "Reject" },
			});
			fixture.channel.event({ ev: "action", sf: shared, id: card.id, act: "allow", mods: [] });
			expect(executions).toBe(0);
			expect(fixture.channel.nodes(shared).find(node => node.id === card.id)?.p).toHaveProperty("status", "ask");
			answer.resolve({ outcome: { outcome: "selected", optionId } });
			await prompt;
			await fixture.channel.until(() =>
				fixture.channel
					.nodes(shared)
					.some(node => node.id === card.id && node.p && "approved" in node.p && node.p.approved === approved),
			);
			const settled = fixture.channel.nodes(shared).find(node => node.id === card.id)!;
			expect(settled.p).toMatchObject({ approved });
			expect(settled.p).not.toHaveProperty("confirm");
			expect(settled.p).not.toHaveProperty("ask");
			expect(executions).toBe(expectedExecutions);
			fixture.presentation.refreshSession(fixture.session);
			await fixture.channel.until(() =>
				fixture.channel
					.nodes(shared)
					.some(node => node.k === "tool" && node.p?.key === "approval-tool-1" && node.p.approved === approved),
			);
			expect(fixture.channel.terminal.errors).toEqual([]);
		} finally {
			answer.resolve({ outcome: { outcome: "cancelled" } });
			await prompt?.catch(() => {});
			await fixture.dispose();
			await control.close();
		}
	},
);

it.each(["approve", "cancel"] as const)(
	"retains a permission before its real tool card and clears confirm on %s",
	async settlement => {
		using tempDir = TempDir.createSync("@pi-acp-cockpit-precard-");
		const fixture = await createPresentationFixture(
			SessionManager.inMemory(tempDir.path()),
			{},
			undefined,
			false,
			undefined,
			true,
		);
		const answer = Promise.withResolvers<RequestPermissionResponse>();
		const cancellation = new AbortController();
		const requested = Promise.withResolvers<void>();
		const control = createPresentationControl(fixture, {
			requestPermission: () => {
				requested.resolve();
				return answer.promise;
			},
		});
		let permission: Promise<unknown> | undefined;
		try {
			await control.client.initialize({ protocolVersion: 1, clientCapabilities: {} });
			await control.client.newSession({ cwd: tempDir.path(), mcpServers: [] });
			permission = fixture.session.clientBridge!.requestPermission!(
				{ toolCallId: "permission-before-card", toolName: "lookup", title: "Late card" },
				[{ optionId: "once", name: "Allow", kind: "allow_once" }],
				cancellation.signal,
			);
			void permission.catch(() => {});
			await requested.promise;
			expect(fixture.channel.nodes().some(node => node.k === "tool")).toBe(false);
			fixture.session.agent.emitExternalEvent({
				type: "tool_execution_start",
				toolCallId: "permission-before-card",
				toolName: "lookup",
				args: {},
			});
			await fixture.channel.until(() =>
				fixture.channel
					.nodes()
					.some(node => node.k === "tool" && node.p?.key === "permission-before-card" && node.p.status === "ask"),
			);
			if (settlement === "cancel") cancellation.abort();
			else answer.resolve({ outcome: { outcome: "selected", optionId: "once" } });
			await permission;
			await fixture.channel.until(() =>
				fixture.channel
					.nodes()
					.some(node => node.k === "tool" && node.p?.key === "permission-before-card" && node.p.status !== "ask"),
			);
			const settled = fixture.channel
				.nodes()
				.find(node => node.k === "tool" && node.p?.key === "permission-before-card")!;
			expect(settled.p).not.toHaveProperty("confirm");
			expect(settled.p).not.toHaveProperty("ask");
			if (settlement === "approve") expect(settled.p).toHaveProperty("approved", "once");
			else expect(settled.p).not.toHaveProperty("approved");
			expect(fixture.channel.terminal.errors).toEqual([]);
		} finally {
			answer.resolve({ outcome: { outcome: "cancelled" } });
			await permission?.catch(() => {});
			await fixture.dispose();
			await control.close();
		}
	},
);

it.each(["answer", "form", "cancel"] as const)(
	"projects real elicitation ids, adjacency, multi/recommended/free text and %s settlement",
	async settlement => {
		using tempDir = TempDir.createSync("@pi-acp-cockpit-question-");
		let ui: ExtensionUIContext | undefined;
		let submitted: unknown;
		const tool: AgentTool = {
			name: "ask_fixture",
			label: "Ask",
			description: "Ask via the ACP extension UI",
			parameters: type({}),
			async execute(toolCallId, _args, signal) {
				if (!ui?.askDialog) throw new Error("ACP did not install the elicitation UI");
				submitted = await ui.askDialog(
					[
						{
							id: "choice",
							question: "Choose a direction",
							header: "Direction",
							options: [{ label: "North", description: "The northern route" }, { label: "South" }],
							recommended: 0,
						},
						{
							id: "features",
							question: "Choose features",
							options: [{ label: "Fast" }, { label: "Safe" }],
							multi: true,
							recommended: 1,
						},
						{ id: "comment", question: "Explain", options: [] },
					],
					{ signal, toolCallId },
				);
				return { content: [{ type: "text", text: "Question completed." }] };
			},
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "asking-tool-1", name: tool.name, arguments: {} }] },
				{ content: ["Question turn finished."] },
			],
		});
		const fixture = await createPresentationFixture(
			SessionManager.inMemory(tempDir.path()),
			{ streamFn: mock.stream, initialState: { tools: [tool] } },
			undefined,
			false,
			undefined,
			true,
		);
		const requested = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<CreateElicitationResponse>();
		const control = createPresentationControl(
			fixture,
			{
				unstable_createElicitation: () => {
					requested.resolve();
					return answer.promise;
				},
			},
			context => {
				ui = context;
			},
		);
		let prompt: Promise<unknown> | undefined;
		try {
			await control.client.initialize({ protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } });
			const created = await control.client.newSession({ cwd: tempDir.path(), mcpServers: [] });
			const shared = fixture.channel.terminal.surface!;
			prompt = control.client.prompt({
				sessionId: created.sessionId,
				prompt: [{ type: "text", text: "Ask the questions." }],
			});
			void prompt.catch(() => {});
			await requested.promise;
			const wire = control.messages.find(message => "method" in message && message.method === "elicitation/create");
			if (!wire || !("id" in wire)) throw new Error("No actual elicitation request was sent");
			expect(wire).toMatchObject({ params: { _meta: { "omp/toolCallId": "asking-tool-1" } } });
			await fixture.channel.until(() => fixture.channel.nodes(shared).some(node => node.k === "questions"));
			const question = fixture.channel.nodes(shared).find(node => node.k === "questions")!;
			expect(question.p).toMatchObject({
				key: `question:${wire.id}`,
				items: [
					{
						id: "q0",
						prompt: "Choose a direction",
						description: "Direction",
						choices: [{ value: "North", detail: "The northern route · Recommended" }, { value: "South" }],
						other: true,
					},
					{ id: "q1", prompt: "Choose features", multi: true, other: true },
					{ id: "q2", prompt: "Explain", other: true },
				],
				answers: { q0: "North", q1: ["Safe"] },
			});
			const order = fixture.channel.nodes(shared);
			expect(order.findIndex(node => node.p?.key === "asking-tool-1")).toBeLessThan(
				order.findIndex(node => node.id === question.id),
			);
			fixture.channel.event({
				ev: "action",
				sf: shared,
				id: question.id,
				act: "submit",
				value: { q0: "South", q1: ["Fast", "custom feature"], q2: "Free text" },
				mods: [],
			});
			expect(submitted).toBeUndefined();
			if (settlement === "cancel") {
				await control.client.cancel({ sessionId: created.sessionId });
			} else {
				answer.resolve({
					action: "accept",
					content:
						settlement === "form"
							? { q0: "South", q1: ["Fast"], q1__other: "custom feature", q2__other: "Free text" }
							: { q0: "South", q1: ["Fast", "custom feature"], q2: "Free text" },
				});
			}
			await prompt;
			await fixture.channel.until(() =>
				fixture.channel
					.nodes(shared)
					.some(node => node.id === question.id && node.k === "questions" && node.p?.readonly === true),
			);
			const resolved = fixture.channel.nodes(shared).find(node => node.id === question.id)!;
			expect(resolved.p).toMatchObject({ readonly: true, hint: settlement !== "cancel" ? "Answered" : "Cancelled" });
			if (settlement !== "cancel") {
				expect(resolved.p).toMatchObject({
					answers: { q0: "South", q1: ["Fast", "custom feature"], q2: "Free text" },
				});
				expect(submitted).toMatchObject({
					kind: "submit",
					results: [
						{ id: "choice", selectedOptions: ["South"] },
						{ id: "features", selectedOptions: ["Fast"], customInput: "custom feature" },
						{ id: "comment", selectedOptions: [], customInput: "Free text" },
					],
				});
			}
			fixture.presentation.refreshSession(fixture.session);
			await fixture.channel.until(() =>
				fixture.channel
					.nodes(shared)
					.some(
						node => node.k === "questions" && node.p?.key === `question:${wire.id}` && node.p.readonly === true,
					),
			);
			expect(fixture.channel.terminal.errors).toEqual([]);
		} finally {
			answer.resolve({ action: "cancel" });
			await prompt?.catch(() => {});
			await fixture.dispose();
			await control.close();
		}
	},
);

it.each([false, true])(
	"keeps Yard display metadata and stable keys behind viewers=%s through refresh and reload",
	async cockpit => {
		using tempDir = TempDir.createSync("@pi-acp-cockpit-identities-");
		const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const mock = createMockModel({ responses: [{ content: ["Stable assistant answer."] }] });
		const fixture = await createPresentationFixture(
			manager,
			{ streamFn: mock.stream },
			undefined,
			false,
			undefined,
			cockpit,
		);
		const control = createPresentationControl(fixture);
		let restored: PresentationFixture | undefined;
		try {
			await control.client.initialize({ protocolVersion: 1, clientCapabilities: {} });
			const created = await control.client.newSession({ cwd: tempDir.path(), mcpServers: [] });
			await control.client.prompt({
				sessionId: created.sessionId,
				_meta: { "clankyard/turn": "yard-turn-stable" },
				prompt: [
					{ type: "text", text: "Private Yard context", _meta: { "clankyard/role": "context" } },
					{ type: "text", text: "Visible operator message" },
				],
			});
			await fixture.channel.until(() => texts(fixture.channel.nodes()).includes("Stable assistant answer."));
			const user = fixture.channel.nodes().find(node => node.p?.role === "omp.user")!;
			if (cockpit) {
				expect(user.p?.key).toBe("yard-turn-stable");
				expect(user.c?.find(node => node.k === "md")?.p).toHaveProperty("text", "Visible operator message");
				expect(fixture.channel.nodes().find(node => node.p?.role === "clankyard.context")?.p).toMatchObject({
					head: "Yard context",
					collapsed: true,
				});
				expect(fixture.channel.nodes().some(node => node.p?.role === "omp.dock")).toBe(true);
			} else {
				expect(user.p?.key).toBeUndefined();
				expect(texts(fixture.channel.nodes())).toContain("Private Yard context\n\nVisible operator message");
				expect(
					fixture.channel
						.nodes()
						.some(node => node.p?.role === "clankyard.context" || node.p?.role === "omp.dock"),
				).toBe(false);
			}
			const keys = fixture.channel
				.nodes()
				.filter(node => node.p?.role === "omp.user" || node.p?.role === "omp.assistant")
				.map(node => node.p?.key);
			const assistantEntry = manager
				.getBranch()
				.find(entry => entry.type === "message" && entry.message.role === "assistant");
			expect(control.messages).toContainEqual(
				expect.objectContaining({
					method: "session/update",
					params: expect.objectContaining({
						update: expect.objectContaining({
							sessionUpdate: "agent_message_chunk",
							messageId: assistantEntry?.id,
						}),
					}),
				}),
			);
			if (cockpit) expect(keys).toContain(`${assistantEntry?.id}:before`);
			const storedUser = fixture.session.messages.find(message => message.role === "user");
			expect(storedUser?.content).toEqual(
				expect.arrayContaining([{ type: "text", text: "Private Yard context\n\nVisible operator message" }]),
			);
			await manager.flush();
			const beforeReplay = control.messages.length;
			await control.client.loadSession({ sessionId: created.sessionId, cwd: tempDir.path(), mcpServers: [] });
			expect(control.messages.slice(beforeReplay)).toContainEqual(
				expect.objectContaining({
					method: "session/update",
					params: expect.objectContaining({
						update: expect.objectContaining({
							sessionUpdate: "user_message_chunk",
							messageId: "yard-turn-stable",
						}),
					}),
				}),
			);
			expect(control.messages.slice(beforeReplay)).toContainEqual(
				expect.objectContaining({
					method: "session/update",
					params: expect.objectContaining({
						update: expect.objectContaining({
							sessionUpdate: "agent_message_chunk",
							messageId: assistantEntry?.id,
						}),
					}),
				}),
			);
			fixture.presentation.refreshSession(fixture.session);
			await fixture.channel.until(() => texts(fixture.channel.nodes()).includes("Stable assistant answer."));
			expect(
				fixture.channel
					.nodes()
					.filter(node => node.p?.role === "omp.user" || node.p?.role === "omp.assistant")
					.map(node => node.p?.key),
			).toEqual(keys);
			restored = await createPresentationFixture(
				await SessionManager.open(manager.getSessionFile()!),
				{},
				undefined,
				false,
				undefined,
				cockpit,
			);
			restored.presentation.showSession(restored.session);
			await restored.channel.until(() => texts(restored!.channel.nodes()).includes("Stable assistant answer."));
			expect(
				restored.channel
					.nodes()
					.filter(node => node.p?.role === "omp.user" || node.p?.role === "omp.assistant")
					.map(node => node.p?.key),
			).toEqual(keys);
			expect(fixture.channel.terminal.errors).toEqual([]);
			expect(restored.channel.terminal.errors).toEqual([]);
		} finally {
			await restored?.dispose();
			await fixture.dispose();
			await control.close();
		}
	},
);

it("opens an advisor transcript in only its viewer and refuses advisor lifecycle mutations", async () => {
	using tempDir = TempDir.createSync("@pi-acp-cockpit-hub-");
	const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
	manager.appendMessage({ role: "user", content: "Shared parent conversation.", timestamp: 1 });
	const fixture = await createPresentationFixture(manager, {}, undefined, false, undefined, true);
	const rootFile = manager.getSessionFile()!;
	const child = SessionManager.create(tempDir.path(), `${rootFile.slice(0, -".jsonl".length)}/advisor`);
	child.appendMessage({ role: "user", content: "Review only.", timestamp: 1 });
	child.appendMessage(createAssistantMessage("Private advisor transcript."));
	await child.flush();
	const registry = AgentRegistry.global();
	const advisorId = `cockpit-advisor-${crypto.randomUUID()}`;
	const ref = registry.register({
		id: advisorId,
		displayName: "Cockpit advisor",
		kind: "advisor",
		session: null,
		sessionFile: child.getSessionFile(),
		status: "parked",
	});
	try {
		fixture.presentation.showSession(fixture.session);
		const shared = fixture.channel.terminal.surface!;
		await fixture.channel.until(() => fixture.channel.nodes(shared).some(node => node.p?.role === "omp.agents"));
		const agents = fixture.channel.nodes(shared).find(node => node.p?.role === "omp.agents")!;
		for (const viewer of ["hub-a", "hub-b"])
			fixture.channel.event({ ev: "action", sf: shared, id: agents.id, act: "agents", viewer, mods: [] });
		const viewerSurface = (viewer: string): string | undefined => {
			const open = fixture.channel.terminal.log.find(
				message =>
					message.verb === "o" &&
					typeof message.body === "object" &&
					message.body !== null &&
					"viewer" in message.body &&
					message.body.viewer === viewer,
			);
			return open &&
				typeof open.body === "object" &&
				open.body !== null &&
				"id" in open.body &&
				typeof open.body.id === "string"
				? open.body.id
				: undefined;
		};
		await fixture.channel.until(() => Boolean(viewerSurface("hub-a") && viewerSurface("hub-b")));
		const a = viewerSurface("hub-a")!;
		const b = viewerSurface("hub-b")!;
		await fixture.channel.until(
			() =>
				fixture.channel.nodes(a).some(node => node.k === "picker") &&
				fixture.channel.nodes(b).some(node => node.k === "picker"),
		);
		const pickerA = fixture.channel.nodes(a).find(node => node.k === "picker")!;
		const pickerB = fixture.channel.nodes(b).find(node => node.k === "picker")!;
		fixture.channel.event({ ev: "activate", sf: a, id: pickerA.id, item: advisorId, viewer: "hub-a" });
		await fixture.channel.until(() => texts(fixture.channel.nodes(a)).includes("Private advisor transcript."));
		expect(texts(fixture.channel.nodes(shared))).not.toContain("Private advisor transcript.");
		expect(texts(fixture.channel.nodes(b))).not.toContain("Private advisor transcript.");
		expect(fixture.channel.nodes(a).some(node => node.k === "editor" && node.p?.sendable)).toBe(false);
		fixture.channel.event({ ev: "select", sf: b, id: pickerB.id, item: advisorId, viewer: "hub-b" });
		for (const act of ["revive", "kill"]) {
			fixture.channel.event({ ev: "action", sf: b, id: pickerB.id, act, viewer: "hub-b", mods: [] });
			await fixture.channel.until(() => JSON.stringify(fixture.channel.nodes(b)).includes("read-only advisor"));
			expect(registry.get(advisorId)).toBe(ref);
			expect(ref.status).toBe("parked");
			expect(ref.session).toBeNull();
		}
		fixture.channel.event({ ev: "viewer", viewer: "hub-a", present: false });
		await fixture.channel.until(() =>
			fixture.channel.terminal.log.some(
				message =>
					message.verb === "x" &&
					typeof message.body === "object" &&
					message.body !== null &&
					"id" in message.body &&
					message.body.id === a,
			),
		);
		expect(fixture.channel.nodes(b).some(node => node.id === pickerB.id)).toBe(true);
		expect(fixture.channel.terminal.errors).toEqual([]);
	} finally {
		registry.unregister(advisorId);
		await fixture.dispose();
	}
});
