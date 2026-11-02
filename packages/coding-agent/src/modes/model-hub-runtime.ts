import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ModelHubCallbacks } from "@oh-my-pi/pi-tui/overlays/model-hub";
import { formatModelSelectorValue } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { AUTO_THINKING, concreteThinkingLevel, parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { logger } from "@oh-my-pi/pi-utils";
import {
	acquireModelRoleMutation,
	applyModelPreset,
	formatModelPresetSwitch,
	isCleanModelPresetSwitch,
	modelPresetSavedMessage,
	saveModelPreset,
} from "../config/model-presets";
import { resolveModelRoleValue } from "../config/model-resolver";
import { getRoleInfo } from "../config/model-roles";
import { cfgCycleOrder, cfgModelRoleStorage } from "../config/model-settings";
import type { AgentSession } from "../session/agent-session";
import { previewModelCompactionPoint, setModelCompactionPoint } from "../session/model-compaction-threshold";
import { cfgDefaultThinkingLevel, cfgRetryFallbackChains } from "../session/settings";

/** Side effects of the full Models screen, independent of its terminal or viewer host. */
export interface ModelHubRuntimeHost {
	readonly session: AgentSession;
	isCurrent(): boolean;
	refresh(): void;
	modelChanged(): void;
	compactionChanged(): void;
	showStatus(message: string): void;
	showWarning(message: string): void;
	showError(message: string): void;
	onLoginRequest(providerId: string): void;
	onCancel(): void;
}

/** Keep terminal and ACP role assignments on the same persistence and mutation policy. */
export function createModelHubCallbacks(host: ModelHubRuntimeHost): ModelHubCallbacks {
	const { session } = host;
	const settings = session.settings;
	return {
		onAssign: async (model, role, thinkingLevel, selector, scope) => {
			if (!host.isCurrent()) return false;
			const release = role === "default" ? await acquireModelRoleMutation() : undefined;
			try {
				if (!host.isCurrent()) return false;
				const configuredStorage = cfgModelRoleStorage.get(settings);
				const targetScope = configuredStorage === "project" ? (scope ?? "project") : "global";
				const selectorValue = selector ?? `${model.provider}/${model.id}`;
				const scopeLabel =
					configuredStorage === "project" ? `${targetScope === "project" ? "Project" : "Global"} ` : "";
				if (role === "default") {
					// Auto configures the active session only for the default role.
					const isAuto = thinkingLevel === AUTO_THINKING;
					const concreteThinking = isAuto || thinkingLevel === undefined ? undefined : thinkingLevel;
					const provenance = settings.getModelRoleProvenance("default");
					const shadowedGlobal =
						configuredStorage === "project" &&
						targetScope === "global" &&
						(provenance === "project" ||
							provenance === "overlay" ||
							(provenance === "runtime" && settings.isProjectModelRoleRuntimeOverrideActive("default")));
					const shadowedProject =
						configuredStorage === "project" && targetScope === "project" && provenance === "overlay";
					if (shadowedGlobal || shadowedProject) {
						const value = formatModelSelectorValue(selectorValue, concreteThinking);
						if (shadowedGlobal) settings.setModelRole("default", value);
						else settings.setProjectModelRole("default", value);
						if (isAuto) cfgDefaultThinkingLevel.set(settings, AUTO_THINKING);
					} else {
						const { switched } = await session.setModel(model, role, {
							selector,
							thinkingLevel: isAuto ? ThinkingLevel.Inherit : concreteThinking,
							persist: targetScope === "global",
						});
						if (!switched) return false;
						if (!host.isCurrent()) return false;
						if (targetScope === "project")
							settings.setProjectModelRole("default", formatModelSelectorValue(selectorValue, concreteThinking));
						if (isAuto) session.setThinkingLevel(AUTO_THINKING, true);
						else if (concreteThinking && concreteThinking !== ThinkingLevel.Inherit)
							session.setThinkingLevel(concreteThinking);
						host.modelChanged();
					}
					const label = configuredStorage === "project" ? `${scopeLabel}default` : "Default";
					host.showStatus(`${label} model: ${selector ?? model.id}`);
				} else {
					const value = formatModelSelectorValue(selectorValue, thinkingLevel);
					if (targetScope === "project") settings.setProjectModelRole(role, value);
					else settings.setModelRole(role, value);
					const info = getRoleInfo(role, settings);
					host.showStatus(`${scopeLabel}${info?.tag ?? info?.name ?? role} model: ${selector ?? model.id}`);
				}
				return true;
			} catch (error) {
				host.showError(error instanceof Error ? error.message : String(error));
				return false;
			} finally {
				release?.();
				if (host.isCurrent()) host.refresh();
			}
		},
		onUnassign: async (role, scope) => {
			if (!host.isCurrent()) return;
			const release = role === "default" ? await acquireModelRoleMutation() : undefined;
			try {
				if (!host.isCurrent()) return;
				const configuredStorage = cfgModelRoleStorage.get(settings);
				const targetScope = configuredStorage === "project" ? (scope ?? "project") : "global";
				const scopeLabel =
					configuredStorage === "project" ? `${targetScope === "project" ? "Project" : "Global"} ` : "";
				const previous = role === "default" ? settings.getModelRole("default") : undefined;
				if (targetScope === "project") settings.clearProjectModelRole(role);
				else settings.setModelRole(role, undefined);
				const info = getRoleInfo(role, settings);
				host.showStatus(`${scopeLabel}${info?.tag ?? info?.name ?? role} role cleared — auto-selection applies`);
				// Clearing a scope may expose a persisted default. Overlay/runtime layers stay session-neutral.
				if (role !== "default") return;
				const fallback = settings.getModelRole("default");
				const provenance = settings.getModelRoleProvenance("default");
				if (!fallback || (provenance !== "project" && provenance !== "global")) return;
				const scoped = session.scopedModels.map(item => item.model);
				const resolved = resolveModelRoleValue(
					fallback,
					scoped.length > 0 ? scoped : session.getAvailableModels(),
					{ settings },
				);
				const live = session.model;
				const differs =
					!live || !resolved.model || live.provider !== resolved.model.provider || live.id !== resolved.model.id;
				if (!resolved.model || (fallback === previous && !differs)) return;
				const model = resolved.model;
				let concreteThinking = concreteThinkingLevel(resolved.thinkingLevel);
				let isAuto = resolved.thinkingLevel === AUTO_THINKING;
				if (!resolved.explicitThinkingLevel && !concreteThinking) {
					const defaultLevel = parseConfiguredThinkingLevel(cfgDefaultThinkingLevel.get(settings));
					if (defaultLevel === AUTO_THINKING) isAuto = true;
					else if (defaultLevel) concreteThinking = defaultLevel;
				}
				const { switched } = await session.setModel(model, "default", {
					persist: false,
					thinkingLevel: isAuto ? ThinkingLevel.Inherit : (concreteThinking ?? ThinkingLevel.Inherit),
				});
				if (!switched || !host.isCurrent()) return;
				if (isAuto) session.setThinkingLevel(AUTO_THINKING, true);
				else if (concreteThinking && concreteThinking !== ThinkingLevel.Inherit)
					session.setThinkingLevel(concreteThinking);
				host.modelChanged();
				host.showStatus(`Default model: ${model.provider}/${model.id}`);
			} catch (error) {
				host.showError(error instanceof Error ? error.message : String(error));
			} finally {
				release?.();
				if (host.isCurrent()) host.refresh();
			}
		},
		onFallbackChainChange: (role, chain) => {
			if (!host.isCurrent()) return;
			try {
				cfgRetryFallbackChains.setEntry(settings, role, chain.length > 0 ? chain : undefined);
				const info = getRoleInfo(role, settings);
				host.showStatus(
					chain.length > 0
						? `${info?.tag ?? info?.name ?? role} fallbacks: ${chain.join(" → ")}`
						: `${info?.tag ?? info?.name ?? role} fallbacks cleared`,
				);
			} catch (error) {
				host.showError(error instanceof Error ? error.message : String(error));
			}
		},
		onLoginRequest: provider => {
			if (host.isCurrent()) host.onLoginRequest(provider);
		},
		onCycleOrderChange: order => {
			if (!host.isCurrent()) return;
			try {
				cfgCycleOrder.set(settings, order);
				host.showStatus(
					order.length > 0 ? `Quick-switch cycle: ${order.join(" → ")}` : "Quick-switch cycle cleared",
				);
			} catch (error) {
				host.showError(error instanceof Error ? error.message : String(error));
			}
		},
		onCompactionPointChange: (model, input, confirmed) => {
			if (!host.isCurrent()) return { kind: "error", message: "Models screen is closed" };
			try {
				const update = setModelCompactionPoint(settings, model, input, {
					tiers: session.modelRegistry.contextWindowTiers(model),
					confirmed,
				});
				if (update.kind === "confirm") return update;
				const { described, summary } = update;
				host.showStatus(
					`Compaction limit for ${model.provider}/${model.id}: ${described}${summary ? ` · ${summary}` : ""}`,
				);
				host.compactionChanged();
				void session.modelRegistry
					.reapplyModelPolicies()
					.then(() => {
						if (host.isCurrent()) host.refresh();
					})
					.catch(error =>
						logger.warn("model hub refresh after compaction point failed", { error: String(error) }),
					);
				return undefined;
			} catch (error) {
				return { kind: "error", message: error instanceof Error ? error.message : String(error) };
			}
		},
		previewCompactionPoint: (model, input) =>
			previewModelCompactionPoint(settings, model, input, session.modelRegistry.contextWindowTiers(model)),
		onSavePreset: name => {
			if (!host.isCurrent()) return;
			try {
				saveModelPreset(settings, name);
				host.showStatus(modelPresetSavedMessage(settings, name));
			} catch (error) {
				host.showError(error instanceof Error ? error.message : String(error));
			}
		},
		onSwitchPreset: async name => {
			if (!host.isCurrent()) return;
			try {
				const result = await applyModelPreset(settings, session, name, host.isCurrent);
				if (!host.isCurrent()) return;
				const message = formatModelPresetSwitch(name, result);
				if (result.kind === "switched") host.modelChanged();
				if (isCleanModelPresetSwitch(result)) host.showStatus(message);
				else host.showWarning(message);
			} catch (error) {
				host.showError(error instanceof Error ? error.message : String(error));
			} finally {
				if (host.isCurrent()) host.refresh();
			}
		},
		onCancel: host.onCancel,
	};
}
