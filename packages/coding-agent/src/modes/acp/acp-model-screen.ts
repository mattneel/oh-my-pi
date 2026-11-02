import { ModelHubComponent } from "@oh-my-pi/pi-tui/overlays/model-hub";
import type { AgentSession } from "../../session/agent-session";
import { createModelBrowserSource } from "../model-browser-source";
import { createModelHubCallbacks } from "../model-hub-runtime";
import { openAcpProviderLogin } from "./acp-auth-screen";
import type { AcpViewerHost } from "./acp-viewer-host";

/** Mount the same full Models screen as /model, without adopting the shared transcript. */
export function openAcpModelScreen(
	viewer: AcpViewerHost,
	session: AgentSession,
	onClose: () => void,
	args?: string,
): void {
	const sessionId = session.sessionManager.getSessionId();
	let closed = false;
	const isCurrent = () =>
		!closed && !viewer.closed && !session.isDisposed && session.sessionManager.getSessionId() === sessionId;
	const notice = (message: string) => {
		if (isCurrent()) viewer.notice(message);
	};
	const dispose = () => {
		if (closed) return;
		closed = true;
		viewer.signal.removeEventListener("abort", dispose);
		hub.dispose();
	};
	const done = () => {
		if (closed) return;
		dispose();
		onClose();
	};
	const hub = new ModelHubComponent(
		viewer,
		createModelBrowserSource(session.settings, model => session.effectiveServiceTier(model)),
		session.modelRegistry,
		session.scopedModels,
		createModelHubCallbacks({
			session,
			isCurrent,
			refresh: () => hub.refreshAfterExternalMutation(),
			// AgentSession emits model_changed; the ACP owner sends the one config update.
			modelChanged: () => viewer.requestRender(),
			compactionChanged: () => viewer.requestRender(),
			showStatus: notice,
			showWarning: notice,
			showError: notice,
			onLoginRequest: providerId => {
				openAcpProviderLogin(viewer, session, providerId, success => {
					if (success && isCurrent()) hub.refreshAfterExternalMutation();
				});
			},
			onCancel: done,
		}),
		{
			initialProviderId: args?.trim() || undefined,
			currentSelector: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
		},
	);
	if (!isCurrent()) {
		dispose();
		return;
	}
	viewer.signal.addEventListener("abort", dispose, { once: true });
	viewer.mount(hub);
}
