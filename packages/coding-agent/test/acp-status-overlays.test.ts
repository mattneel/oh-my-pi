import { afterEach, beforeAll, expect, it, spyOn } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { openAcpContext, openAcpUsage } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-status-overlays";
import { AcpViewerHost } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-viewer-host";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as activityClient from "@oh-my-pi/pi-coding-agent/stats/activity-client";
import { NativeBackend, type NativeHost } from "@oh-my-pi/pi-tui/native/backend";
import type { TspHello } from "@oh-my-pi/pi-tui/native/encode";
import type { TspTransport } from "@oh-my-pi/pi-tui/native/transport";
import { ContextViewer } from "@oh-my-pi/pi-tui/overlays/context-viewer";
import { ReportPanel } from "@oh-my-pi/pi-tui/overlays/report-panel";
import { UsageDashboardComponent } from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import { getCurrentThemeName, initTheme } from "@oh-my-pi/pi-tui/theme";
import { TSP_KINDS } from "@oh-my-pi/pi-wire";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const cx = { cols: 100, reduceMotion: true, dark: true, supports: () => true, feature: () => true };
const cleanup: Array<() => Promise<void>> = [];

beforeAll(async () => {
	if (getCurrentThemeName() === undefined) await initTheme(false);
});
afterEach(async () => {
	for (const dispose of cleanup.splice(0)) await dispose();
});

function fixture(contextWindow = 200_000) {
	const activity = spyOn(activityClient, "loadDailyActivity").mockImplementation(async push => push([]));
	const auth = createInMemoryAuthStorage();
	const settings = Settings.isolated({ "compaction.enabled": false });
	const model = createMockModel({ responses: [], contextWindow });
	const session = new AgentSession({
		agent: new Agent({
			convertToLlm,
			streamFn: model.stream,
			initialState: { model, messages: [], tools: [], systemPrompt: ["Context snapshot fixture"] },
		}),
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: new ModelRegistry(auth),
	});
	const hello: TspHello = {
		r: "hello",
		v: 1,
		term: "acp-overlay-test",
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
	const viewer = new AcpViewerHost(transport, backend, "overlay-test", () => {});
	cleanup.push(async () => {
		viewer.dispose();
		backend.stop();
		activity.mockRestore();
		await session.dispose();
		settings.cancelPendingSaves();
		auth.close();
	});
	return { session, viewer };
}

it("mounts the native context explorer with viewer-local focus and closes from Escape", () => {
	const { session, viewer } = fixture();
	openAcpContext(viewer, session, () => viewer.dispose());
	const component = viewer.focused();
	expect(component).toBeInstanceOf(ContextViewer);
	if (!(component instanceof ContextViewer)) throw new Error("Context explorer did not mount");
	expect(component.describe(cx).p?.role).toBe("omp.context");
	component.handleInput("\x1b");
	expect(viewer.closed).toBe(true);
});

it("keeps invalid-context diagnostics in a native report that its Close action disposes", () => {
	const { session, viewer } = fixture(0);
	openAcpContext(viewer, session, () => viewer.dispose());
	const component = viewer.focused();
	expect(component).toBeInstanceOf(ReportPanel);
	if (!(component instanceof ReportPanel)) throw new Error("Context diagnostic did not mount");
	component.handleNativeEvent({ type: "action", key: "close", act: "close", mods: [] });
	expect(viewer.closed).toBe(true);
});

it("opens the real empty usage dashboard and retains its native Escape dismissal", async () => {
	const { session, viewer } = fixture();
	const fetch = spyOn(session, "fetchUsageReports").mockResolvedValue(null);
	await openAcpUsage(viewer, session, () => viewer.dispose());
	const component = viewer.focused();
	expect(component).toBeInstanceOf(UsageDashboardComponent);
	if (!(component instanceof UsageDashboardComponent)) throw new Error("Usage dashboard did not mount");
	component.handleInput("\x1b");
	expect(viewer.closed).toBe(true);
	fetch.mockRestore();
});

it("retains quota rows beyond the overview limit in the actual native usage Details table", async () => {
	const { session, viewer } = fixture();
	const reports: UsageReport[] = [
		{
			provider: "anthropic",
			fetchedAt: Date.now(),
			metadata: { email: "overlay-account@example.test" },
			limits: Array.from({ length: 5 }, (_, index): UsageReport["limits"][number] => ({
				id: `quota-${index}`,
				label: `Distinct quota ${index}`,
				scope: { provider: "anthropic", windowId: `window-${index}` },
				window: { id: `window-${index}`, label: `Window ${index}` },
				amount: { usedFraction: 0.25, unit: "percent" },
				status: "ok",
			})),
		},
	];
	const fetch = spyOn(session, "fetchUsageReports").mockResolvedValue(reports);
	await openAcpUsage(viewer, session, () => viewer.dispose());
	const component = viewer.focused();
	if (!(component instanceof UsageDashboardComponent)) throw new Error("Usage dashboard did not mount");
	component.handleNativeEvent({ type: "select", key: "head/tabs", item: "detail" });
	const detail = JSON.stringify(component.describe(cx));
	expect(detail).toContain("omp.usage.limits");
	expect(detail).toContain("Distinct quota 4");
	expect(detail).toContain("overlay-account@example.test");
	fetch.mockRestore();
});

for (const departure of ["viewer", "session"] as const) {
	it(`does not revive a ${departure} after its usage fetch resolves`, async () => {
		const { session, viewer } = fixture();
		const pending = Promise.withResolvers<UsageReport[] | null>();
		const fetch = spyOn(session, "fetchUsageReports").mockReturnValue(pending.promise);
		const opening = openAcpUsage(viewer, session, () => viewer.dispose());
		if (departure === "viewer") {
			const loading = viewer.focused();
			if (!(loading instanceof ReportPanel)) throw new Error("Usage loading report did not mount");
			loading.handleInput("\x1b");
		} else await session.sessionManager.newSession();
		pending.resolve([]);
		await opening;
		expect(viewer.focused()).toBeNull();
		fetch.mockRestore();
	});
}
