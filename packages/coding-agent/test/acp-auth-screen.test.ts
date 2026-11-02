import { afterEach, beforeAll, expect, it, spyOn } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { openAcpLogin, openAcpLogout, openAcpProviderLogin } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-auth-screen";
import { AcpViewerHost } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-viewer-host";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as openModule from "@oh-my-pi/pi-coding-agent/utils/open";
import { NativeBackend, type NativeHost } from "@oh-my-pi/pi-tui/native/backend";
import type { TspHello } from "@oh-my-pi/pi-tui/native/encode";
import type { TspTransport } from "@oh-my-pi/pi-tui/native/transport";
import { LoginDialogComponent } from "@oh-my-pi/pi-tui/overlays/login-dialog";
import { LogoutAccountSelectorComponent } from "@oh-my-pi/pi-tui/overlays/logout-account-selector";
import { OAuthSelectorComponent } from "@oh-my-pi/pi-tui/overlays/oauth-selector";
import { ReportPanel } from "@oh-my-pi/pi-tui/overlays/report-panel";
import { getCurrentThemeName, initTheme } from "@oh-my-pi/pi-tui/theme";
import { TSP_KINDS } from "@oh-my-pi/pi-wire";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const cleanup: Array<() => void | Promise<void>> = [];
beforeAll(async () => {
	if (getCurrentThemeName() === undefined) await initTheme(false);
});
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function fixture() {
	const auth = createInMemoryAuthStorage();
	const settings = Settings.isolated({ "compaction.enabled": false });
	const model = createMockModel({ responses: [] });
	const registry = new ModelRegistry(auth);
	const refresh = spyOn(registry, "refreshProvider").mockResolvedValue(undefined);
	const key = spyOn(registry, "getApiKeyForProvider").mockResolvedValue(undefined);
	const session = new AgentSession({
		agent: new Agent({ convertToLlm, streamFn: model.stream, initialState: { model, messages: [], tools: [] } }),
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: registry,
	});
	const hello: TspHello = {
		r: "hello",
		v: 1,
		term: "auth-test",
		cols: 100,
		kinds: TSP_KINDS,
		features: ["viewers", "keys"],
	};
	const transport: TspTransport = {
		hello: Promise.resolve(hello),
		closed: Promise.resolve(),
		columns: 100,
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
	const viewer = new AcpViewerHost(transport, backend, "auth-viewer", () => {});
	cleanup.push(async () => {
		viewer.dispose();
		backend.stop();
		await session.dispose();
		refresh.mockRestore();
		key.mockRestore();
		settings.cancelPendingSaves();
		auth.close();
	});
	return { auth, session, viewer, refresh };
}

it("mounts the actual provider picker and closes through its native Close action", () => {
	const { viewer, session } = fixture();
	openAcpLogin(viewer, session, () => viewer.dispose());
	const selector = viewer.focused();
	if (!(selector instanceof OAuthSelectorComponent)) throw new Error("Provider picker was not mounted");
	selector.handleNativeEvent({ type: "action", key: "picker", act: "close", mods: [] });
	expect(viewer.closed).toBe(true);
});

it("rejects unsupported argument forms before opening a viewer page", async () => {
	const { viewer, session } = fixture();
	expect(() => openAcpLogin(viewer, session, () => {}, "openai-codex extra")).toThrow("/login");
	await expect(openAcpLogout(viewer, session, () => {}, "--all")).rejects.toThrow("/logout");
	expect(viewer.focused()).toBeNull();
});

it("runs the real dialog's URL and manual-answer callbacks and refreshes only the signed-in provider", async () => {
	const { viewer, session, auth, refresh } = fixture();
	openAcpLogin(viewer, session, () => viewer.dispose());
	const previous = viewer.focused();
	const opened = spyOn(openModule, "openPath").mockImplementation(() => {});
	const done = Promise.withResolvers<boolean>();
	let answer: string | undefined;
	const login = spyOn(auth.oauth, "login").mockImplementation(async (_provider, ctrl) => {
		ctrl.onAuth({ url: "https://example.test/authorize?state=complete" });
		answer = await ctrl.onPrompt({ message: "Paste the authorization code:" });
		return { type: "oauth", email: "person@example.test" };
	});
	cleanup.push(() => {
		opened.mockRestore();
		login.mockRestore();
	});
	openAcpProviderLogin(viewer, session, "openai-codex", done.resolve);
	const dialog = viewer.focused();
	if (!(dialog instanceof LoginDialogComponent)) throw new Error("Login dialog was not shown as an overlay");
	expect(viewer.describeSurface().main).toEqual([dialog]);
	expect(opened).toHaveBeenCalledWith("https://example.test/authorize?state=complete");
	dialog.pasteText("authorization-code");
	dialog.handleNativeEvent({ type: "action", key: "submit", act: "submit", mods: [] });
	expect(await done.promise).toBe(true);
	expect(answer).toBe("authorization-code");
	expect(refresh).toHaveBeenCalledWith("openai-codex", "online");
	expect(viewer.focused()).toBe(previous);
});

it("cancels pending prompts on native Cancel and restores the previous page once", async () => {
	const { viewer, session, auth, refresh } = fixture();
	openAcpLogin(viewer, session, () => viewer.dispose());
	const previous = viewer.focused();
	let calls = 0;
	const login = spyOn(auth.oauth, "login").mockImplementation(async (_provider, ctrl) => {
		await ctrl.onPrompt({ message: "Code:" });
		return { type: "oauth" };
	});
	cleanup.push(() => login.mockRestore());
	openAcpProviderLogin(viewer, session, "openai-codex", success => {
		expect(success).toBe(false);
		calls++;
	});
	const dialog = viewer.focused();
	if (!(dialog instanceof LoginDialogComponent)) throw new Error("Login dialog was not mounted");
	dialog.handleNativeEvent({ type: "action", key: "cancel", act: "cancel", mods: [] });
	await expect(login.mock.results[0]?.value).rejects.toThrow("closed");
	expect(dialog.signal.aborted).toBe(true);
	expect(viewer.focused()).toBe(previous);
	expect(calls).toBe(1);
	expect(refresh).not.toHaveBeenCalled();
});

it("viewer disposal rejects pending manual input without reporting success or reviving focus", async () => {
	const { viewer, session, auth, refresh } = fixture();
	let done = false;
	const login = spyOn(auth.oauth, "login").mockImplementation(async (_provider, ctrl) => {
		await ctrl.onPrompt({ message: "Code:" });
		return { type: "oauth" };
	});
	cleanup.push(() => login.mockRestore());
	openAcpProviderLogin(viewer, session, "openai-codex", () => {
		done = true;
	});
	const dialog = viewer.focused();
	if (!(dialog instanceof LoginDialogComponent)) throw new Error("Login dialog was not mounted");
	viewer.dispose();
	await expect(login.mock.results[0]?.value).rejects.toThrow("closed");
	expect(dialog.signal.aborted).toBe(true);
	expect(viewer.focused()).toBeNull();
	expect(done).toBe(false);
	expect(refresh).not.toHaveBeenCalled();
});

it("does not announce success when a login stores no credential", async () => {
	const { viewer, session, auth, refresh } = fixture();
	const login = spyOn(auth.oauth, "login").mockResolvedValue(undefined);
	cleanup.push(() => login.mockRestore());
	const done = Promise.withResolvers<boolean>();
	openAcpProviderLogin(viewer, session, "openai-codex", done.resolve);
	expect(await done.promise).toBe(false);
	expect(refresh).not.toHaveBeenCalled();
});

it("removes exactly the selected stored credential through the native logout account picker", async () => {
	const { viewer, session, auth, refresh } = fixture();
	for (const email of ["a@example.test", "b@example.test"]) {
		await auth.credentials.upsert("anthropic", {
			type: "oauth",
			access: `access-${email}`,
			refresh: `refresh-${email}`,
			expires: Date.now() + 3_600_000,
			email,
		});
	}
	await openAcpLogout(viewer, session, () => viewer.dispose(), "anthropic");
	const selector = viewer.focused();
	if (!(selector instanceof LogoutAccountSelectorComponent)) throw new Error("Stored-account picker was not mounted");
	const completed = Promise.withResolvers<void>();
	const mount = viewer.mount.bind(viewer);
	const mounted = spyOn(viewer, "mount").mockImplementation(component => {
		mount(component);
		if (component instanceof ReportPanel && auth.credentials.list("anthropic").length === 1) completed.resolve();
	});
	cleanup.push(() => mounted.mockRestore());
	const selected = auth.credentials
		.list("anthropic")
		.find(row => row.credential.type === "oauth" && row.credential.email === "a@example.test");
	if (!selected) throw new Error("Expected stored account was not found");
	selector.handleNativeEvent({ type: "select", key: "picker", item: String(selected.id) });
	selector.handleNativeEvent({ type: "action", key: "picker", act: "confirm", mods: [] });
	await completed.promise;
	const remaining = auth.credentials.list("anthropic");
	expect(remaining).toHaveLength(1);
	expect(remaining[0]?.credential).toMatchObject({ type: "oauth", email: "b@example.test" });
	expect(refresh).toHaveBeenCalledWith("anthropic", "online");
	expect(viewer.focused()).toBeInstanceOf(ReportPanel);
});

it("disposing a standalone dialog rejects pending input without invoking completion", async () => {
	let completed = false;
	const dialog = new LoginDialogComponent(
		{ requestRender: () => {} },
		"openai-codex",
		() => {
			completed = true;
		},
		() => {},
	);
	const pending = dialog.showManualInput("Code:");
	dialog.dispose();
	await expect(pending).rejects.toThrow("closed");
	await expect(dialog.showPrompt({ message: "late prompt" })).rejects.toThrow("closed");
	expect(completed).toBe(false);
});
