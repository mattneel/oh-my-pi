import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { HotkeysSheetComponent } from "@oh-my-pi/pi-tui/hotkeys-markdown";
import { JobsSheet } from "@oh-my-pi/pi-tui/overlays/jobs-panel";
import { ReportPanel } from "@oh-my-pi/pi-tui/overlays/report-panel";
import { SessionInfoOverlay } from "@oh-my-pi/pi-tui/overlays/session-info-overlay";
import { buildToolsMarkdown } from "@oh-my-pi/pi-tui/prompt/tools-markdown";
import { getMarkdownTheme } from "@oh-my-pi/pi-tui/theme";
import { memoryStatsUnavailableMessage, resolveMemoryBackend } from "../../memory-backend";
import type { AgentSession } from "../../session/agent-session";
import { parseChangelogView } from "../../utils/changelog";
import {
	buildAdvisorStatusReport,
	buildChangelogReport,
	buildJobsReport,
	buildSessionInfo,
} from "../controllers/command-controller";
import type { AcpViewerHost } from "./acp-viewer-host";

export type AcpReportScreenOpener = (
	viewer: AcpViewerHost,
	session: AgentSession,
	onClose: () => void,
	args: string,
) => void | Promise<void>;

function requireReportArgs(command: string, args: string, allowed: readonly string[]): void {
	if (!allowed.includes(args.trim())) {
		throw new Error(`Unsupported /${command} invocation in an ACP viewer: /${command} ${args.trim()}`);
	}
}

/** The ordinary tool reference, including mounted xdev tool definitions. */
export function openAcpTools(viewer: AcpViewerHost, session: AgentSession, onClose: () => void, args = ""): void {
	requireReportArgs("tools", args, [""]);
	if (viewer.closed) return;
	viewer.mount(
		new ReportPanel({
			title: "Available Tools",
			body: new Markdown(
				buildToolsMarkdown({
					tools: session.agent.state.tools,
					xdevTools: session.getXdevToolEntries(),
				}).trim(),
				0,
				0,
				getMarkdownTheme(),
			),
			closeKey: "escape",
			onClose,
		}),
	);
}

/** Native keycaps and the effective profile's real application bindings. */
export function openAcpHotkeys(viewer: AcpViewerHost, session: AgentSession, onClose: () => void, args = ""): void {
	requireReportArgs("hotkeys", args, [""]);
	if (viewer.closed) return;
	viewer.mount(
		new HotkeysSheetComponent({ keybindings: KeybindingsManager.create(session.settings.getAgentDir()) }, onClose),
	);
}

/** Native session identity, provider, message/token/cost statistics and context meter. */
export function openAcpSessionInfo(viewer: AcpViewerHost, session: AgentSession, onClose: () => void, args = ""): void {
	requireReportArgs("session", args, ["", "info"]);
	if (viewer.closed) return;
	viewer.mount(
		new SessionInfoOverlay(
			// Only the text fallback consumes rows; native sheets own their viewport and scrolling.
			{ terminal: { rows: 24 } },
			buildSessionInfo(session),
			onClose,
			session.getContextUsage(),
		),
	);
}

/** Read-only JobsSheet with viewer-owned polling; no cancel action is installed. */
class AcpJobsSheet extends JobsSheet {
	readonly #signal: AbortSignal;
	readonly #onAbort: () => void;
	readonly #timer: ReturnType<typeof setInterval>;

	constructor(viewer: AcpViewerHost, session: AgentSession, onClose: () => void) {
		let close = onClose;
		super({
			load: () => session.getAsyncJobTree() ?? { running: [], recent: [] },
			inspect: id => session.inspectAsyncJob(id),
			close: () => close(),
		});
		close = () => {
			this.dispose();
			onClose();
		};
		const sessionId = session.sessionId;
		const conversationId = session.sessionManager.getSessionId();
		this.#signal = viewer.signal;
		this.#onAbort = () => this.dispose();
		this.#timer = setInterval(() => {
			if (viewer.closed) this.dispose();
			else if (session.sessionId !== sessionId || session.sessionManager.getSessionId() !== conversationId) close();
			else viewer.requestRender();
		}, 250);
		this.#signal.addEventListener("abort", this.#onAbort, { once: true });
	}

	dispose(): void {
		clearInterval(this.#timer);
		this.#signal.removeEventListener("abort", this.#onAbort);
	}
}

