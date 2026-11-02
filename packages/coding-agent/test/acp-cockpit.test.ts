import { beforeAll, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AcpPresentation } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-presentation";
import { applySessionModel } from "@oh-my-pi/pi-coding-agent/modes/session-model-switch";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TspHello } from "@oh-my-pi/pi-tui/native/encode";
import type { TspTransport } from "@oh-my-pi/pi-tui/native/transport";
import { getCurrentThemeName, initTheme } from "@oh-my-pi/pi-tui/theme";
import { TSP_KINDS, type TspEvent, type TspNode, type TspProps } from "@oh-my-pi/pi-wire";
import { TempDir } from "@oh-my-pi/pi-utils";
import { TspTestTerminal, tspEvent } from "../../tui/test/native/tsp-harness";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

beforeAll(async () => {
	if (getCurrentThemeName() === undefined) await initTheme(false);
});

class CockpitChannel implements TspTransport {
	readonly terminal = new TspTestTerminal({ cols: 100 });
	readonly columns = 100;
	readonly appearance = undefined;
	readonly helloReply: TspHello;
	readonly hello: Promise<TspHello>;
	readonly #closed = Promise.withResolvers<void>();
	readonly closed = this.#closed.promise;
	readonly #input = new Set<(sequence: string) => void>();
	#change = Promise.withResolvers<void>();

	constructor(features = ["settle", "dock", "viewers", "keys"]) {
		this.helloReply = {
			r: "hello",
			v: 1,
			term: "cockpit-test",
			kinds: TSP_KINDS,
			features,
			cols: 100,
			credits: 1,
			reduceMotion: true,
		};
		this.hello = Promise.resolve(this.helloReply);
		this.terminal.start(sequence => {
			for (const listener of this.#input) listener(sequence);
		});
	}
	write(data: string): void {
		this.terminal.write(data);
		this.#change.resolve();
		this.#change = Promise.withResolvers<void>();
		queueMicrotask(() => {
			while (this.terminal.deliver()) {}
		});
	}
	onInput(callback: (sequence: string) => void): () => void {
		this.#input.add(callback);
		return () => this.#input.delete(callback);
	}
	event(event: TspEvent): void {
		this.terminal.send(tspEvent(event));
		while (this.terminal.deliver()) {}
	}
	nodes(sf: string): TspNode[] {
		const visit = (value: TspNode): TspNode[] => [value, ...(value.c ?? []).flatMap(visit)];
		const root = this.terminal.docs.get(sf)?.snapshot();
		return root ? visit(root) : [];
	}
	viewer(viewer: string): string | undefined {
		return [...this.terminal.docs.keys()].find(sf => sf.startsWith(`v.${viewer}.`));
	}
	async until(predicate: () => boolean): Promise<void> {
		while (!predicate()) await this.#change.promise;
	}
	close(): Promise<void> {
		this.#input.clear();
		this.terminal.stop();
		this.#closed.resolve();
		return this.closed;
	}
}

function fixture(cwd: string, features?: string[], persisted = false) {
	const auth = createInMemoryAuthStorage();
	const model = createMockModel({ responses: [] });
	auth.keys.setRuntime(model.provider, "test-key");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"display.showTokenUsage": false,
		"display.showTurnTime": false,
	});
	const registry = new ModelRegistry(auth);
	const session = new AgentSession({
		agent: new Agent({
			convertToLlm,
			streamFn: model.stream,
			getApiKey: () => "test-key",
			initialState: { model, messages: [], tools: [], systemPrompt: ["Test"] },
		}),
		sessionManager: persisted ? SessionManager.create(cwd, cwd) : SessionManager.inMemory(cwd),
		settings,
		modelRegistry: registry,
	});
	const channel = new CockpitChannel(features);
	const presentation = new AcpPresentation(channel, channel.helloReply);
	return {
		session,
		channel,
		presentation,
		model,
		async dispose() {
			await presentation.close();
			await session.dispose();
			settings.cancelPendingSaves();
			auth.close();
		},
	};
}

function modelChip(channel: CockpitChannel): TspNode {
	const chip = channel.nodes("s:1").find(value => value.p?.role === "omp.composer.model");
	if (!chip) throw new Error("The shared dock did not render its model control");
	return chip;
}

function query(channel: CockpitChannel, sf: string): string | null | undefined {
	const picker = channel.nodes(sf).find(value => value.k === "picker");
	return (picker?.p as TspProps<"picker"> | undefined)?.query;
}

it("keeps model searches and keyboard focus local to each viewer, and disposes departed windows", async () => {
	using dir = TempDir.createSync("@pi-acp-cockpit-");
	const f = fixture(dir.path());
	try {
		f.presentation.showSession(f.session);
		await f.channel.until(() => f.channel.nodes("s:1").some(value => value.p?.role === "omp.dock"));
		const chip = modelChip(f.channel);
		f.channel.event({ ev: "action", sf: "s:1", id: chip.id, act: "model", viewer: "a" });
		f.channel.event({ ev: "action", sf: "s:1", id: chip.id, act: "model", viewer: "b" });
		await f.channel.until(() => Boolean(f.channel.viewer("a") && f.channel.viewer("b")));
		const a = f.channel.viewer("a")!;
		const b = f.channel.viewer("b")!;
		await f.channel.until(() => query(f.channel, a) !== undefined && query(f.channel, b) !== undefined);
		f.channel.event({ ev: "key", sf: a, viewer: "a", data: "unique-query" });
		await f.channel.until(() => query(f.channel, a) === "unique-query");
		expect(query(f.channel, b)).toBe("");
		// A correctly scoped key may never address another window's surface.
		f.channel.event({ ev: "key", sf: b, viewer: "a", data: "leak" });
		f.channel.event({ ev: "viewer", viewer: "a", present: false });
		await f.channel.until(() => !f.channel.terminal.docs.has(a));
		expect(query(f.channel, b)).toBe("");
		expect(modelChip(f.channel).id).toBe(chip.id);
		f.presentation.removeSession(f.session);
		await f.channel.until(() => !f.channel.terminal.docs.has(b));
		expect(f.channel.terminal.errors).toEqual([]);
	} finally {
		await f.dispose();
	}
});

