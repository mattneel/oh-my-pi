import type { Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { ResolvedRoleModel } from "@oh-my-pi/pi-tui/overlays/model-picker";
import type { AgentSession } from "../session/agent-session";

/** Session-only switching policy shared by terminal and ACP viewer pickers. */
export async function applySessionModel(options: {
	session: AgentSession;
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
	role?: ResolvedRoleModel;
	compactFirst: boolean;
	/** Runs on successful compaction before queued turns resume. False retains the old model. */
	compact: (apply: () => Promise<void>) => Promise<boolean>;
	onApplied?: () => void;
	/** A dismissed viewer or replaced session must not apply an obsolete selection. */
	isCurrent?: () => boolean;
}): Promise<boolean> {
	let applied = false;
	const apply = async (): Promise<void> => {
		if (applied || options.isCurrent?.() === false) return;
		if (options.role) await options.session.applyRoleModel(options.role);
		else {
			const level = options.thinkingLevel ?? options.session.resolveTemporaryModelThinkingLevel(options.model);
			await options.session.setModelTemporary(options.model, level);
		}
		applied = true;
		options.onApplied?.();
	};
	if (!options.compactFirst) await apply();
	else if (await options.compact(apply)) await apply();
	return applied;
}
