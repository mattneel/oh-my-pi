import type { AgentMessage, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { ImageBudget } from "@oh-my-pi/pi-tui/components/image";
import { NativeBackend, type NativeHost } from "@oh-my-pi/pi-tui/native/backend";
import type { TspHello } from "@oh-my-pi/pi-tui/native/encode";
import { connectTspTransport, type TspTransport } from "@oh-my-pi/pi-tui/native/transport";
import { STDOUT_BACKLOG_CLEAR_BYTES } from "@oh-my-pi/pi-tui/terminal";
import { onTerminalAppearanceChange } from "@oh-my-pi/pi-tui/theme/theme";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { logger } from "@oh-my-pi/pi-utils";
import { deobfuscateAgentMessages } from "../../secrets/message-transform";
import type { AgentSession } from "../../session/agent-session";
import type { AgentSessionEvent } from "../../session/agent-session-events";
import { cfgExpandThinkingBlocks, cfgHideThinkingBlock, cfgProseOnlyThinking } from "../../session/settings";
import { sameMessageContent, sessionMessagePersistenceKey } from "../../session/turn-persistence";
import { decodeStreamedToolArgs, streamingStringKeysForTool } from "../controllers/tool-args-reveal";
import {
	cfgDisplayAdvisorCollapsedLines,
	cfgDisplayCacheMissMarker,
	cfgDisplayCollapseCompacted,
	cfgDisplayHideToolActivity,
	cfgDisplayShowTokenUsage,
	cfgDisplayShowTurnTime,
	cfgTerminalShowImages,
} from "../settings";
import { cfgReadToolResultPreview } from "../../tools/settings";
import { AcpCockpit } from "./acp-cockpit";
import { type AcpInteractionProjection, getAcpInteractionProjection } from "./acp-interactions";

const ACP_TSP_INPUT_LIMITS = {
	maxMessageBytes: 16 * 1024 * 1024,
	maxPendingBytes: 16 * 1024 * 1024,
	maxPendingMessages: 1024,
};

/** One semantic transcript consumer. ACP remains the owner of execution and elicitation. */
export class AcpPresentation {
	readonly #transport: TspTransport;
	readonly #backend: NativeBackend;
	readonly #viewersEnabled: boolean;
	#cockpit: AcpCockpit | undefined;
	#interactions: AcpInteractionProjection | undefined;
	#unsubscribeInteractions: (() => void) | undefined;
	readonly imageBudget = new ImageBudget(0, () => this.requestRender());
	lastFrameCostMs = 0;
	#builder: ChatTranscriptBuilder | undefined;
	#session: AgentSession | undefined;
	#sessionId: string | undefined;
	#unsubscribe: (() => void) | undefined;
	#unsubscribeInput: (() => void) | undefined;
	#focused: Component | null = null;
	#messages = new Map<string, AgentMessage[]>();
	#renderPending = false;
	#renderRetry: NodeJS.Timeout | undefined;
	#closed = false;
	#closePromise: Promise<void> | undefined;

	static async connect(target: number | string): Promise<AcpPresentation> {
		const transport = await connectTspTransport(target);
		try {
			const hello = await transport.hello;
			return new AcpPresentation(transport, hello);
		} catch (error) {
			await transport.close();
			throw error;
		}
	}

	constructor(transport: TspTransport, hello: TspHello) {
		this.#transport = transport;
		this.#viewersEnabled = hello.features?.includes("viewers") ?? false;
		if (transport.appearance) onTerminalAppearanceChange(transport.appearance);
		const host: NativeHost = {
			terminal: transport,
			describeSurface: () => {
				const main = this.#builder?.container.nativeBlocks() ?? [];
				return { main: this.#interactions?.decorate(main) ?? main, dock: this.#cockpit ? [this.#cockpit] : [] };
			},
			overlays: () => [],
			focused: () => this.#focused,
			focusFromPointer: (owners, field) => {
				this.#focused = field ?? owners[0] ?? null;
			},
			requestRender: () => this.requestRender(),
			viewerLeft: viewer => this.#cockpit?.viewerLeft(viewer),
			appearanceChanged: dark => {
				onTerminalAppearanceChange(dark ? "dark" : "light");
				this.#builder?.container.invalidate();
				this.#cockpit?.invalidate();
				this.requestRender();
			},
			motionChanged: () => {
				this.#builder?.container.invalidate();
				this.#cockpit?.invalidate();
				this.requestRender();
			},
			invalidate: () => {
				this.#builder?.container.invalidate();
				this.#cockpit?.invalidate();
			},
		};
		this.#backend = new NativeBackend(host, hello, { inputLimits: ACP_TSP_INPUT_LIMITS });
		this.#backend.start();
		this.#unsubscribeInput = transport.onInput(sequence => {
			try {
				// Paint pending changes when output permits; keep replies/ACKs flowing while a paint is deferred.
				if (this.#renderPending) this.#render();
				this.#backend.handleInput(sequence);
			} catch (error) {
				this.#fail(error);
			}
		});
		void transport.closed.then(() => {
			if (this.#closed) return;
			logger.warn("ACP TSP peer disconnected; ACP control remains active");
			void this.close();
		});
	}

	/** Select the most recently created, loaded, resumed, forked or prompted ACP session. */
	showSession(session: AgentSession, refresh = false): void {
		if (this.#closed || (!refresh && session === this.#session && session.sessionId === this.#sessionId)) return;
		try {
			const preserveCockpit = session === this.#session && session.sessionId === this.#sessionId;
			this.#detach(preserveCockpit);
			this.#session = session;
			this.#sessionId = session.sessionId;
			const builder = new ChatTranscriptBuilder({
				ui: this,
				nativeIdentity: this.#viewersEnabled,
				retainFullToolContent: this.#viewersEnabled,
				cwd: session.sessionManager.getCwd(),
				getTool: name => session.getToolByName(name),
				isBuiltInTool: name => session.hasBuiltInTool(name),
				getMessageRenderer: type => session.extensionRunner?.getMessageRenderer(type),
				hideThinkingBlock: () => cfgHideThinkingBlock.get(session.settings),
				proseOnlyThinking: () => cfgProseOnlyThinking.get(session.settings),
				expandThinkingBlocks: () => cfgExpandThinkingBlocks.get(session.settings),
				thinkingRenderers: () => session.extensionRunner?.getAssistantThinkingRenderers() ?? [],
				displayPreferences: {
					hideToolActivity: cfgDisplayHideToolActivity.get(session.settings),
					readToolResultPreview: cfgReadToolResultPreview.get(session.settings),
					showImages: cfgTerminalShowImages.get(session.settings),
					cacheMissMarker: cfgDisplayCacheMissMarker.get(session.settings),
					showTokenUsage: cfgDisplayShowTokenUsage.get(session.settings),
					showTurnTime: cfgDisplayShowTurnTime.get(session.settings),
					advisorCollapsedLines: cfgDisplayAdvisorCollapsedLines.get(session.settings),
				},
				toolArgs: (call, renderName) => {
					const partialJson = getStreamingPartialJson(call);
					return partialJson
						? decodeStreamedToolArgs(partialJson, {
								rawInput: call.customWireName !== undefined,
								fullArgs: call.arguments,
								streamingStringKeys: streamingStringKeysForTool(renderName, call.customWireName !== undefined),
							})
						: call.arguments;
				},
				requestRender: () => this.requestRender(),
			});
			this.#builder = builder;
			if (this.#viewersEnabled) {
				this.#cockpit ??= new AcpCockpit(session, this.#backend, this.#transport, () => this.requestRender());
				this.#interactions = getAcpInteractionProjection(session);
				const syncInteractions = () => {
					for (const [id, permission] of this.#interactions?.permissions ?? [])
						builder.setToolPermission(id, permission);
					this.requestRender();
				};
				this.#unsubscribeInteractions = this.#interactions.subscribe(syncInteractions);
				syncInteractions();
			}
			// Use the same deobfuscated, display-normalized history as interactive replay,
			// including custom display flags and summaries at their recorded positions.
			const collapseCompactedHistory = cfgDisplayCollapseCompacted.get(session.settings);
			const context = session.buildTranscriptSessionContext({
				collapseCompactedHistory,
				keepInFlightToolCalls: session.isStreaming,
			});
			// Dedup against the complete normalized view before display elision.
			// Retain content tiebreakers for distinct messages sharing a timestamp.
			const persisted =
				collapseCompactedHistory || context.messages.some(message => "strippedToolCalls" in message)
					? session.buildTranscriptSessionContext({ keepInFlightToolCalls: true }).messages
					: context.messages;
			for (const message of persisted) this.#remember(message);
			for (const message of context.messages) builder.appendMessage(message);
			// The completed agent snapshot can lead persistence during a live turn.
			// Persisted identities must not be appended again, even when display
			// normalization stripped an orphaned call or collapsed an earlier turn.
			const obfuscator = session.obfuscator;
			const completed = obfuscator ? deobfuscateAgentMessages(obfuscator, session.messages) : session.messages;
			for (const message of completed) {
				const key = sessionMessagePersistenceKey(message);
				if (!key || !this.#remember(message)) continue;
				builder.appendMessage(message);
			}
			const live = session.agent.state.streamMessage;
			if (live?.role === "assistant") builder.updateAssistant(live);
			// Cursor transforms may still replace these buffered payloads before
			// message_end; restore a preview, never a completed/deduplicated result.
			for (const message of session.agent.getPendingToolResults()) builder.updateToolResult(message, true);
			for (const event of session.activeToolExecutionUpdates()) this.#handleEvent(event, builder);
			this.#unsubscribe = session.subscribe(event => {
				if (this.#closed || this.#session !== session || this.#builder !== builder) return;
				try {
					this.#handleEvent(event, builder);
				} catch (error) {
					this.#fail(error);
				}
			});
			this.requestRender();
		} catch (error) {
			this.#fail(error);
		}
	}

	/** Rewrite only the selected document; background sessions do not steal selection. */
	refreshSession(session: AgentSession): void {
		if (session === this.#session) this.showSession(session, true);
	}

	removeSession(session: AgentSession): void {
		if (session !== this.#session) return;
		this.#detach();
		this.requestRender();
	}

	#remember(message: AgentMessage): boolean {
		const key =
			sessionMessagePersistenceKey(message) ??
			`${message.role}:${message.timestamp}:${"customType" in message ? message.customType : ""}`;
		const prior = this.#messages.get(key);
		if (prior?.some(candidate => sameMessageContent(candidate, message))) return false;
		if (prior) prior.push(message);
		else this.#messages.set(key, [message]);
		return true;
	}

	#handleEvent(event: AgentSessionEvent, builder: ChatTranscriptBuilder): void {
		this.#cockpit?.handleEvent(event);
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") builder.updateAssistant(event.message);
				else if (event.message.role !== "toolResult" && this.#remember(event.message))
					builder.appendMessage(event.message);
				break;
			case "message_update":
				if (event.message.role === "assistant") builder.updateAssistant(event.message);
				break;
			case "message_end":
				if (event.message.role === "toolResult") builder.updateToolResult(event.message);
				else if (this.#remember(event.message)) {
					if (event.message.role === "assistant") builder.updateAssistant(event.message, false);
					else builder.appendMessage(event.message);
				}
				break;
			case "tool_execution_start":
				builder.startToolExecution(event.toolCallId, event.toolName, event.args);
				break;
			case "tool_execution_update":
			case "tool_execution_end": {
				const result: AgentToolResult<unknown> =
					event.type === "tool_execution_end" ? event.result : event.partialResult;
				const message: ToolResultMessage = {
					role: "toolResult",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					content: result.content,
					details: result.details,
					isError: event.type === "tool_execution_end" ? (event.isError ?? false) : false,
					timestamp: Date.now(),
				};
				// Execution-end can precede an asynchronous Cursor result rewrite.
				// Only message_end carries the authoritative completed payload.
				builder.updateToolResult(message, true);
				break;
			}
			case "tool_stream_update":
				builder.updateToolPreview(event.toolCallId, event.update);
				break;
			case "irc_message":
				if (this.#remember(event.message)) builder.appendMessage(event.message);
				break;
			case "agent_end":
				builder.settleRun();
				break;
			case "auto_retry_end": {
				const session = this.#session;
				if (!session || !event.retryErrors?.length) break;
				// Retry recovery rewrites persisted metadata. Replay its normalized
				// presentation after dispatch rather than replacing a subscription
				// while the session is notifying its listeners.
				queueMicrotask(() => {
					if (this.#closed || this.#session !== session || this.#builder !== builder) return;
					this.refreshSession(session);
				});
				break;
			}
			case "manual_compaction_end":
			case "auto_compaction_end":
				if (event.result && this.#session) this.showSession(this.#session, true);
				break;
			default:
				// ACP owns prompts, permissions and run-state changes. Events without a
				// transcript message do not create a second interactive startup/chrome path.
				break;
		}
		this.requestRender();
	}

	requestRender(): void {
		if (this.#closed || this.#renderPending) return;
		this.#renderPending = true;
		queueMicrotask(() => {
			if (this.#closed || !this.#renderPending) return;
			try {
				this.#render();
			} catch (error) {
				this.#fail(error);
			}
		});
	}

	requestComponentRender(_component: Component): void {
		this.requestRender();
	}

	resetDisplay(): void {
		this.#builder?.container.invalidate();
		this.#cockpit?.invalidate();
		this.requestRender();
	}

	#render(): void {
		if ((this.#transport.pendingOutputBytes ?? 0) > STDOUT_BACKLOG_CLEAR_BYTES) {
			// Match the terminal TUI: retain/coalesce semantic changes rather than queuing serialized frames.
			this.#renderRetry ??= setTimeout(() => {
				this.#renderRetry = undefined;
				if (!this.#closed && this.#renderPending) {
					try {
						this.#render();
					} catch (error) {
						this.#fail(error);
					}
				}
			}, 10);
			this.#renderRetry.unref();
			return;
		}
		clearTimeout(this.#renderRetry);
		this.#renderRetry = undefined;
		this.#renderPending = false;
		const started = performance.now();
		this.#backend.render();
		this.lastFrameCostMs = performance.now() - started;
	}

	#detach(preserveCockpit = false): void {
		this.#unsubscribeInteractions?.();
		this.#unsubscribeInteractions = undefined;
		this.#interactions = undefined;
		if (!preserveCockpit) {
			this.#cockpit?.dispose();
			this.#cockpit = undefined;
		}
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#builder?.dispose();
		this.#builder = undefined;
		this.#session = undefined;
		this.#sessionId = undefined;
		this.#focused = null;
		this.#messages.clear();
	}

	#fail(error: unknown): void {
		logger.warn("ACP TSP presentation stopped; ACP control remains active", { error: String(error) });
		void this.close();
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		this.#renderPending = false;
		clearTimeout(this.#renderRetry);
		this.#renderRetry = undefined;
		this.#unsubscribeInput?.();
		this.#unsubscribeInput = undefined;
		this.#detach();
		this.#backend.stop();
		this.#closePromise = this.#transport.close();
		return this.#closePromise;
	}
}
