import { afterEach, beforeAll, expect, it, spyOn } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { acquireModelRoleMutation } from "@oh-my-pi/pi-coding-agent/config/model-presets";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { openAcpModelScreen } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-model-screen";
import { AcpViewerHost } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-viewer-host";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { NativeBackend, type NativeHost } from "@oh-my-pi/pi-tui/native/backend";
import type { TspHello } from "@oh-my-pi/pi-tui/native/encode";
import type { TspTransport } from "@oh-my-pi/pi-tui/native/transport";
import { ModelHubComponent } from "@oh-my-pi/pi-tui/overlays/model-hub";
import { getCurrentThemeName, initTheme } from "@oh-my-pi/pi-tui/theme";
import { TSP_KINDS, type TspProps } from "@oh-my-pi/pi-wire";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const cx = { cols: 120, reduceMotion: true, dark: true, supports: () => true, feature: () => true };
const cleanup: Array<() => Promise<void>> = [];

beforeAll(async () => {
	if (getCurrentThemeName() === undefined) await initTheme(false);
});
afterEach(async () => {
	for (const dispose of cleanup.splice(0)) await dispose();
});

function fixture() {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	const next = getBundledModel("anthropic", "claude-sonnet-4-6");
	const locked = getBundledModel("openai", "gpt-4o");
	if (!model || !next || !locked) throw new Error("Models fixture requires bundled chat models");
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("anthropic", "test-key");
	const settings = Settings.isolated({ "compaction.enabled": false });
	settings.setModelRole("default", `${model.provider}/${model.id}`);
	const registry = new ModelRegistry(auth);
	const refresh = spyOn(registry, "refresh").mockResolvedValue(undefined);
	const all = spyOn(registry, "getAll").mockReturnValue([model, next, locked]);
	const available = spyOn(registry, "getAvailable").mockReturnValue([model, next]);
	const session = new AgentSession({
		agent: new Agent({
			convertToLlm,
			initialState: { model, messages: [], tools: [], systemPrompt: ["Models viewer fixture"] },
		}),
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: registry,
	});
	const hello: TspHello = {
		r: "hello",
		v: 1,
		term: "acp-model-test",
		cols: 120,
		kinds: TSP_KINDS,
		features: ["viewers", "keys"],
	};
	const transport: TspTransport = {
		hello: Promise.resolve(hello),
		closed: Promise.resolve(),
		columns: 120,
		appearance: undefined,
		write: () => {},
		onInput: () => () => {},
		close: async () => {},
	};
	const host: NativeHost = {
		terminal: transport,
		describeSurface: () => ({ main: [], dock: [] }),
		overlays: () => [],
		focused: () => null,
		focusFromPointer: () => {},
		requestRender: () => {},
		appearanceChanged: () => {},
		motionChanged: () => {},
		invalidate: () => {},
	};
	const backend = new NativeBackend(host, hello);
	backend.start();
	const viewer = new AcpViewerHost(transport, backend, "model-viewer", () => {});
	cleanup.push(async () => {
		viewer.dispose();
		backend.stop();
		await session.dispose();
		refresh.mockRestore();
		all.mockRestore();
		available.mockRestore();
		settings.cancelPendingSaves();
		auth.close();
	});
	openAcpModelScreen(viewer, session, () => viewer.dispose());
	const hub = viewer.focused();
	if (!(hub instanceof ModelHubComponent)) throw new Error("Full Models screen did not mount");
	return { viewer, session, settings, hub, model, next };
}

it("mounts the actual full native Models screen, provider rail, categories, metrics and Assign role", () => {
	const { hub, viewer } = fixture();
	const root = hub.describe(cx);
	expect(root.k).toBe("picker");
	const props = root.p as TspProps<"picker">;
	expect(props.role).toBe("omp.overlay.model-hub");
	expect(props.title).toBe("Models");
	expect(props.scopes?.map(scope => scope.id)).toContain("roles");
	expect(props.scopes?.map(scope => scope.id)).toContain("all");
	expect(props.scopes?.map(scope => scope.id)).toContain("provider:anthropic");
	expect(props.scopes?.map(scope => scope.id)).toContain("provider:openai");
	expect(props.tabs?.map(tab => tab.label)).toEqual(
		expect.arrayContaining(["All", "Chat", "Tiny", "Image", "TTS", "STT", "Search", "Judge", "Embedding"]),
	);
	const described = JSON.stringify(props);
	for (const label of ["Int", "t/s", "Ctx", "$/M", "Recent", "Assign role"]) expect(described).toContain(label);
	hub.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
	expect(viewer.closed).toBe(true);
});

it("persists non-default role assignment through native Assign role without changing the session model", () => {
	const { hub, session, settings, next, model } = fixture();
	hub.handleNativeEvent({ type: "activate", key: "", item: `${next.provider}/${next.id}` });
	const props = hub.describe(cx).p as TspProps<"picker">;
	const chip = props.strip?.items.find(item => item.label === "smol");
	if (!chip) throw new Error("Native Models screen did not offer the smol role");
	hub.handleNativeEvent({ type: "action", key: "", act: "strip", value: chip.id, mods: [] });
	expect(settings.getModelRole("smol")).toBe(`${next.provider}/${next.id}`);
	expect(session.model?.id).toBe(model.id);
});

it("persists default assignment and switches AgentSession with exactly one model_changed event", async () => {
	const { hub, session, settings, next } = fixture();
	let changed = 0;
	const unsubscribe = session.subscribe(event => {
		if (event.type === "model_changed") changed++;
	});
	hub.handleNativeEvent({ type: "activate", key: "", item: `${next.provider}/${next.id}` });
	const props = hub.describe(cx).p as TspProps<"picker">;
	const chip = props.strip?.items.find(item => item.label === "default");
	if (!chip) throw new Error("Native Models screen did not offer the default role");
	hub.handleNativeEvent({ type: "action", key: "", act: "strip", value: chip.id, mods: [] });
	const release = await acquireModelRoleMutation();
	release();
	expect(settings.getModelRole("default")).toBe(`${next.provider}/${next.id}:high`);
	expect(session.model?.id).toBe(next.id);
	expect(changed).toBe(1);
	unsubscribe();
});

for (const departure of ["viewer", "session"] as const) {
	it(`refuses a default assignment queued behind a mutation lock after ${departure} departure`, async () => {
		const { hub, viewer, session, settings, next, model } = fixture();
		const release = await acquireModelRoleMutation();
		try {
			hub.handleNativeEvent({ type: "activate", key: "", item: `${next.provider}/${next.id}` });
			const props = hub.describe(cx).p as TspProps<"picker">;
			const chip = props.strip?.items.find(item => item.label === "default");
			if (!chip) throw new Error("Native Models screen did not offer the default role");
			hub.handleNativeEvent({ type: "action", key: "", act: "strip", value: chip.id, mods: [] });
			if (departure === "viewer") viewer.dispose();
			else await session.sessionManager.newSession();
		} finally {
			release();
		}
		const releaseNext = await acquireModelRoleMutation();
		releaseNext();
		expect(settings.getModelRole("default")).toBe(`${model.provider}/${model.id}`);
		expect(session.model?.id).toBe(model.id);
	});
}

it("preserves native Escape dismissal", () => {
	const { hub, viewer } = fixture();
	hub.handleInput("\x1b");
	expect(viewer.closed).toBe(true);
});
