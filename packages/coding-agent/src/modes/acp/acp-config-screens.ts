import type { Component } from "@oh-my-pi/pi-tui";
import { AgentsHubComponent } from "@oh-my-pi/pi-tui/overlays/agents-hub";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line/component";
import { getAvailableThemes, previewTheme } from "@oh-my-pi/pi-tui/theme";
import { parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { reset as resetCapabilities } from "../../capability";
import { createSettingsHost } from "../../config/settings-ui";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import { createPluginSettingsHost } from "../../extensibility/plugins/settings-host";
import type { AgentSession } from "../../session/agent-session";
import { cfgDefaultThinkingLevel } from "../../session/settings";
import { createAgentsHubDeps } from "../agents-hub-deps";
import { createStatusLineHost } from "../status-line-host";
import type { AcpViewerHost } from "./acp-viewer-host";

/** A configuration page belongs to the captured session identity, not its next conversation. */
function createConfigScreenLifetime(viewer: AcpViewerHost, session: AgentSession, onClose: () => void) {
	const controller = new AbortController();
	const sessionId = session.sessionManager.getSessionId();
	let component: Component | undefined;
	const isCurrent = () =>
		!controller.signal.aborted &&
		!viewer.closed &&
		!session.isDisposed &&
		session.sessionManager.getSessionId() === sessionId;
	const dispose = () => {
		if (controller.signal.aborted) return;
		controller.abort();
		unsubscribe();
		viewer.signal.removeEventListener("abort", dispose);
		component?.dispose?.();
		component = undefined;
	};
	const close = () => {
		if (controller.signal.aborted) return;
		dispose();
		onClose();
	};
	const unsubscribe = session.registerSessionChangeCallback(close);
	viewer.signal.addEventListener("abort", dispose, { once: true });
	if (viewer.closed || viewer.signal.aborted || session.isDisposed) dispose();
	return {
		signal: controller.signal,
		isCurrent,
		assertCurrent: () => {
			controller.signal.throwIfAborted();
			if (!isCurrent()) throw new Error("Configuration screen session is no longer current.");
		},
		mount: (root: Component) => {
			if (!isCurrent()) {
				root.dispose?.();
				close();
				return;
			}
			component = root;
			viewer.mount(root);
		},
		dispose,
		close,
	};
}

/** Open the real settings editor, with viewer-owned previews and the session's settings store. */
export async function openAcpSettingsScreen(
	viewer: AcpViewerHost,
	session: AgentSession,
	onClose: () => void,
	args = "",
): Promise<void> {
	if (args.trim()) throw new Error("/settings accepts no arguments in a native viewer.");
	const lifetime = createConfigScreenLifetime(viewer, session, onClose);
	try {
		const availableThemes = await getAvailableThemes();
		if (!lifetime.isCurrent()) {
			lifetime.close();
			return;
		}
		const cwd = session.sessionManager.getCwd();
		const settingsHost = createSettingsHost(session.settings);
		const plugins = createPluginSettingsHost(cwd);
		const manager = plugins.manager;
		// Retain the real managers; guard writes which can resume after an asynchronous editor load.
		plugins.manager = {
			list: () => manager.list(),
			getPlugin: (name, options) => manager.getPlugin(name, options),
			getPluginSettings: name => manager.getPluginSettings(name),
			getEnabledFeatures: name => manager.getEnabledFeatures(name),
			setEnabled: (name, enabled) => {
				lifetime.assertCurrent();
				return manager.setEnabled(name, enabled);
			},
			setEnabledFeatures: (name, features) => {
				lifetime.assertCurrent();
				return manager.setEnabledFeatures(name, features);
			},
			setPluginSetting: (name, key, value) => {
				lifetime.assertCurrent();
				return manager.setPluginSetting(name, key, value);
			},
		};
		const createMarketplaceManager = plugins.createMarketplaceManager;
		plugins.createMarketplaceManager = async () => {
			const marketplace = await createMarketplaceManager();
			return {
				listInstalledPlugins: () => marketplace.listInstalledPlugins(),
				setPluginEnabled: (id, enabled, scope) => {
					lifetime.assertCurrent();
					return marketplace.setPluginEnabled(id, enabled, scope);
				},
			};
		};
		const statusHost = {
			...createStatusLineHost(session.settings),
			getProjectDir: () => cwd,
		};
		const status = new StatusLineComponent(session, statusHost);
		status.watchBranch(() => viewer.requestRender());
		lifetime.signal.addEventListener("abort", () => status.dispose(), { once: true });
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [...session.getAvailableThinkingLevels()],
				thinkingLevel: session.thinkingLevel,
				availableThemes,
				providers: [...new Set(session.getAvailableModels().map(model => model.provider))].sort((a, b) =>
					a.localeCompare(b),
				),
				settings: {
					...settingsHost,
					set: (path, value) => {
						lifetime.assertCurrent();
						settingsHost.set(path, value);
					},
					unset: path => {
						lifetime.assertCurrent();
						settingsHost.unset(path);
					},
				},
				plugins,
				model: session.model,
				imageBudget: viewer.imageBudget,
				requestRender: () => viewer.requestRender(),
				composerPreviewStatus: status,
			},
			{
				onChange: (id, value) => {
					lifetime.assertCurrent();
					// Match SelectorController: only an in-process effort edit changes the live session.
					// All other side effects belong to the existing setting-handle listeners.
					if (id === cfgDefaultThinkingLevel.id && typeof value === "string") {
						const level = parseConfiguredThinkingLevel(value);
						if (level !== undefined && level !== session.configuredThinkingLevel())
							session.setThinkingLevel(level);
					}
					status.updateSettings(statusHost.getSettings());
					viewer.requestRender();
				},
				onThemePreview: async name => {
					if (!lifetime.isCurrent()) return;
					const result = await previewTheme(name, undefined, lifetime.signal);
					if (!lifetime.isCurrent() || !result.success) return;
					status.invalidate();
					viewer.invalidate();
					viewer.requestRender();
				},
				onStatusLinePreview: preview => {
					if (!lifetime.isCurrent()) return;
					status.updateSettings({ ...statusHost.getSettings(), ...preview });
					viewer.requestRender();
				},
				getStatusLinePreview: () => status.getPreviewLines(viewer.terminal.columns).join("\n"),
				describeStatusLinePreview: () => status.describePreview(),
				onPluginsChanged: async () => {
					if (!lifetime.isCurrent()) return;
					const projectPath = await resolveActiveProjectRegistryPath(cwd);
					if (!lifetime.isCurrent()) return;
					clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
					await session.refreshSkillsAndCommands();
					if (!lifetime.isCurrent()) return;
					resetCapabilities();
					viewer.requestRender();
				},
				onCancel: lifetime.close,
				onDispose: lifetime.dispose,
			},
		);
		lifetime.mount(selector);
	} catch (error) {
		lifetime.dispose();
		throw error;
	}
}

