import { logger, VERSION } from "@oh-my-pi/pi-utils";
import { InteractiveMode } from "../modes/interactive-mode";
import type { AgentSession } from "../session/agent-session";
import type { EventBus } from "../utils/event-bus";
import type { LiveAttachHost } from "./host";
import type { AttachStatusSnapshot } from "./protocol";
import { SwitchableTerminal } from "./terminal";

export async function startRpcAttachView(
	session: AgentSession,
	hostMode: "rpc" | "rpc-ui",
	eventBus: EventBus | undefined,
	onOwnershipChanged: (snapshot: AttachStatusSnapshot, reason: string) => void,
): Promise<{ host: LiveAttachHost; mode: InteractiveMode }> {
	const terminal = new SwitchableTerminal();
	const mode = new InteractiveMode(
		session,
		VERSION,
		undefined,
		() => {},
		undefined,
		undefined,
		eventBus,
		undefined,
		undefined,
		terminal,
	);
	await mode.init({ suppressWelcomeIntro: true, skipExtensionInitialization: true });
	mode.renderInitialMessages({ clearTerminalHistory: true });
	const host = await mode.startLiveAttachHost(hostMode);
	host.setOwnershipListener(onOwnershipChanged);
	void (async () => {
		while (true) {
			const input = await mode.getUserInput();
			if (input.cancelled) continue;
			try {
				if (!mode.markPendingSubmissionStarted(input)) continue;
				if (input.customType) {
					await session.promptCustomMessage(
						{
							customType: input.customType,
							content: input.text,
							display: input.display ?? false,
							attribution: "agent",
						},
						{ streamingBehavior: input.streamingBehavior ?? "followUp" },
					);
				} else {
					await session.prompt(input.text, {
						images: input.images,
						streamingBehavior: input.streamingBehavior ?? "followUp",
					});
				}
			} catch (error) {
				mode.showError(error instanceof Error ? error.message : String(error));
			} finally {
				mode.finishPendingSubmission(input);
			}
		}
	})().catch(error => {
		// `getUserInput` rejects once the attach view is torn down; an escaping rejection here would
		// take down the RPC host, whose own stdin protocol loop is unaffected by it.
		logger.debug("Live attach input loop ended", { error: String(error) });
	});
	return { host, mode };
}