/** Native master/detail jobs summary, or the same complete tree report as `/jobs full`. */
export function openAcpJobs(viewer: AcpViewerHost, session: AgentSession, onClose: () => void, args = ""): void {
	requireReportArgs("jobs", args, ["", "full"]);
	if (viewer.closed) return;
	const tree = session.getAsyncJobTree();
	if (!tree) throw new Error("/jobs is unavailable: async background jobs are not configured for this session.");
	if (!args.trim()) {
		viewer.mount(new AcpJobsSheet(viewer, session, onClose));
		return;
	}
	session.requestJobCaptions();
	viewer.mount(
		new ReportPanel({
			title: "Background Jobs",
			body: new Text(buildJobsReport(session.getAsyncJobTree() ?? tree, viewer.terminal.columns, true), 0, 0),
			closeKey: "escape",
			onClose,
		}),
	);
}

/** Shared changelog selection and Markdown report, with no late viewer revival. */
export async function openAcpChangelog(
	viewer: AcpViewerHost,
	session: AgentSession,
	onClose: () => void,
	args = "",
): Promise<void> {
	const view = parseChangelogView(args);
	if ("error" in view) throw new Error(`Unsupported /changelog invocation in an ACP viewer: ${view.error}`);
	if (viewer.closed) return;
	const sessionId = session.sessionId;
	const conversationId = session.sessionManager.getSessionId();
	const report = await buildChangelogReport(view);
	if (viewer.closed || viewer.signal.aborted) return;
	if (session.sessionId !== sessionId || session.sessionManager.getSessionId() !== conversationId) {
		onClose();
		return;
	}
	viewer.mount(
		new ReportPanel({
			title: report.title,
			body: new Markdown(report.markdown.trim(), 0, 0, getMarkdownTheme()),
			closeKey: "escape",
			onClose,
		}),
	);
}

/** Advisor status only: a bare `/advisor` toggles shared policy and is not a screen. */
export function openAcpAdvisorStatus(
	viewer: AcpViewerHost,
	session: AgentSession,
	onClose: () => void,
	args = "",
): void {
	requireReportArgs("advisor", args, ["status"]);
	if (viewer.closed) return;
	const report = buildAdvisorStatusReport(session);
	viewer.mount(
		new ReportPanel({ title: report.title, body: new Text(report.text, 0, 0), closeKey: "escape", onClose }),
	);
}

/** Real backend-produced memory reports; all memory mutations and mental-model commands are refused. */
export async function openAcpMemory(
	viewer: AcpViewerHost,
	session: AgentSession,
	onClose: () => void,
	args = "",
): Promise<void> {
	requireReportArgs("memory", args, ["", "view", "queue", "stats", "diagnose"]);
	if (viewer.closed) return;
	const sessionId = session.sessionId;
	const conversationId = session.sessionManager.getSessionId();
	const cwd = session.sessionManager.getCwd();
	const isCurrent = (): boolean =>
		!viewer.closed &&
		!viewer.signal.aborted &&
		session.sessionId === sessionId &&
		session.sessionManager.getSessionId() === conversationId &&
		session.sessionManager.getCwd() === cwd;
	const backend = await resolveMemoryBackend(session.settings);
	if (!isCurrent()) {
		if (!viewer.closed) onClose();
		return;
	}
	const agentDir = session.settings.getAgentDir();
	const action = args.trim() || "view";
	let title: string;
	let payload: string | undefined;
	if (action === "view") {
		title = "Memory Injection Payload";
		payload = await backend.buildDeveloperInstructions(agentDir, cwd, session.settings, session);
	} else if (action === "queue") {
		title = "Memory Queue";
		payload = await backend.queuePreview?.({ agentDir, cwd, session });
	} else {
		title = action === "stats" ? "Memory Stats" : "Memory Diagnostics";
		const hook = action === "stats" ? backend.stats : backend.diagnose;
		payload = await hook?.(agentDir, cwd, session);
	}
	if (!isCurrent()) {
		if (!viewer.closed) onClose();
		return;
	}
	if (!payload) {
		const reason =
			action === "view"
				? "Memory payload is empty (memory backend off, disabled, or no memory available)."
				: action === "queue"
					? `Memory queue is not available for the ${backend.id} backend.`
					: memoryStatsUnavailableMessage(backend.id, action === "stats" ? "stats" : "diagnose");
		throw new Error(`/memory ${action}: ${reason}`);
	}
	viewer.mount(
		new ReportPanel({
			title,
			body: new Markdown(payload.trim(), 0, 0, getMarkdownTheme()),
			closeKey: "escape",
			onClose,
		}),
	);
}

/** Only complete portable openers are advertised; dispatchers must pass arguments through unchanged. */
export const ACP_REPORT_SCREEN_OPENERS: Readonly<Record<string, AcpReportScreenOpener>> = {
	tools: openAcpTools,
	hotkeys: openAcpHotkeys,
	changelog: openAcpChangelog,
	session: openAcpSessionInfo,
	jobs: openAcpJobs,
	advisor: openAcpAdvisorStatus,
	memory: openAcpMemory,
};
