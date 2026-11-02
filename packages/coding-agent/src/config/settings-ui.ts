import { TERMINAL } from "@oh-my-pi/pi-tui";
import { isNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { SETTING_TABS, type SettingsDisplayEntry, type SettingsHost } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { isSettingsInitialized, Settings, settings } from "./settings";
import { orderedSettings } from "./all-settings";
import { type AnySetting, lookup } from "./registry";

import { cfgPlanAutosave, cfgPlanEnabled } from "../plan-mode/settings";
import {
	cfgRetryUsageAwareFallback,
	cfgDefaultThinkingLevel,
	normalizeProviderMaxInFlightRequests,
	validateProviderMaxInFlightRequests,
} from "../session/settings";
import { cfgAutolearnEnabled } from "../autolearn/settings";
import { cfgMemoryBackend } from "../memory-backend/settings";
import { cfgTuiVimMode } from "../modes/settings";
import { cfgAdvisorEnabled } from "../advisor/settings";
import { cfgContextFilesExtra } from "../session/context-settings";
import { cfgTaskPerCallModelAllow } from "../task/settings";
import { cfgToolsRestrictedFolders } from "../tools/settings";

/** Conditions follow the same settings store as the values being edited. */
function createConditions(source: Settings): Record<string, () => boolean> {
	const whenSettings =
		(test: (settings: Settings) => boolean): (() => boolean) =>
		() =>
			(source !== settings || isSettingsInitialized()) && test(source);
	return {
		macOS: () => process.platform === "darwin",
		hasImageProtocol: () => !!TERMINAL.imageProtocol,
		nativeRendering: () => isNativeRendering(),
		advisorEnabled: whenSettings(s => cfgAdvisorEnabled.get(s) === true),
		vimModeEnabled: whenSettings(s => cfgTuiVimMode.get(s) === true),
		hindsightActive: whenSettings(s => cfgMemoryBackend.get(s) === "hindsight"),
		mnemopiActive: whenSettings(s => cfgMemoryBackend.get(s) === "mnemopi"),
		autolearnActive: whenSettings(s => cfgAutolearnEnabled.get(s) === true),
		autoThinkingActive: whenSettings(s => cfgDefaultThinkingLevel.get(s) === "auto"),
		usageAwareFallbackEnabled: whenSettings(s => cfgRetryUsageAwareFallback.get(s) === true),
		planModeEnabled: whenSettings(s => cfgPlanEnabled.get(s)),
		planAutosaveEnabled: whenSettings(s => cfgPlanEnabled.get(s) && cfgPlanAutosave.get(s)),
		// These editors write the global layer; never promote a project-supplied list.
		contextFilesExtraNotProject: whenSettings(s => cfgContextFilesExtra.provenance(s) !== "project"),
		restrictedFoldersNotProject: whenSettings(s => cfgToolsRestrictedFolders.provenance(s) !== "project"),
		perCallModelAllowNotProject: whenSettings(s => cfgTaskPerCallModelAllow.provenance(s) !== "project"),
	};
}

/** Description suffix telling the panel user that an environment variable is in play. */
function envNote(setting: AnySetting): string {
	if (!setting.envName || setting.envValue() === undefined) return "";
	return setting.envFallback
		? ` Unset, it falls back to $${setting.envName}.`
		: ` $${setting.envName} overrides this setting while it is set.`;
}

/**
 * Adapt the application schema and settings store to the terminal overlay. The panel shows and
 * edits the value of the settings layers, never an environment-supplied one (so an env credential
 * is never pre-filled or written to config); descriptions note an active environment variable.
 */
export function createSettingsHost(source: Settings = settings): SettingsHost {
	const conditions = createConditions(source);
	const entries: SettingsDisplayEntry[] = [];
	for (const tab of SETTING_TABS) {
		for (const setting of orderedSettings()) {
			const ui = setting.ui;
			if (ui?.tab !== tab) continue;
			const note = envNote(setting);
			entries.push({
				path: setting.id,
				type: setting.type,
				defaultValue: setting.default,
				ui: note ? { ...ui, description: `${ui.description}${note}` } : ui,
				enumValues: setting.enumValues,
				credential: setting.isCredential,
				condition: ui.condition ? conditions[ui.condition] : undefined,
			});
		}
	}
	const resolve = (path: string): AnySetting => {
		const setting = lookup(path);
		if (!setting) throw new Error(`Unknown setting: ${path}`);
		return setting;
	};
	return {
		entries,
		get: path => lookup(path)?.layered(source),
		set: (path, value) => resolve(path).set(source, value),
		unset: path => resolve(path).unset(source),
		normalizeProviderLimits: normalizeProviderMaxInFlightRequests,
		validateProviderLimits: validateProviderMaxInFlightRequests,
	};
}