it("does not publish cockpit controls to peers without viewers", async () => {
	using dir = TempDir.createSync("@pi-acp-legacy-");
	const f = fixture(dir.path(), ["settle", "dock"]);
	try {
		f.presentation.showSession(f.session);
		await Promise.resolve();
		expect(f.channel.nodes("s:1").some(value => value.p?.role === "omp.dock")).toBe(false);
		expect([...f.channel.terminal.docs.keys()]).toEqual(["s:1"]);
	} finally {
		await f.dispose();
	}
});

it("publishes Stop for the host but never executes cancellation from a TSP click", async () => {
	using dir = TempDir.createSync("@pi-acp-stop-");
	const f = fixture(dir.path());
	try {
		f.presentation.showSession(f.session);
		f.session.agent.emitExternalEvent({ type: "agent_start" });
		await f.channel.until(() => f.channel.nodes("s:1").some(value => value.p?.role === "omp.working.stop"));
		const stop = f.channel.nodes("s:1").find(value => value.p?.role === "omp.working.stop")!;
		let ended = false;
		const unsubscribe = f.session.subscribe(event => {
			if (event.type === "agent_end") ended = true;
		});
		f.channel.event({ ev: "action", sf: "s:1", id: stop.id, act: "interrupt", viewer: "a" });
		await Promise.resolve();
		expect(ended).toBe(false);
		expect(f.channel.nodes("s:1").some(value => value.p?.role === "omp.working.stop")).toBe(true);
		unsubscribe();
	} finally {
		await f.dispose();
	}
});

it("applies session model switches before compaction releases queued turns and retains the old model on refusal", async () => {
	using dir = TempDir.createSync("@pi-acp-switch-");
	const f = fixture(dir.path());
	try {
		const target = { ...f.model, id: `${f.model.id}-other`, name: "Other" };
		let changes = 0;
		const unsubscribe = f.session.subscribe(event => {
			if (event.type === "model_changed") changes++;
		});
		const refused = await applySessionModel({
			session: f.session,
			model: target,
			compactFirst: true,
			compact: async () => false,
		});
		expect(refused).toBe(false);
		expect(f.session.model?.id).toBe(f.model.id);
		const switched = await applySessionModel({
			session: f.session,
			model: target,
			compactFirst: true,
			compact: async apply => {
				await apply();
				expect(f.session.model?.id).toBe(target.id);
				return true;
			},
		});
		expect(switched).toBe(true);
		expect(changes).toBe(1);
		unsubscribe();
	} finally {
		await f.dispose();
	}
});

it("opens an agent's read-only transcript in only the requesting viewer without replacing the shared session", async () => {
	using dir = TempDir.createSync("@pi-acp-hub-");
	const f = fixture(dir.path(), undefined, true);
	const registry = AgentRegistry.global();
	const id = `cockpit-child-${Bun.nanoseconds()}`;
	const root = f.session.sessionManager.getSessionFile()!;
	const file = `${root.slice(0, -".jsonl".length)}/${id}.jsonl`;
	await Bun.write(
		file,
		[
			{ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: dir.path() },
			{
				type: "message",
				id: "child-user",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "Private agent transcript", timestamp: Date.now() },
			},
		]
			.map(entry => JSON.stringify(entry))
			.join("\n") + "\n",
	);
	const ref = registry.register({
		id,
		displayName: id,
		kind: "sub",
		session: null,
		sessionFile: file,
		status: "parked",
	});
	try {
		f.presentation.showSession(f.session);
		await f.channel.until(() => f.channel.nodes("s:1").some(value => value.p?.role === "omp.agents"));
		const shared = f.channel.nodes("s:1").find(value => value.p?.role === "omp.agents")!;
		const model = modelChip(f.channel);
		f.channel.event({ ev: "action", sf: "s:1", id: shared.id, act: "agents", viewer: "hub" });
		await f.channel.until(() => Boolean(f.channel.viewer("hub")));
		const sf = f.channel.viewer("hub")!;
		await f.channel.until(() => f.channel.nodes(sf).some(value => value.k === "picker"));
		const picker = f.channel.nodes(sf).find(value => value.k === "picker")!;
		f.channel.event({ ev: "activate", sf, id: picker.id, item: id, viewer: "hub" });
		await f.channel.until(() => f.channel.nodes(sf).some(value => value.p?.role === "omp.hub.transcript"));
		expect(
			f.channel
				.nodes(sf)
				.some(value => value.k === "md" && (value.p as TspProps<"md">).text?.includes("Private agent transcript")),
		).toBe(true);
		expect(f.channel.nodes(sf).some(value => value.k === "editor" || value.k === "input")).toBe(false);
		expect(modelChip(f.channel).id).toBe(model.id);
		expect(f.channel.nodes("s:1").some(value => value.p?.role === "omp.hub.transcript")).toBe(false);
		f.channel.event({ ev: "viewer", viewer: "hub", present: false });
		await f.channel.until(() => !f.channel.terminal.docs.has(sf));
		expect(registry.get(id)).toBe(ref);
	} finally {
		registry.unregister(id, ref);
		await f.dispose();
	}
});
