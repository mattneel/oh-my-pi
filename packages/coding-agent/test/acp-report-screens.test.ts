import { afterEach, beforeAll, expect, it, mock, spyOn, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as memoryBackend from "@oh-my-pi/pi-coding-agent/memory-backend";
import {
	ACP_REPORT_SCREEN_OPENERS,
	openAcpAdvisorStatus,
	openAcpChangelog,
	openAcpHotkeys,
	openAcpJobs,
	openAcpMemory,
	openAcpSessionInfo,
	openAcpTools,
} from "@oh-my-pi/pi-coding-agent/modes/acp/acp-report-screens";
import { AcpViewerHost } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-viewer-host";
import { buildJobsReport, buildSessionInfo } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AsyncJobTree } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as changelog from "@oh-my-pi/pi-coding-agent/utils/changelog";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { HotkeysSheetComponent } from "@oh-my-pi/pi-tui/hotkeys-markdown";
import { NativeBackend, type NativeHost } from "@oh-my-pi/pi-tui/native/backend";
import type { TspHello } from "@oh-my-pi/pi-tui/native/encode";
import type { TspTransport } from "@oh-my-pi/pi-tui/native/transport";
import { JobsSheet } from "@oh-my-pi/pi-tui/overlays/jobs-panel";
import { ReportPanel } from "@oh-my-pi/pi-tui/overlays/report-panel";
import { SessionInfoOverlay } from "@oh-my-pi/pi-tui/overlays/session-info-overlay";
import { getCurrentThemeName, initTheme } from "@oh-my-pi/pi-tui/theme";
import { TSP_KINDS } from "@oh-my-pi/pi-wire";
import { activateTodoTool, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const cx = { cols: 100, reduceMotion: true, dark: true, supports: () => true, feature: () => true };
const cleanup: Array<() => unknown> = [];

beforeAll(async () => {
	if (getCurrentThemeName() === undefined) await initTheme(false);
});
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function fixture() {
	const auth = createInMemoryAuthStorage();
	const settings = Settings.isolated({ "compaction.enabled": false, "memory.backend": "off" });
	const model = createMockModel({ responses: [], contextWindow: 200_000 });
	const session = new AgentSession({
		agent: new Agent({
			convertToLlm,
			streamFn: model.stream,
			initialState: { model, messages: [], tools: [], systemPrompt: ["Portable report fixture"] },
		}),
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: new ModelRegistry(auth),
	});
	const hello: TspHello = {
		r: "hello",
		v: 1,
		term: "acp-report-test",
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
	const requestRender = mock(() => {});
	const viewer = new AcpViewerHost(transport, backend, "report-test", requestRender);
	cleanup.push(async () => {
		viewer.dispose();
		backend.stop();
		await session.dispose();
		settings.cancelPendingSaves();
		auth.close();
	});
	return { viewer, session, requestRender };
}

function reportBody(viewer: AcpViewerHost) {
	const report = viewer.focused();
	if (!(report instanceof ReportPanel)) throw new Error("Native report did not mount");
	const body = report.describe().c?.[0];
	if (!body || !("k" in body)) throw new Error("Native report body was missing");
	return { report, body: body.c?.[0] };
}

it("advertises only implemented portable report names", () => {
	expect(Object.keys(ACP_REPORT_SCREEN_OPENERS).sort()).toEqual([
		"advisor",
		"changelog",
		"hotkeys",
		"jobs",
		"memory",
		"session",
		"tools",
	]);
});

it("uses the actual Markdown tool report with active and mounted tools and a working native Close", () => {
	const { viewer, session } = fixture();
	activateTodoTool(session, session.sessionManager.getCwd());
	const mounted = spyOn(session, "getXdevToolEntries").mockReturnValue([
		{ name: "mounted-report-tool", summary: "Mounted tool detail" },
	]);
	cleanup.push(() => mounted.mockRestore());
	openAcpTools(viewer, session, () => viewer.dispose());
	const { report, body } = reportBody(viewer);
	expect(body).toBeInstanceOf(Markdown);
	const text = report.render(100).join("\n");
	expect(text).toContain("todo");
	expect(text).toContain("xd://mounted-report-tool");
	expect(text).toContain("Mounted tool detail");
	report.handleNativeEvent({ type: "action", key: "close", act: "close", mods: [] });
	expect(viewer.closed).toBe(true);
});

it("uses the native keycap sheet with the profile's effective bindings and Escape", () => {
	const { viewer, session } = fixture();
	const create = spyOn(KeybindingsManager, "create").mockReturnValue(
		KeybindingsManager.inMemory({ "app.model.select": "ctrl+q" }),
	);
	cleanup.push(() => create.mockRestore());
	openAcpHotkeys(viewer, session, () => viewer.dispose());
	const component = viewer.focused();
	if (!(component instanceof HotkeysSheetComponent)) throw new Error("Native hotkeys sheet did not mount");
	expect(create).toHaveBeenCalledWith(session.settings.getAgentDir());
	const described = JSON.stringify(component.describe());
	expect(described).toContain("omp.hotkeys.table");
	expect(described).toContain("ctrl+q");
	component.handleInput("\x1b");
	expect(viewer.closed).toBe(true);
});

it("routes session info through the shared complete builder and dedicated identity overlay", () => {
	const { viewer, session } = fixture();
	const info = buildSessionInfo(session);
	expect(info).toContain(session.sessionId);
	expect(info).toContain("Append-Only:");
	expect(info).toContain("Tool Calls:");
	openAcpSessionInfo(viewer, session, () => viewer.dispose(), "info");
	const component = viewer.focused();
	if (!(component instanceof SessionInfoOverlay)) throw new Error("Native session overlay did not mount");
	const described = JSON.stringify(component.describe(cx));
	expect(described).toContain(session.sessionId);
	expect(described).toContain("omp.info");
	component.handleInput("\x1b");
	expect(viewer.closed).toBe(true);
});

const jobTree: AsyncJobTree = {
	rootId: "root",
	agents: [],
	recent: [],
	running: [
		{
			id: "job-1",
			type: "bash",
			status: "running",
			label: "printf report-job",
			command: "printf report-job",
			startTime: 1,
			ownerId: "root",
		},
	],
};

it("opens the live native jobs master/detail without any cancel action and disposes polling", () => {
	const { viewer, session, requestRender } = fixture();
	vi.useFakeTimers();
	cleanup.push(() => vi.useRealTimers());
	const tree = spyOn(session, "getAsyncJobTree").mockReturnValue(jobTree);
	const inspect = spyOn(session, "inspectAsyncJob").mockReturnValue({
		command: "printf report-job",
		pids: [123],
		output: "Live job output",
	});
	const cancel = spyOn(session, "cancelAsyncJob");
	cleanup.push(() => {
		tree.mockRestore();
		inspect.mockRestore();
		cancel.mockRestore();
	});
	openAcpJobs(viewer, session, () => viewer.dispose());
	const component = viewer.focused();
	if (!(component instanceof JobsSheet)) throw new Error("Native jobs sheet did not mount");
	const described = JSON.stringify(component.describe(cx));
	expect(described).toContain("omp.jobs.split");
	expect(described).toContain("Live job output");
	expect(described).not.toContain("Cancel job");
	component.handleInput("x");
	expect(cancel).not.toHaveBeenCalled();
	component.handleNativeEvent({ type: "action", key: "close", act: "close", mods: [] });
	expect(viewer.closed).toBe(true);
	const renders = requestRender.mock.calls.length;
	vi.advanceTimersByTime(300);
	expect(requestRender.mock.calls.length).toBe(renders);
});

it("uses the shared complete job report for full, not a lossy flat summary", () => {
	const { viewer, session } = fixture();
	const tree = spyOn(session, "getAsyncJobTree").mockReturnValue(jobTree);
	const captions = spyOn(session, "requestJobCaptions").mockImplementation(() => {});
	cleanup.push(() => {
		tree.mockRestore();
		captions.mockRestore();
	});
	openAcpJobs(viewer, session, () => viewer.dispose(), "full");
	const { report, body } = reportBody(viewer);
	expect(body).toBeInstanceOf(Text);
	expect(captions).toHaveBeenCalledTimes(1);
	expect(report.render(100).join("\n")).toContain("printf report-job");
	expect(buildJobsReport(jobTree, 100, true)).toContain("printf report-job");
	report.handleInput("\x1b");
	expect(viewer.closed).toBe(true);
});

it("opens advisor status without toggling shared advisor policy", () => {
	const { viewer, session } = fixture();
	openAcpAdvisorStatus(viewer, session, () => viewer.dispose(), "status");
	const { report, body } = reportBody(viewer);
	expect(body).toBeInstanceOf(Text);
	expect(report.render(100).join("\n")).toContain("Advisor is disabled.");
	report.handleInput("\x1b");
	expect(viewer.closed).toBe(true);
});

it("keeps changelog selection and content in the shared builder and real Markdown report", async () => {
	const { viewer, session } = fixture();
	const parse = spyOn(changelog, "parseChangelog").mockResolvedValue([
		{ major: 2, minor: 0, patch: 0, content: "### Added\nNewest report release" },
		{ major: 1, minor: 0, patch: 0, content: "### Added\nOlder report release" },
	]);
	cleanup.push(() => parse.mockRestore());
	await openAcpChangelog(viewer, session, () => viewer.dispose(), "last 1");
	const { report, body } = reportBody(viewer);
	expect(body).toBeInstanceOf(Markdown);
	const rendered = report.render(100).join("\n");
	expect(rendered).toContain("Newest report release");
	expect(rendered).not.toContain("Older report release");
	report.handleInput("\x1b");
	expect(viewer.closed).toBe(true);
});

for (const departure of ["viewer", "session"] as const) {
	it(`does not mount late changelog content after ${departure} departure`, async () => {
		const { viewer, session } = fixture();
		const pending = Promise.withResolvers<changelog.ChangelogEntry[]>();
		const parse = spyOn(changelog, "parseChangelog").mockReturnValue(pending.promise);
		cleanup.push(() => parse.mockRestore());
		const opening = openAcpChangelog(viewer, session, () => viewer.dispose());
		if (departure === "viewer") viewer.dispose();
		else await session.sessionManager.newSession();
		pending.resolve([]);
		await opening;
		expect(viewer.focused()).toBeNull();
	});
}

it("reads the resolved memory backend with the viewed session and renders its real report", async () => {
	const { viewer, session } = fixture();
	const stats = mock(async () => "# Memory statistics\nComplete backend report");
	const resolve = spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue({
		...memoryBackend.offBackend,
		stats,
	});
	cleanup.push(() => resolve.mockRestore());
	await openAcpMemory(viewer, session, () => viewer.dispose(), "stats");
	expect(stats).toHaveBeenCalledWith(session.settings.getAgentDir(), session.sessionManager.getCwd(), session);
	const { report, body } = reportBody(viewer);
	expect(body).toBeInstanceOf(Markdown);
	expect(report.render(100).join("\n")).toContain("Complete backend report");
	report.handleInput("\x1b");
	expect(viewer.closed).toBe(true);
});

it("does not mount a late memory report after its viewer is disposed", async () => {
	const { viewer, session } = fixture();
	const pending = Promise.withResolvers<string>();
	const stats = mock(() => pending.promise);
	const resolve = spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue({
		...memoryBackend.offBackend,
		stats,
	});
	cleanup.push(() => resolve.mockRestore());
	const opening = openAcpMemory(viewer, session, () => viewer.dispose(), "stats");
	await Promise.resolve();
	viewer.dispose();
	pending.resolve("Late memory report");
	await opening;
	expect(viewer.focused()).toBeNull();
});

it("does not claim an empty or unsupported memory backend report opened", async () => {
	const { viewer, session } = fixture();
	const resolve = spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(memoryBackend.offBackend);
	cleanup.push(() => resolve.mockRestore());
	await expect(openAcpMemory(viewer, session, () => viewer.dispose(), "stats")).rejects.toThrow("/memory stats:");
	expect(viewer.focused()).toBeNull();
});

for (const [name, args] of [
	["tools", "extra"],
	["hotkeys", "extra"],
	["session", "delete"],
	["session", "pin"],
	["session", "resume"],
	["jobs", "kill job-1"],
	["changelog", "last 0"],
	["advisor", ""],
	["advisor", "configure"],
	["memory", "clear"],
	["memory", "sync"],
	["memory", "mm list"],
	["memory", "stats ignored"],
] as const) {
	it(`refuses /${name} ${args} explicitly without mounting or mutating`, async () => {
		const { viewer, session } = fixture();
		const opener = ACP_REPORT_SCREEN_OPENERS[name];
		if (!opener) throw new Error(`Missing portable report opener: ${name}`);
		await expect(Promise.resolve().then(() => opener(viewer, session, () => viewer.dispose(), args))).rejects.toThrow(
			`/${name}`,
		);
		expect(viewer.focused()).toBeNull();
	});
}
