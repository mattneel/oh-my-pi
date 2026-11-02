import { afterEach, beforeAll, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { openAcpAgentsScreen, openAcpSettingsScreen } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-config-screens";
import { AcpViewerHost } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-viewer-host";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgTaskDisabledAgents } from "@oh-my-pi/pi-coding-agent/task/settings";
import { NativeBackend, type NativeHost } from "@oh-my-pi/pi-tui/native/backend";
import type { TspHello } from "@oh-my-pi/pi-tui/native/encode";
import type { TspTransport } from "@oh-my-pi/pi-tui/native/transport";
import { AgentsHubComponent } from "@oh-my-pi/pi-tui/overlays/agents-hub";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { getCurrentThemeName, getThemeEpoch, initTheme, previewTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { TSP_KINDS, type TspPickerProps } from "@oh-my-pi/pi-wire";
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
	const dir = TempDir.createSync("@pi-acp-config-");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Configuration fixture requires a reasoning model");
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("anthropic", "test-key");
	const settings = Settings.isolated({ "compaction.enabled": false });
	cfgDefaultThinkingLevel.set(settings, ThinkingLevel.Low);
	const registry = new ModelRegistry(auth);
	const refresh = spyOn(registry, "refresh").mockResolvedValue(undefined);
	const available = spyOn(registry, "getAvailable").mockReturnValue([model]);
	const session = new AgentSession({
		agent: new Agent({
			convertToLlm,
			initialState: {
				model,
				thinkingLevel: ThinkingLevel.Low,
				messages: [],
				tools: [],
				systemPrompt: ["Configuration viewer fixture"],
			},
		}),
		sessionManager: SessionManager.inMemory(dir.path()),
		settings,
		modelRegistry: registry,
	});
	const hello: TspHello = {
		r: "hello",
		v: 1,
		term: "acp-config-test",
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
	const viewer = new AcpViewerHost(transport, backend, "config-viewer", () => {});
	cleanup.push(async () => {
		viewer.dispose();
		backend.stop();
		await session.dispose();
		refresh.mockRestore();
		available.mockRestore();
		settings.cancelPendingSaves();
		auth.close();
		dir.removeSync();
	});
	return { viewer, session, settings, dir };
}

it("binds the settings host to the supplied store without cross-writing another store", () => {
	const left = Settings.isolated();
	const right = Settings.isolated();
	try {
		const host = createSettingsHost(left);
		host.set("temperature", 0.2);
		createSettingsHost(right).set("temperature", 0.4);
		expect(host.get("temperature")).toBe(0.2);
		host.set("temperature", 0.7);
		expect(host.get("temperature")).toBe(0.7);
		expect(createSettingsHost(right).get("temperature")).toBe(0.4);
		host.unset("temperature");
		expect(host.get("temperature")).toBe(-1);
	} finally {
		left.cancelPendingSaves();
		right.cancelPendingSaves();
	}
});

it("mounts native settings and applies effort through AgentSession exactly once", async () => {
	const { viewer, session, settings } = fixture();
	await openAcpSettingsScreen(viewer, session, () => viewer.dispose());
	const selector = viewer.focused();
	if (!(selector instanceof SettingsSelectorComponent)) throw new Error("Settings root did not mount");
	expect(selector.describe(cx).k).toBe("prefs");
	const setThinkingLevel = spyOn(session, "setThinkingLevel");
	try {
		selector.handleNativeEvent({ type: "action", key: "", act: "page", value: "model", mods: [] });
		selector.handleNativeEvent({ type: "change", key: "", item: "defaultThinkingLevel", value: ThinkingLevel.High });
		expect(cfgDefaultThinkingLevel.get(settings)).toBe(ThinkingLevel.High);
		expect(session.configuredThinkingLevel()).toBe(ThinkingLevel.High);
		expect(setThinkingLevel).toHaveBeenCalledTimes(1);
		selector.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
		expect(viewer.closed).toBe(true);
		selector.handleNativeEvent({ type: "change", key: "", item: "defaultThinkingLevel", value: "low" });
		expect(setThinkingLevel).toHaveBeenCalledTimes(1);
	} finally {
		setThinkingLevel.mockRestore();
	}
});

it("mounts actual agent configuration with real entry-level enablement policy and native Escape", async () => {
	const { viewer, session, settings, dir } = fixture();
	fs.mkdirSync(dir.join(".omp", "agents"), { recursive: true });
	await Bun.write(
		dir.join(".omp", "agents", "config-test.md"),
		"---\nname: config-test\ndescription: Configuration viewer test agent\n---\n\nInspect configuration.\n",
	);
	await openAcpAgentsScreen(viewer, session, () => viewer.dispose());
	const hub = viewer.focused();
	if (!(hub instanceof AgentsHubComponent)) throw new Error("Agents configuration root did not mount");
	const props = hub.describe(cx).p as TspPickerProps;
	expect(props.title).toBe("Agents");
	expect(props.items?.some(item => item.id === "agent:project:config-test")).toBe(true);
	hub.handleNativeEvent({ type: "select", key: "", item: "agent:project:config-test" });
	hub.handleNativeEvent({ type: "action", key: "", act: "toggle", mods: [] });
	expect(cfgTaskDisabledAgents.get(settings)).toContain("config-test");
	hub.handleInput("\x1b");
	expect(viewer.closed).toBe(true);
	hub.handleNativeEvent({ type: "action", key: "", act: "toggle", mods: [] });
	expect(cfgTaskDisabledAgents.get(settings)).toContain("config-test");
});

it("does not mount an asynchronously created settings page after viewer departure", async () => {
	const { viewer, session } = fixture();
	const opening = openAcpSettingsScreen(viewer, session, () => viewer.dispose());
	viewer.dispose();
	await opening;
	expect(viewer.focused()).toBeNull();
});

it("cancels an in-flight theme preview before assigning the process theme", async () => {
	const controller = new AbortController();
	const epoch = getThemeEpoch();
	const preview = previewTheme("dark", undefined, controller.signal);
	controller.abort();
	expect((await preview).success).toBe(false);
	expect(getThemeEpoch()).toBe(epoch);
});

it("refuses argument forms rather than performing lifecycle mutations", async () => {
	const { viewer, session } = fixture();
	await expect(openAcpSettingsScreen(viewer, session, () => viewer.dispose(), "reset")).rejects.toThrow("/settings");
	await expect(openAcpAgentsScreen(viewer, session, () => viewer.dispose(), "focus task")).rejects.toThrow("/agents");
	expect(viewer.focused()).toBeNull();
});
