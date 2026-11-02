import { PASTE_CODE_LOGIN_PROVIDERS } from "@oh-my-pi/pi-ai";
import { getOAuthCredentialProvider, getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthProvider } from "@oh-my-pi/pi-ai/oauth/types";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { editorKey } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import { LoginDialogComponent } from "@oh-my-pi/pi-tui/overlays/login-dialog";
import { LogoutAccountSelectorComponent } from "@oh-my-pi/pi-tui/overlays/logout-account-selector";
import { OAuthSelectorComponent } from "@oh-my-pi/pi-tui/overlays/oauth-selector";
import { ReportPanel } from "@oh-my-pi/pi-tui/overlays/report-panel";
import { formatLoginIdentity } from "../../cli/oauth-terminal";
import { cfgDisabledProviders } from "../../config/model-settings";
import type { AgentSession } from "../../session/agent-session";
import { listLogoutAccounts, logoutCredential } from "../../slash-commands/helpers/logout";
import { captureBrowserSession } from "../../utils/browser-session";
import { openPath } from "../../utils/open";
import type { AcpViewerHost } from "./acp-viewer-host";

function providerArgument(session: AgentSession, mode: "login" | "logout", args?: string): string | undefined {
	const provider = args?.trim();
	if (!provider) return undefined;
	const info = getOAuthProviders().find(candidate => candidate.id === provider);
	if (!info) throw new Error(`/${mode} expects one OAuth provider id; unsupported argument: ${provider}`);
	if (mode === "login") {
		const disabled = cfgDisabledProviders.get(session.settings);
		if (disabled.includes(provider) || (info.storeCredentialsAs && disabled.includes(info.storeCredentialsAs))) {
			throw new Error(`Provider ${provider} is disabled.`);
		}
		if (!info.available) throw new Error(`Provider ${provider} is unavailable in this environment.`);
	}
	return provider;
}

function report(viewer: AcpViewerHost, title: string, message: string, onClose: () => void): void {
	if (viewer.closed) return;
	viewer.mount(new ReportPanel({ title, body: new Text(message, 0, 0), closeKey: "escape", onClose }));
}

