import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "../../slash-commands/builtin-registry";
import type { AgentSession } from "../../session/agent-session";
import { openAcpLogin, openAcpLogout } from "./acp-auth-screen";
import { openAcpAgentsScreen, openAcpSettingsScreen } from "./acp-config-screens";
import { openAcpModelScreen } from "./acp-model-screen";
import { ACP_REPORT_SCREEN_OPENERS } from "./acp-report-screens";
import type { AcpViewerHost } from "./acp-viewer-host";

export type AcpDockAction = "model" | "effort" | "agents" | "status.context" | "status.cost" | "status.git";

export interface AcpScreenCommandContext {
	readonly viewer: AcpViewerHost;
	readonly session: AgentSession;
	readonly onClose: () => void;
	openDockAction(action: AcpDockAction, args?: string): void;
}

type ScreenOpener = (context: AcpScreenCommandContext, args: string) => void | Promise<void>;

function requireBare(name: string, args: string): void {
	if (args.trim()) throw new Error(`Screen command ${JSON.stringify(name)} does not support arguments`);
}

const openers: Readonly<Record<string, ScreenOpener>> = {
	...Object.fromEntries(
		Object.entries(ACP_REPORT_SCREEN_OPENERS).map(([name, open]) => [
			name,
			(context: AcpScreenCommandContext, args: string) =>
				open(context.viewer, context.session, context.onClose, args),
		]),
	),
	model: ({ viewer, session, onClose }, args) => {
		requireBare("model", args);
		openAcpModelScreen(viewer, session, onClose);
	},
	context: (context, args) => {
		requireBare("context", args);
		context.openDockAction("status.context");
	},
	usage: (context, args) => {
		if (args.trim() && args.trim() !== "show") throw new Error('Screen command "usage" supports only its report');
		context.openDockAction("status.cost");
	},
	agents: ({ viewer, session, onClose }, args) => openAcpAgentsScreen(viewer, session, onClose, args),
	git: (context, args) => context.openDockAction("status.git", args),
	hub: (context, args) => {
		requireBare("hub", args);
		context.openDockAction("agents");
	},
	switch: (context, args) => {
		requireBare("switch", args);
		context.openDockAction("model");
	},
	effort: (context, args) => {
		requireBare("effort", args);
		if (!context.session.model?.reasoning) throw new Error('Screen command "effort" requires a reasoning model');
		context.openDockAction("effort");
	},
	settings: ({ viewer, session, onClose }, args) => openAcpSettingsScreen(viewer, session, onClose, args),
	login: ({ viewer, session, onClose }, args) => openAcpLogin(viewer, session, onClose, args),
	logout: ({ viewer, session, onClose }, args) => openAcpLogout(viewer, session, onClose, args),
};

const commands = new Map<string, ScreenOpener>();
for (const command of BUILTIN_SLASH_COMMANDS_INTERNAL) {
	const open = openers[command.name];
	if (!open) continue;
	commands.set(command.name, open);
	for (const alias of command.aliases ?? []) commands.set(alias, open);
}

/** The same registry governs both advertised capabilities and viewer dispatch. */
export const ACP_SCREEN_COMMAND_NAMES: ReadonlySet<string> = new Set(commands.keys());

export function getAcpScreenCommand(name: string): ScreenOpener | undefined {
	return commands.get(name);
}
