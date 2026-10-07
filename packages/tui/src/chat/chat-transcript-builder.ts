/**
 * Shared semantic transcript components for recorded viewers and live consumers.
 * Replay rebuilds once; cumulative assistant updates retain components and native ids.
 * The host supplies display capabilities, not an interactive terminal or control path.
 */
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import { type Component, type TUI } from "../tui";
import type { AdvisorMessageDetails } from "./messages";
import { COLLAB_PROMPT_MESSAGE_TYPE, type CollabPromptDetails } from "./messages";
import {
	type ChatTranscriptDisplayPreferences,
	chatTranscriptDisplayPreferences as displayPreferences,
} from "./display-preferences";
import type { AssistantThinkingRenderer, MessageRenderer } from "./extension-types";
import { LAUNCH_COMPLETION_MESSAGE_TYPE } from "./messages";
import {
	BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
	type CustomMessage,
	isUserTurnInitiator,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "./messages";
import {
	imageContent,
	textContent,
	type TranscriptEntryLike as TranscriptEntry,
	transcriptEntryMessage,
} from "./transcript-entry";
import { theme } from "../theme";
import {
	assistantHasVisibleContent,
	assistantUsageIsBilled,
	buildAsyncResultBlock,
	buildFileMentionBlock,
	buildIrcMessageCard,
	buildLaunchCompletionBlock,
	normalizeToolArgs,
	resolveAssistantErrorPresentation,
	splitAssistantMessageToolTimeline,
} from "./transcript-render-helpers";
import { createAdvisorMessageCard } from "./advisor-message";
import { AssistantMessageComponent } from "./assistant-message";
import { createBackgroundTanDispatchBlock } from "./background-tan-message";
import { BashExecutionComponent } from "./bash-execution";
import { detectCacheInvalidation } from "./cache-invalidation-marker";
import { ServedModelTracker } from "./served-model-marker";
import { CollabPromptMessageComponent } from "./collab-prompt-message";
import {
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	createHandoffSummaryMessageComponent,
} from "./compaction-summary-message";
import { CustomMessageComponent } from "./custom-message";
import { EvalExecutionComponent } from "./eval-execution";
import {
	type LateDiagnosticsFile,
	LateDiagnosticsMessageComponent,
	routeLateDiagnostics,
} from "./late-diagnostics-message";
import {
	groupedReadUsageCallIds,
	ReadToolGroupComponent,
	readArgsCollapseIntoGroup,
	readArgsHaveTarget,
} from "./read-tool-group";
import { isReplyWrite, ReplyWriteComponent, replyDisplayMessage, toolResultReplies } from "./reply-write";
import { SkillMessageComponent } from "./skill-message";
import { ToolExecutionComponent, type ToolExecutionHandle, toolRenderName } from "./tool-execution";
import { reconcileStreamedToolCallIds } from "./streamed-tool-call-ids";
import { TranscriptContainer } from "../chrome/transcript-container";
import { createUsageRowBlock, TurnUsageTally, turnElapsedMs } from "../overlays/usage-row";
import { CollapsedSyntheticMessageComponent, UserMessageComponent } from "./user-message";

export interface ChatTranscriptBuilderDeps {
	ui: Pick<TUI, "requestRender" | "requestComponentRender" | "resetDisplay" | "imageBudget" | "lastFrameCostMs">;
	getTool?: (name: string) => AgentTool | undefined;
	/** Whether the active registry entry came from a built-in factory. */
	isBuiltInTool?: (name: string) => boolean;
	/** Decode in-flight arguments through the product's ordinary streamed-preview path. */
	toolArgs?: (call: ToolCall, renderName: string) => Record<string, unknown>;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	expandThinkingBlocks?: () => boolean;
	thinkingRenderers?: () => readonly AssistantThinkingRenderer[];
	displayPreferences?: ChatTranscriptDisplayPreferences;
	/** Session-scoped resolved destinations for model-authored Markdown links. */
	linkTargets?: ReadonlyMap<string, string>;
	/** Draw charts under numeric tables; false for transcripts that are not the main session's. Default: true. */
	tableCharts?: boolean;
	requestRender: () => void;
}

interface StreamingAssistant {
	before: AssistantMessageComponent;
	after: Map<string, AssistantMessageComponent>;
	tools: Map<string, ToolExecutionHandle>;
	seenTools: Set<string>;
	idsByIndex: Map<number, string>;
	hasVisibleContent: boolean;
}

export class ChatTranscriptBuilder {
	readonly container = new TranscriptContainer();
	#pendingTools = new Map<string, ToolExecutionHandle>();
	#readArgs = new Map<string, Record<string, unknown>>();
	#readGroup: ReadToolGroupComponent | null = null;
	#pendingUsage: Usage | undefined;
	#pendingUsageDuration: number | undefined;
	#pendingUsageTtft: number | undefined;
	#pendingUsageTimestamp: number | undefined;
	#pendingReadUsageCallIds: string[] | undefined;
	#pendingUsageElapsedMs: number | undefined;
	#turnStartedAt: number | undefined;
	readonly #turnUsage = new TurnUsageTally();
	#lastAssistantUsage: Usage | undefined;
	#servedModelTracker = new ServedModelTracker();
	#waitingPoll: ToolExecutionComponent | null = null;
	#todoSnapshot: ToolExecutionComponent | null = null;
	#expandables: Array<{ setExpanded(expanded: boolean): void }> = [];
	#expanded = false;
	#entryComponents = new Map<string, Component[]>();
	#streamingAssistant: StreamingAssistant | undefined;
	#completedTools = new Set<string>();
	#backgroundTools = new Set<string>();
	#heldResults = new Map<string, { message: ToolResultMessage; partial: boolean }>();
	#heldPreviews = new Map<string, unknown>();
	/** Execution-created cards awaiting their first assistant tool-call snapshot. */
	#unclaimedTools = new Map<string, ToolExecutionHandle>();

	readonly #deps: ChatTranscriptBuilderDeps;

	constructor(deps: ChatTranscriptBuilderDeps) {
		this.#deps = deps;
		this.container.setToolActivityVisible(!this.#preferences.hideToolActivity);
	}

	get #preferences(): ChatTranscriptDisplayPreferences {
		return this.#deps.displayPreferences ?? displayPreferences;
	}

	/** Whether the transcript currently holds any rendered rows. */
	get isEmpty(): boolean {
		return this.container.children.length === 0;
	}

	/** Discard all components and rebuild the whole transcript from `entries`. */
	rebuild(entries: TranscriptEntry[]): void {
		this.reset();
		for (const entry of entries) this.#appendEntry(entry);
		// Flush the trailing turn's usage row only once its tools are materialized
		// (a read whose result has not arrived stays pending); otherwise the row
		// would sit above its tools. The drain happens here at the end of the pass.
		if (this.#readArgs.size === 0 && this.#pendingTools.size === 0) this.#flushPendingUsage();
	}

	/** Append newly persisted entries without rebuilding already rendered rows. */
	append(entries: TranscriptEntry[]): void {
		for (const entry of entries) this.#appendEntry(entry);
		if (this.#readArgs.size === 0 && this.#pendingTools.size === 0) this.#flushPendingUsage();
	}

	/** Append a live completed message using the same components as persisted replay. */
	appendMessage(message: AgentMessage): void {
		this.#appendChatMessage(message);
		if (this.#readArgs.size === 0 && this.#pendingTools.size === 0) this.#flushPendingUsage();
	}

	/** Update the current assistant in place, retaining native node ids and local expansion. */
	updateAssistant(message: AssistantMessage, transient = true): void {
		// A parked background call must not delay the preceding request's metrics
		// past the next assistant, whose final snapshot owns a new usage batch.
		if (!this.#streamingAssistant) this.#flushPendingUsage();
		this.#streamingAssistant = this.#renderAssistant(message, this.#streamingAssistant, transient);
		if (!transient) {
			this.#streamingAssistant = undefined;
			if (this.#readArgs.size === 0 && this.#pendingTools.size === 0) this.#flushPendingUsage();
		}
	}

	/** Seal the assistant and abandoned foreground calls at agent_end, leaving background tasks live. */
	settleRun(): void {
		if (this.#streamingAssistant) {
			this.#streamingAssistant.before.markTranscriptBlockFinalized();
			for (const component of this.#streamingAssistant.after.values()) component.markTranscriptBlockFinalized();
			this.#streamingAssistant = undefined;
		}
		for (const id of this.#pendingTools.keys()) {
			if (this.#backgroundTools.has(id)) continue;
			this.#pendingTools.get(id)?.seal();
			this.#pendingTools.delete(id);
			this.#readArgs.delete(id);
			this.#completedTools.add(id);
		}
		for (const id of this.#readArgs.keys()) this.#completedTools.add(id);
		this.#readArgs.clear();
		this.#heldResults.clear();
		this.#heldPreviews.clear();
		this.#unclaimedTools.clear();
		this.#readGroup?.seal();
		this.#flushPendingUsage();
		this.#readGroup = null;
	}

	startToolExecution(id: string, name: string, args: Record<string, unknown>): void {
		if (this.#completedTools.has(id)) return;
		let component = this.#pendingTools.get(id);
		if (!component) {
			const groupedRead = name === "read" && (this.#readArgs.has(id) || readArgsCollapseIntoGroup(args));
			if (groupedRead) {
				component = this.#ensureReadGroup();
			} else {
				this.#readGroup?.finalize();
				this.#readGroup = null;
				component = this.#createTool(id, name, args);
			}
			this.#pendingTools.set(id, component);
			if (!this.#streamingAssistant?.seenTools.has(id) && !this.#readArgs.has(id)) {
				this.#unclaimedTools.set(id, component);
			}
		}
		component.updateArgs(args, id);
		component.setArgsComplete(id);
		component.setExecutionStarted(id);
		this.#consumeHeld(id);
	}

	updateToolResult(message: ToolResultMessage, partial = false): void {
		if (this.#completedTools.has(message.toolCallId)) return;
		const component = this.#pendingTools.get(message.toolCallId);
		if (!component && !this.#readArgs.has(message.toolCallId)) {
			this.#heldResults.set(message.toolCallId, { message, partial });
			return;
		}
		const asyncState = (message.details as { async?: { state?: string } } | undefined)?.async?.state;
		const terminalBackground =
			this.#backgroundTools.has(message.toolCallId) && (asyncState === "completed" || asyncState === "failed");
		if (partial && !terminalBackground) {
			component?.updateResult(message, true, message.toolCallId);
		} else {
			this.#appendToolResult(terminalBackground ? { ...message, isError: asyncState === "failed" } : message);
			if (this.#readArgs.size === 0 && this.#pendingTools.size === 0) this.#flushPendingUsage();
		}
	}

	updateToolPreview(id: string, update: unknown): void {
		const component = this.#pendingTools.get(id);
		if (component instanceof ToolExecutionComponent) component.updateStreamPreview(update);
		else if (!this.#completedTools.has(id)) this.#heldPreviews.set(id, update);
	}

	#consumeHeld(id: string): void {
		const preview = this.#heldPreviews.get(id);
		if (preview !== undefined) {
			this.#heldPreviews.delete(id);
			this.updateToolPreview(id, preview);
		}
		const result = this.#heldResults.get(id);
		if (result) {
			this.#heldResults.delete(id);
			this.updateToolResult(result.message, result.partial);
		}
	}

	/**
	 * Toggle tool-output expansion across every expandable component. Cards a
	 * TSP terminal collapsed or expanded locally mirror that into their own
	 * state, so this re-applies the transcript-wide state to every one of them
	 * even when it equals the previous value.
	 */
	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		for (const component of this.#expandables) component.setExpanded(expanded);
	}

	get expanded(): boolean {
		return this.#expanded;
	}

	/** Rendered row where a persisted entry begins, after the container has painted once. */
	rowForEntry(entryId: string): number | undefined {
		for (const component of this.#entryComponents.get(entryId) ?? []) {
			const row = this.container.getChildStartRow(component);
			if (row !== undefined) return row;
		}
		return undefined;
	}

	/** Tear down components (sealing pending spinners) and clear build state. */
	reset(): void {
		for (const pending of this.#pendingTools.values()) pending.seal();
		this.#pendingTools.clear();
		this.#readArgs.clear();
		this.#readGroup = null;
		this.#pendingUsage = undefined;
		this.#pendingUsageDuration = undefined;
		this.#pendingUsageTtft = undefined;
		this.#pendingUsageTimestamp = undefined;
		this.#pendingReadUsageCallIds = undefined;
		this.#pendingUsageElapsedMs = undefined;
		this.#turnStartedAt = undefined;
		this.#turnUsage.reset();
		this.#lastAssistantUsage = undefined;
		this.#servedModelTracker = new ServedModelTracker();
		this.#waitingPoll = null;
		this.#todoSnapshot = null;
		this.#expandables = [];
		this.#entryComponents.clear();
		this.#streamingAssistant = undefined;
		this.#completedTools.clear();
		this.#backgroundTools.clear();
		this.#heldResults.clear();
		this.#heldPreviews.clear();
		this.#unclaimedTools.clear();
		this.container.dispose();
		this.container.clear();
	}

	dispose(): void {
		this.reset();
	}

	#appendEntry(entry: TranscriptEntry): void {
		const message = transcriptEntryMessage(entry);
		if (!message) return;
		const before = this.container.children.length;
		this.#appendChatMessage(message);
		const components = this.container.children.slice(before);
		if (components.length > 0) this.#entryComponents.set(entry.id, components);
	}

	#trackExpandable(component: { setExpanded(expanded: boolean): void }): void {
		component.setExpanded(this.#expanded);
		this.#expandables.push(component);
	}

	/** Append assistant prose (a reply, a post-tool segment, or an `out://` reply write) with the transcript's display preferences. */
	#mountProse(component: AssistantMessageComponent): void {
		component.setImagesVisible(this.#preferences.showImages);
		component.setToolResultImagesVisible(!this.#preferences.hideToolActivity);
		component.setTableChartsVisible(this.#deps.tableCharts !== false);
		this.#trackExpandable(component);
		this.container.addChild(component);
	}

	/** A `wait` showing all-running is displaced by the next `wait` call. */
	#resolveWaitingPoll(nextToolName?: string): void {
		const previous = this.#waitingPoll;
		if (!previous) return;
		this.#waitingPoll = null;
		if (nextToolName === "wait" && previous.isDisplaceableBlock() && this.container.canDisplaceBlock(previous)) {
			this.container.removeChild(previous);
		}
		previous.seal();
	}

	#resolveTodoSnapshot(nextToolName?: string): void {
		const previous = this.#todoSnapshot;
		if (!previous) return;
		if (!previous.isDisplaceableBlock()) {
			this.#todoSnapshot = null;
			return;
		}
		if (previous.canBeDisplacedBy(nextToolName)) {
			this.#todoSnapshot = null;
			this.container.removeChild(previous);
			previous.seal();
			return;
		}
		if (nextToolName !== undefined) return;
		this.#todoSnapshot = null;
		previous.seal();
	}

	#ensureReadGroup(): ReadToolGroupComponent {
		if (!this.#readGroup) {
			this.#readGroup = new ReadToolGroupComponent({
				showContentPreview: this.#preferences.readToolResultPreview,
			});
			this.#trackExpandable(this.#readGroup);
			this.container.addChild(this.#readGroup);
		}
		return this.#readGroup;
	}

	// Defer per-turn metrics until the turn's tool results have materialized.
	// Read-only invisible turns attach the metrics to their shared compact
	// group; every other turn keeps the standalone row below its tool blocks.
	#flushPendingUsage(): void {
		if (!this.#pendingUsage) return;
		const usageAttached =
			this.#pendingReadUsageCallIds !== undefined &&
			(this.#readGroup?.attachUsage(
				this.#pendingReadUsageCallIds,
				this.#pendingUsage,
				this.#pendingUsageDuration,
				this.#pendingUsageTtft,
				this.#pendingUsageTimestamp,
				this.#pendingUsageElapsedMs,
			) ??
				false);
		if (!usageAttached) {
			this.#readGroup?.finalize();
			this.#readGroup = null;
			this.container.addChild(
				createUsageRowBlock(
					this.#pendingUsage,
					this.#pendingUsageDuration,
					this.#pendingUsageTtft,
					this.#pendingUsageTimestamp,
					this.#pendingUsageElapsedMs,
				),
			);
		}
		this.#pendingUsage = undefined;
		this.#pendingUsageDuration = undefined;
		this.#pendingUsageTtft = undefined;
		this.#pendingUsageTimestamp = undefined;
		this.#pendingReadUsageCallIds = undefined;
		this.#pendingUsageElapsedMs = undefined;
	}

	#appendChatMessage(message: AgentMessage): void {
		if (message.role !== "toolResult") this.#flushPendingUsage();
		if (message.role !== "assistant" && message.role !== "toolResult") {
			this.#readGroup?.finalize();
			this.#readGroup = null;
		}
		switch (message.role) {
			case "assistant":
				this.#renderAssistant(message);
				break;
			case "toolResult":
				this.#appendToolResult(message);
				break;
			case "user":
			case "developer": {
				// Only genuinely user-attributed prompts anchor the delta; a mid-run
				// agent-attributed `user` message (advisor tool-loop redirect) must not.
				if (message.role === "user" && message.attribution !== "agent") {
					this.#turnStartedAt = message.timestamp;
					this.#turnUsage.reset();
				} else if (message.role === "developer" && message.synthetic) {
					this.#turnUsage.reset();
					// A synthetic developer message initiates a fresh run (auto-
					// continue, /goal, approved plan): replay must not inherit the
					// preceding user prompt's timestamp, mirroring the live
					// agent_start clear. Same-turn continuation reminders (todo, plan)
					// are persisted developer messages WITHOUT the synthetic marker,
					// so their anchor survives the rebuild.
					// A deliberate operator action (`.`, `c` continue shortcut) is the turn's
					// own prompt: anchor the delta to it instead of clearing.
					if (message.userInitiated) this.#turnStartedAt = message.timestamp;
					else this.#turnStartedAt = undefined;
				}
				// A user prompt closes the poll-displacement window, same as the live path.
				if (message.role === "user") this.#resolveWaitingPoll();
				if (message.role === "user") this.#resolveTodoSnapshot();
				const userText = message.role === "user" ? textContent(message.content) : "";
				if (userText) {
					const isSynthetic = message.role === "developer" ? true : (message.synthetic ?? false);
					// Synthetic (agent-attributed) inputs — chiefly the advisor's `Session
					// update` replay dumps — can be hundreds of KiB of Markdown each.
					// Rendering their full body on cold open blocked the TUI (issue #6308);
					// collapse them behind a compact summary that builds Markdown only on
					// ctrl+o expand. Real user prompts stay fully rendered.
					if (isSynthetic) {
						const collapsed = new CollapsedSyntheticMessageComponent(userText);
						this.#trackExpandable(collapsed);
						this.container.addChild(collapsed);
					} else {
						this.container.addChild(
							new UserMessageComponent(userText, {
								liveSteered: message.role === "user" && message.liveSteered === true,
								timestamp: message.timestamp,
								images: imageContent(message.content),
							}),
						);
					}
				}
				break;
			}
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.#deps.ui, message.excludeFromContext);
				if (message.output) component.appendOutput(message.output);
				component.setComplete(message.exitCode, message.cancelled, {
					truncation: message.meta?.truncation,
					artifactError: message.meta?.artifactError,
					images: message.images,
					showImages: this.#preferences.showImages,
				});
				this.container.addChild(component);
				break;
			}
			case "pythonExecution": {
				const component = new EvalExecutionComponent(message.code, this.#deps.ui, message.excludeFromContext);
				if (message.output) component.appendOutput(message.output);
				component.setComplete(message.exitCode, message.cancelled, {
					truncation: message.meta?.truncation,
					artifactError: message.meta?.artifactError,
				});
				this.container.addChild(component);
				break;
			}
			case "hookMessage":
			case "custom":
				// A directly-invoked `/skill:` custom prompt is the run's initiator
				// (user attribution), so it seeds the prompt→yield delta like a user
				// message does.
				if (message.role === "custom" && isUserTurnInitiator(message as CustomMessage)) {
					this.#turnStartedAt = message.timestamp;
					this.#turnUsage.reset();
				}
				this.#appendCustomMessage(message);
				break;
			case "compactionSummary": {
				const component = new CompactionSummaryMessageComponent(message);
				this.#trackExpandable(component);
				this.container.addChild(component);
				break;
			}
			case "branchSummary": {
				const component = new BranchSummaryMessageComponent(message);
				this.#trackExpandable(component);
				this.container.addChild(component);
				break;
			}
			case "fileMention": {
				// Indent one column to match the transcript's other rows (the viewer renders
				// body rows without an outer gutter; rows own their left pad).
				const block = buildFileMentionBlock(message.files, 1);
				if (block.children.length > 0) this.container.addChild(block);
				break;
			}
			default:
				message satisfies never;
		}
	}

	/** Prompt→yield wall time for the current turn, or undefined when unknown. */
	#turnElapsedMs(message: Extract<AgentMessage, { role: "assistant" }>): number | undefined {
		return turnElapsedMs(this.#turnStartedAt, message);
	}

	#createAssistant(message: AssistantMessage): AssistantMessageComponent {
		const component = new AssistantMessageComponent(
			undefined,
			this.#deps.hideThinkingBlock?.() ?? false,
			() => this.#deps.requestRender(),
			this.#deps.thinkingRenderers?.(),
			this.#deps.ui.imageBudget,
			this.#deps.proseOnlyThinking?.() ?? true,
			this.#deps.linkTargets,
			this.#deps.expandThinkingBlocks?.() ?? false,
		);
		component.pickReactionTarget(this.container.children);
		component.updateContent(message);
		this.#mountProse(component);
		return component;
	}

	/** The block a tool call opens: a reply for a built-in `write` to a reply URL (`out://`), a tool card for anything else. */
	#createTool(id: string, name: string, args: Record<string, unknown>): ToolExecutionHandle {
		const tool = this.#deps.getTool?.(name);
		const renderName = toolRenderName(name, tool);
		const builtIn = this.#deps.isBuiltInTool?.(renderName) ?? true;
		if (builtIn && isReplyWrite(renderName, args) === true) {
			const reply = new ReplyWriteComponent({
				requestRender: () => this.#deps.requestRender(),
				imageBudget: this.#deps.ui.imageBudget,
				linkTargets: this.#deps.linkTargets,
			});
			this.#mountProse(reply);
			return reply;
		}
		const component = new ToolExecutionComponent(
			renderName,
			args,
			{
				useBuiltInRenderer: builtIn,
				showImages: this.#preferences.showImages,
			},
			tool,
			this.#deps.ui,
			this.#deps.cwd,
			id,
		);
		this.#trackExpandable(component);
		this.container.addChild(component);
		return component;
	}

	#retractTool(id: string, state: StreamingAssistant): void {
		const background = this.#backgroundTools.has(id);
		const component = background ? undefined : (state.tools.get(id) ?? this.#pendingTools.get(id));
		if (component instanceof ReadToolGroupComponent) {
			if (component.removeEntry(id)) {
				component.seal();
				this.container.removeChild(component);
				if (this.#readGroup === component) this.#readGroup = null;
			}
		} else if (component) {
			component.seal();
			this.container.removeChild(component);
		}
		if (component && !this.container.children.includes(component)) {
			this.#expandables = this.#expandables.filter(candidate => candidate !== component);
			component.dispose?.();
		}
		const segment = state.after.get(id);
		if (segment) {
			segment.markTranscriptBlockFinalized();
			this.container.removeChild(segment);
			if (!this.container.children.includes(segment)) {
				this.#expandables = this.#expandables.filter(candidate => candidate !== segment);
				segment.dispose();
			}
		}
		state.tools.delete(id);
		state.after.delete(id);
		state.seenTools.delete(id);
		if (background) return;
		this.#pendingTools.delete(id);
		this.#readArgs.delete(id);
		this.#heldResults.delete(id);
		this.#heldPreviews.delete(id);
		this.#unclaimedTools.delete(id);
		this.#completedTools.add(id);
	}

	#renderAssistant(message: AssistantMessage, previous?: StreamingAssistant, transient = false): StreamingAssistant {
		const timeline = splitAssistantMessageToolTimeline(message);
		const state = previous ?? {
			before: this.#createAssistant(timeline.beforeTools),
			after: new Map<string, AssistantMessageComponent>(),
			tools: new Map<string, ToolExecutionHandle>(),
			seenTools: new Set<string>(),
			idsByIndex: new Map<number, string>(),
			hasVisibleContent: false,
		};
		const finalCallIds = transient ? undefined : new Set<string>();
		if (finalCallIds) {
			for (const call of message.content) {
				if (call.type === "toolCall") finalCallIds.add(call.id);
			}
		}
		if (!transient && (message.stopReason === "aborted" || message.stopReason === "error")) {
			// Cancellation filters incomplete calls, shifting content indices. Do not
			// mistake a surviving sibling at a shifted index for an id migration.
			for (const id of state.seenTools) {
				if (!finalCallIds?.has(id)) {
					this.#retractTool(id, state);
				}
			}
			state.idsByIndex.clear();
		}
		reconcileStreamedToolCallIds(message.content, state.idsByIndex, (oldId, newId) => {
			const component = state.tools.get(oldId);
			if (component && !state.tools.has(newId)) {
				state.tools.delete(oldId);
				state.tools.set(newId, component);
				if (component instanceof ReadToolGroupComponent) component.renameEntry(oldId, newId);
			}
			const pending = this.#pendingTools.get(oldId);
			if (pending && !this.#pendingTools.has(newId)) {
				this.#pendingTools.delete(oldId);
				this.#pendingTools.set(newId, pending);
			}
			const args = this.#readArgs.get(oldId);
			if (args) {
				this.#readArgs.delete(oldId);
				this.#readArgs.set(newId, args);
			}
			const segment = state.after.get(oldId);
			if (segment) {
				state.after.delete(oldId);
				state.after.set(newId, segment);
			}
			const preview = this.#heldPreviews.get(oldId);
			if (preview !== undefined) {
				this.#heldPreviews.delete(oldId);
				this.#heldPreviews.set(newId, preview);
			}
			const result = this.#heldResults.get(oldId);
			if (result) {
				this.#heldResults.delete(oldId);
				this.#heldResults.set(newId, { ...result, message: { ...result.message, toolCallId: newId } });
			}
			if (state.seenTools.delete(oldId)) state.seenTools.add(newId);
			if (this.#completedTools.delete(oldId)) this.#completedTools.add(newId);
			if (this.#backgroundTools.delete(oldId)) this.#backgroundTools.add(newId);
		});
		if (finalCallIds) {
			for (const id of state.seenTools) {
				if (!finalCallIds.has(id)) this.#retractTool(id, state);
			}
		}
		if (!state.hasVisibleContent && assistantHasVisibleContent(message)) {
			this.#readGroup?.finalize();
			this.#readGroup = null;
			state.hasVisibleContent = true;
		}
		const assistantComponent = state.before;
		assistantComponent.updateContent(timeline.beforeTools, { transient });
		let lastAssistantComponent = assistantComponent;
		let timelineAnchor: Component = assistantComponent;
		if (!previous && !transient) assistantComponent.setServedModelMismatch(this.#servedModelTracker.check(message));
		const errorPresentation = resolveAssistantErrorPresentation(message);
		const errorMessage = !transient && errorPresentation.kind === "full" ? errorPresentation.text : undefined;
		for (const call of message.content) {
			if (call.type !== "toolCall") continue;
			const tool = this.#deps.getTool?.(call.name);
			const renderName = toolRenderName(call.name, tool);
			const args = this.#deps.toolArgs?.(call, renderName) ?? call.arguments;
			const unclaimed = this.#unclaimedTools.get(call.id);
			if (!state.seenTools.has(call.id)) {
				// Provider ids identify calls within one assistant snapshot, not the
				// whole session. A newly observed call owns its own completion.
				if (!unclaimed && this.#completedTools.delete(call.id) && renderName === "read") {
					this.#readGroup?.finalize();
					this.#readGroup = null;
				}
				this.#resolveWaitingPoll(renderName);
				state.seenTools.add(call.id);
			}
			const afterToolSegment = timeline.afterToolCalls.get(call.id);
			let component = state.tools.get(call.id) ?? unclaimed ?? this.#pendingTools.get(call.id);
			if (component && !state.tools.has(call.id)) {
				state.tools.set(call.id, component);
				this.#unclaimedTools.delete(call.id);
				if (unclaimed) {
					// The execution event may precede the leading assistant snapshot.
					const children = this.container.children;
					const beforeIndex = children.indexOf(state.before);
					const toolIndex = children.indexOf(component);
					if (toolIndex >= 0 && beforeIndex > toolIndex) {
						children.splice(beforeIndex, 1);
						children.splice(toolIndex, 0, state.before);
					}
				}
			}
			if (!component && renderName === "read" && transient && !readArgsHaveTarget(args)) {
				this.#readArgs.set(call.id, normalizeToolArgs(args));
				continue;
			}
			// A streamed `write` whose path could still grow into a reply URL opens neither a
			// reply nor a card until its path decides which.
			if (
				!component &&
				transient &&
				(this.#deps.isBuiltInTool?.(renderName) ?? true) &&
				isReplyWrite(renderName, args) === undefined
			) {
				continue;
			}
			if (!component && renderName === "read" && readArgsCollapseIntoGroup(args)) {
				if (errorMessage || afterToolSegment || transient) {
					component = this.#ensureReadGroup();
					state.tools.set(call.id, component);
				} else {
					this.#readArgs.set(call.id, normalizeToolArgs(args));
				}
			} else if (!component) {
				this.#readGroup?.finalize();
				this.#readGroup = null;
				component = this.#createTool(call.id, call.name, args);
				state.tools.set(call.id, component);
				// A provider-id split can materialize an earlier sibling after the
				// last sibling's retained card. Insert at the assistant timeline cursor.
				const children = this.container.children;
				const anchorIndex = children.indexOf(timelineAnchor);
				if (anchorIndex >= 0 && anchorIndex < children.length - 2) {
					children.splice(children.length - 1, 1);
					children.splice(anchorIndex + 1, 0, component);
				}
			}
			if (component) {
				timelineAnchor = component;
				this.#readArgs.delete(call.id);
				component.updateArgs(args, call.id);
				if (!transient) component.setArgsComplete(call.id);
				if (errorMessage) {
					component.updateResult(
						{ content: [{ type: "text", text: errorMessage }], isError: true },
						false,
						call.id,
					);
					this.#pendingTools.delete(call.id);
					// The agent loop still emits synthetic execution/result events for
					// this call; its already-settled card owns that completion.
					this.#completedTools.add(call.id);
				} else if (!this.#completedTools.has(call.id)) {
					this.#pendingTools.set(call.id, component);
					this.#consumeHeld(call.id);
				}
			}
			if (afterToolSegment && assistantHasVisibleContent(afterToolSegment)) {
				let segment = state.after.get(call.id);
				if (!segment) {
					segment = this.#createAssistant(afterToolSegment);
					state.after.set(call.id, segment);
					if (component) {
						const children = this.container.children;
						const anchorIndex = children.indexOf(component);
						if (anchorIndex >= 0 && anchorIndex < children.length - 2) {
							children.splice(children.length - 1, 1);
							children.splice(anchorIndex + 1, 0, segment);
						}
					}
				}
				segment.updateContent(afterToolSegment, { transient });
				lastAssistantComponent = segment;
				timelineAnchor = segment;
			}
		}
		if (!transient) {
			assistantComponent.markTranscriptBlockFinalized();
			for (const component of state.after.values()) component.markTranscriptBlockFinalized();
			if (this.#preferences.cacheMissMarker) {
				const invalidation = detectCacheInvalidation(this.#lastAssistantUsage, message.usage);
				if (invalidation) assistantComponent.setCacheInvalidation(invalidation);
			}
			if (previous) assistantComponent.setServedModelMismatch(this.#servedModelTracker.check(message));
			if (message.usage.cacheRead + message.usage.cacheWrite + message.usage.input > 0) {
				this.#lastAssistantUsage = message.usage;
			}
			const turnUsage = this.#turnUsage.add(message, this.#turnStartedAt);
			if (turnUsage) lastAssistantComponent.setTurnUsage(turnUsage);
			this.#pendingUsage =
				this.#preferences.showTokenUsage && assistantUsageIsBilled(message.usage) ? message.usage : undefined;
			this.#pendingUsageDuration = message.duration;
			this.#pendingUsageTtft = message.ttft;
			this.#pendingUsageTimestamp = message.timestamp;
			this.#pendingReadUsageCallIds = this.#pendingUsage ? groupedReadUsageCallIds(message) : undefined;
			this.#pendingUsageElapsedMs =
				this.#pendingUsage && this.#preferences.showTurnTime ? this.#turnElapsedMs(message) : undefined;
		}
		return state;
	}

	#appendToolResult(message: Extract<AgentMessage, { role: "toolResult" }>): void {
		if (this.#completedTools.has(message.toolCallId)) return;
		const pending = this.#pendingTools.get(message.toolCallId);
		const isReadGroupResult = message.toolName === "read" && (!pending || pending instanceof ReadToolGroupComponent);
		if (isReadGroupResult) {
			let component = pending;
			if (!component) {
				const group = this.#ensureReadGroup();
				const args = this.#readArgs.get(message.toolCallId);
				if (args) group.updateArgs(args, message.toolCallId);
				component = group;
			}
			component.updateResult(message, false, message.toolCallId);
			this.#pendingTools.delete(message.toolCallId);
			this.#readArgs.delete(message.toolCallId);
			this.#completedTools.add(message.toolCallId);
			return;
		}
		for (const reply of toolResultReplies(message.details)) {
			this.#mountProse(
				new AssistantMessageComponent(
					replyDisplayMessage(reply),
					false,
					() => this.#deps.requestRender(),
					[],
					this.#deps.ui.imageBudget,
					true,
					this.#deps.linkTargets,
				),
			);
		}
		if (!pending) return;
		const asyncState = (message.details as { async?: { state?: string } } | undefined)?.async?.state;
		if (message.toolName === "task" && asyncState === "running") {
			pending.updateResult(message, true, message.toolCallId);
			pending.parkAsBackground();
			this.#backgroundTools.add(message.toolCallId);
			return;
		}
		pending.updateResult(message, false, message.toolCallId);
		this.#pendingTools.delete(message.toolCallId);
		this.#backgroundTools.delete(message.toolCallId);
		this.#completedTools.add(message.toolCallId);
		if (message.toolName === "wait" && pending instanceof ToolExecutionComponent && pending.isDisplaceableBlock()) {
			this.#waitingPoll = pending;
		} else if (
			message.toolName === "todo" &&
			pending instanceof ToolExecutionComponent &&
			pending.canBeDisplacedBy("todo")
		) {
			// A successful todo result supersedes the prior live snapshot. Failed
			// follow-ups return false from canBeDisplacedBy("todo"), so the
			// last-good panel stays on screen.
			this.#resolveTodoSnapshot("todo");
			this.#todoSnapshot = pending;
		}
	}
	#appendCustomMessage(message: Extract<AgentMessage, { role: "custom" | "hookMessage" }>): void {
		if (!message.display) return;
		if (message.customType === "async-result") {
			const component = buildAsyncResultBlock(message);
			this.container.addChild(component);
			return;
		}
		if (message.customType === LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE) {
			const details = (message as CustomMessage<{ files?: LateDiagnosticsFile[] }>).details;
			// Native: into the edit/write frames they belong to; the rest stand alone.
			const files = routeLateDiagnostics(this.container.children, details?.files ?? []);
			if (files.length === 0) return;
			const component = new LateDiagnosticsMessageComponent(files);
			this.#trackExpandable(component);
			this.container.addChild(component);
			return;
		}
		if (message.customType === COLLAB_PROMPT_MESSAGE_TYPE) {
			this.container.addChild(new CollabPromptMessageComponent(message as CustomMessage<CollabPromptDetails>));
			return;
		}
		if (message.customType === SKILL_PROMPT_MESSAGE_TYPE) {
			const component = new SkillMessageComponent(message as CustomMessage<SkillPromptDetails>);
			this.#trackExpandable(component);
			this.container.addChild(component);
			return;
		}
		if (
			message.customType === "irc:incoming" ||
			message.customType === "irc:autoreply" ||
			message.customType === "irc:relay" ||
			message.customType === "irc:workpool"
		) {
			this.container.addChild(buildIrcMessageCard(message, () => this.#expanded));
			return;
		}
		if (message.customType === "advisor") {
			const details = (message as CustomMessage<AdvisorMessageDetails>).details;
			const card = createAdvisorMessageCard(details, () => this.#expanded, theme);
			// Tracked so a transcript-wide toggle also clears a per-card native toggle.
			this.#trackExpandable(card);
			this.container.addChild(card);
			return;
		}
		if (message.customType === LAUNCH_COMPLETION_MESSAGE_TYPE) {
			this.container.addChild(buildLaunchCompletionBlock(message));
			return;
		}
		if (message.customType === BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE) {
			this.container.addChild(createBackgroundTanDispatchBlock(message as CustomMessage<unknown>));
			return;
		}
		const handoffComponent = createHandoffSummaryMessageComponent(message as CustomMessage<unknown>, this.#expanded);
		if (handoffComponent) {
			this.#trackExpandable(handoffComponent);
			this.container.addChild(handoffComponent);
			return;
		}
		const component = new CustomMessageComponent(
			message as CustomMessage<unknown>,
			this.#deps.getMessageRenderer?.(message.customType),
		);
		this.#trackExpandable(component);
		this.container.addChild(component);
	}
}