/** A real OAuth flow over an existing viewer page, including the manual-code fallback. */
export function openAcpProviderLogin(
	viewer: AcpViewerHost,
	session: AgentSession,
	provider: string,
	onDone: (success: boolean) => void,
): void {
	if (!providerArgument(session, "login", provider)) throw new Error("/login requires a provider id.");
	if (viewer.closed) return;
	const previousFocus = viewer.focused();
	let finished = false;
	const finish = (success: boolean): void => {
		if (finished) return;
		finished = true;
		viewer.signal.removeEventListener("abort", onAbort);
		dialog.dispose();
		overlay.hide();
		if (!viewer.closed) {
			viewer.setFocus(previousFocus);
			onDone(success);
		}
	};
	const dialog = new LoginDialogComponent(viewer, provider, () => finish(false), openPath);
	const overlay = viewer.showOverlay(dialog);
	const onAbort = (): void => finish(false);
	viewer.signal.addEventListener("abort", onAbort, { once: true });
	viewer.setFocus(dialog);
	void (async () => {
		try {
			const identity = await session.modelRegistry.authStorage.oauth.login(provider as OAuthProvider, {
				signal: dialog.signal,
				onBrowserSession: captureBrowserSession,
				onAuth: info => dialog.showAuth(info.url, info.instructions, info.launchUrl),
				onPrompt: prompt => dialog.showPrompt(prompt),
				onProgress: message => dialog.showProgress(message),
				onManualCodeInput: PASTE_CODE_LOGIN_PROVIDERS.has(provider)
					? signal =>
							dialog.showManualInput(
								`Paste the authorization code (or full redirect URL), then press ${editorKey("tui.input.submit")}:`,
								signal,
							)
					: undefined,
			});
			if (finished || viewer.closed) return;
			if (!identity) {
				viewer.notice(`No credentials were stored for ${provider}.`);
				finish(false);
				return;
			}
			await session.modelRegistry.refreshProvider(getOAuthCredentialProvider(provider), "online");
			if (finished || viewer.closed) return;
			const who = formatLoginIdentity(identity);
			viewer.notice(`Successfully logged in to ${provider}${who ? ` as ${who}` : ""}.`);
			finish(true);
		} catch (error) {
			if (!finished && !viewer.closed && !dialog.signal.aborted) {
				viewer.notice(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			finish(false);
		}
	})();
}

/** `/login [provider]`: the ordinary provider selector and OAuth dialog, owned by this viewer. */
export function openAcpLogin(viewer: AcpViewerHost, session: AgentSession, onClose: () => void, args?: string): void {
	const provider = providerArgument(session, "login", args);
	if (viewer.closed) return;
	if (provider) {
		report(viewer, "Sign in", `Signing in to ${provider}.`, onClose);
		openAcpProviderLogin(viewer, session, provider, success => {
			report(
				viewer,
				"Sign in",
				success ? `Signed in to ${provider}.` : `Sign-in to ${provider} did not complete.`,
				onClose,
			);
		});
		return;
	}
	let busy = false;
	const selector = new OAuthSelectorComponent(
		"login",
		session.modelRegistry.authStorage,
		selected => {
			if (busy || viewer.closed) return;
			busy = true;
			selector.stopValidation();
			openAcpProviderLogin(viewer, session, selected, () => {
				busy = false;
				selector.refreshAuth();
				viewer.requestRender();
			});
		},
		onClose,
		{
			disabledProviders: cfgDisabledProviders.get(session.settings),
			validateAuth: async selected =>
				!!(await session.modelRegistry.getApiKeyForProvider(selected, session.sessionId)),
			requestRender: () => viewer.requestRender(),
		},
	);
	viewer.mount(selector);
}

async function openLogoutAccounts(
	viewer: AcpViewerHost,
	session: AgentSession,
	provider: string,
	onClose: () => void,
): Promise<void> {
	const accounts = await listLogoutAccounts(session.modelRegistry.authStorage, provider, session.sessionId);
	if (viewer.closed) return;
	const info = getOAuthProviders().find(candidate => candidate.id === provider);
	if (accounts.length === 0) {
		const source = session.modelRegistry.authStorage.keys.describe(
			getOAuthCredentialProvider(provider),
			session.sessionId,
		);
		report(
			viewer,
			"Sign out",
			`No stored credentials for ${provider}.${source ? ` Current auth comes from ${source}; remove that source to log out.` : ""}`,
			onClose,
		);
		return;
	}
	let busy = false;
	const selector = new LogoutAccountSelectorComponent(
		info?.name ?? provider,
		accounts,
		account => {
			if (busy || viewer.closed) return;
			busy = true;
			report(viewer, "Sign out", `Signing out ${account.label} from ${provider}…`, onClose);
			void logoutCredential(session.modelRegistry, provider, account.credentialId, session.sessionId).then(
				result => {
					report(
						viewer,
						"Sign out",
						result.removed
							? `Successfully logged out ${account.label} from ${provider}.${result.remainingSource ? ` ${provider} is still authenticated via ${result.remainingSource}.` : ""}`
							: `Logout skipped: ${account.label} is no longer stored for ${provider}.`,
						onClose,
					);
				},
				error => {
					report(
						viewer,
						"Sign out",
						`Logout failed: ${error instanceof Error ? error.message : String(error)}`,
						onClose,
					);
				},
			);
		},
		onClose,
	);
	viewer.mount(selector);
}

/** `/logout [provider]`: select a stored account and remove exactly that credential. */
export async function openAcpLogout(
	viewer: AcpViewerHost,
	session: AgentSession,
	onClose: () => void,
	args?: string,
): Promise<void> {
	const provider = providerArgument(session, "logout", args);
	if (viewer.closed) return;
	report(viewer, "Sign out", "Loading stored provider credentials…", onClose);
	try {
		if (provider) {
			await openLogoutAccounts(viewer, session, provider, onClose);
			return;
		}
		await session.modelRegistry.authStorage.credentials.reload();
		await Promise.all(
			getOAuthProviders().map(info =>
				session.modelRegistry.getApiKeyForProvider(info.id, session.sessionId).catch(() => undefined),
			),
		);
		if (viewer.closed) return;
		const selector = new OAuthSelectorComponent(
			"logout",
			session.modelRegistry.authStorage,
			selected => {
				if (viewer.closed) return;
				selector.dispose();
				report(viewer, "Sign out", "Loading stored accounts…", onClose);
				void openLogoutAccounts(viewer, session, selected, onClose).catch(error => {
					report(
						viewer,
						"Sign out",
						`Could not load stored credentials: ${error instanceof Error ? error.message : String(error)}`,
						onClose,
					);
				});
			},
			onClose,
			{ requestRender: () => viewer.requestRender() },
		);
		viewer.mount(selector);
	} catch (error) {
		report(
			viewer,
			"Sign out",
			`Could not load stored credentials: ${error instanceof Error ? error.message : String(error)}`,
			onClose,
		);
	}
}