/** Open agent configuration (not the activity/focus Agent Hub), preserving its real policy factory. */
export async function openAcpAgentsScreen(
	viewer: AcpViewerHost,
	session: AgentSession,
	onClose: () => void,
	args = "",
): Promise<void> {
	if (args.trim()) throw new Error("/agents accepts no arguments in a native viewer.");
	const lifetime = createConfigScreenLifetime(viewer, session, onClose);
	try {
		lifetime.assertCurrent();
		const activeModel = session.model;
		const deps = createAgentsHubDeps(
			session.sessionManager.getCwd(),
			session.settings,
			session.modelRegistry,
			() => session.effectiveExtensionRoots,
			activeModel ? `${activeModel.provider}/${activeModel.id}` : undefined,
			session.settings.getModelRole("default"),
			model => session.effectiveServiceTier(model),
		);
		const hub = await AgentsHubComponent.create(
			{ requestRender: () => viewer.requestRender() },
			{
				...deps,
				loadAgents: async () => {
					lifetime.assertCurrent();
					const agents = await deps.loadAgents();
					lifetime.assertCurrent();
					return agents;
				},
				setAgentDisabled: (name, options) => {
					lifetime.assertCurrent();
					deps.setAgentDisabled(name, options);
				},
				setAgentOverride: (property, name, value) => {
					lifetime.assertCurrent();
					deps.setAgentOverride(property, name, value);
				},
				generateAgent: (description, onText, signal) => {
					lifetime.assertCurrent();
					const combined = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
					return deps.generateAgent(description, onText, combined);
				},
				saveAgent: (scope, spec) => {
					lifetime.assertCurrent();
					return deps.saveAgent(scope, spec);
				},
			},
			{ onCancel: lifetime.close },
		);
		lifetime.mount(hub);
	} catch (error) {
		lifetime.dispose();
		throw error;
	}
}
