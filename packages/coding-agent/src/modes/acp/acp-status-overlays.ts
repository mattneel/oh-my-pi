import type { UsageReport } from "@oh-my-pi/pi-ai";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { ReportPanel } from "@oh-my-pi/pi-tui/overlays/report-panel";
import { ContextViewer } from "@oh-my-pi/pi-tui/overlays/context-viewer";
import { UsageDashboardComponent } from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSession } from "../../session/agent-session";
import { computeSessionContextBreakdown } from "../../session/context-usage-runtime";
import { buildSessionContextView } from "../../session/context-view";
import {
	accountIdentityLabel,
	collectStoredAccounts,
	collectUnreportedAccounts,
	selectReportableAccounts,
} from "../../slash-commands/helpers/usage-accounts";
import { loadDailyActivity } from "../../stats/activity-client";
import { renderUsageReports } from "../controllers/command-controller";
import type { AcpViewerHost } from "./acp-viewer-host";

/** The same read-only context snapshot and native explorer as `/context`. */
export function openAcpContext(viewer: AcpViewerHost, session: AgentSession, onClose: () => void): void {
	if (viewer.closed) return;
	const breakdown = session.model ? computeSessionContextBreakdown(session, { snapcompactSavings: true }) : undefined;
	if (!breakdown || !(breakdown.contextWindow > 0) || !Number.isFinite(breakdown.contextWindow)) {
		viewer.mount(
			new ReportPanel({
				title: "Context",
				body: new Text(
					breakdown
						? "Context usage is unavailable: the model's context window is unknown or invalid."
						: "Context usage is unavailable: no model is selected for this session.",
					0,
					0,
				),
				closeKey: "escape",
				onClose,
			}),
		);
		return;
	}
	viewer.mount(
		new ContextViewer(buildSessionContextView(session, breakdown), {
			onClose,
			requestRender: () => viewer.requestRender(),
			// TSP advertises columns, not terminal rows; native lists own their scrolling.
			getRows: () => 24,
		}),
	);
}

/** `/usage`'s full quota dashboard, including account gaps, details and daily activity. */
export async function openAcpUsage(viewer: AcpViewerHost, session: AgentSession, onClose: () => void): Promise<void> {
	const sessionId = session.sessionId;
	const conversationId = session.sessionManager.getSessionId();
	const isCurrent = (): boolean =>
		!viewer.closed && session.sessionId === sessionId && session.sessionManager.getSessionId() === conversationId;
	if (!isCurrent()) return;
	const loading = new ReportPanel({
		title: "Usage",
		body: new Text("Loading usage…", 0, 0),
		closeKey: "escape",
		onClose,
	});
	viewer.mount(loading);
	let reports: UsageReport[] = [];
	try {
		reports = (await session.fetchUsageReports()) ?? [];
	} catch (error) {
		if (isCurrent()) {
			viewer.notice(`Failed to fetch usage data: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	// A departing viewer or a session switch must not be revived by a late fetch.
	if (!isCurrent()) {
		if (!viewer.closed) onClose();
		return;
	}
	const authStorage = session.modelRegistry.authStorage;
	const accounts = selectReportableAccounts(
		collectStoredAccounts(authStorage),
		provider => authStorage.usage.providerFor(provider) !== undefined,
	);
	const unavailableAccounts = collectUnreportedAccounts(reports, accounts).map(account => ({
		provider: account.provider,
		label: accountIdentityLabel(account),
	}));
	const currentProvider = session.model?.provider;
	const activeAccount = currentProvider ? authStorage.oauth.identity(currentProvider, sessionId) : undefined;
	const usageModelSelectors = session.getUsageReportingModelSelectors(reports);
	loading.dispose();
	viewer.mount(
		new UsageDashboardComponent({
			reports,
			unavailableAccounts,
			renderDetail: (width, current) =>
				renderUsageReports(
					current,
					theme,
					Date.now(),
					width,
					provider => (provider === currentProvider ? activeAccount : undefined),
					usageModelSelectors,
					unavailableAccounts,
				),
			loadActivity: (push, signal) =>
				loadDailyActivity(points => {
					if (isCurrent()) push(points);
				}, signal),
			refresh: async () => {
				if (!isCurrent()) return null;
				const current = await session.fetchUsageReports();
				return isCurrent() ? current : null;
			},
			requestRender: () => {
				if (isCurrent()) viewer.requestRender();
			},
			onClose,
		}),
	);
}
