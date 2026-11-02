import type { Model } from "@oh-my-pi/pi-ai";
import { describeWorkingRow, type WorkingRowSpec } from "@oh-my-pi/pi-tui/components/loader";
import type { NativeBackend } from "@oh-my-pi/pi-tui/native/backend";
import { node } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import type { TspTransport } from "@oh-my-pi/pi-tui/native/transport";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import type { AgentHubRegistry } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import { ModelPickerComponent, type ResolvedRoleModel } from "@oh-my-pi/pi-tui/overlays/model-picker";
import { SessionObserverRegistry, type EventBusLike } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { ThinkingSelectorComponent } from "@oh-my-pi/pi-tui/overlays/thinking-selector";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line/component";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { logger } from "@oh-my-pi/pi-utils";
import { cfgCycleOrder } from "../../config/model-settings";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { registerPersistedSubagents, sessionFileBelongsToRoot } from "../../registry/persisted-agents";
import type { AgentSession } from "../../session/agent-session";
import type { AgentSessionEvent } from "../../session/agent-session-events";
import { cfgExpandThinkingBlocks, cfgHideThinkingBlock, cfgProseOnlyThinking } from "../../session/settings";
import { createAgentHubRuntime } from "../agent-hub-runtime";
import { createModelBrowserSource } from "../model-browser-source";
import { applySessionModel } from "../session-model-switch";
import { createStatusLineHost, type StatusLineHostSession } from "../status-line-host";
import { AcpViewerHost } from "./acp-viewer-host";
import { getAcpInteractionProjection } from "./acp-interactions";

export interface AcpPresentationRuntime {
	eventBus?: EventBusLike;
	subagentEventBus?: EventBusLike;
}
const runtimes = new WeakMap<AgentSession, AcpPresentationRuntime>();

/** Bind the real root-scoped task buses when the ACP session factory creates them. */
export function bindAcpPresentationRuntime(session: AgentSession, runtime: AcpPresentationRuntime): void {
	runtimes.set(session, runtime);
}

/** Shared facts and execution state, with independently owned viewer component trees. */
export class AcpCockpit implements Component {
	readonly #status: StatusLineComponent<StatusLineHostSession>;
	readonly #observers = new SessionObserverRegistry();
	readonly #registry: AgentHubRegistry<AgentRef>;
	readonly #viewers = new Map<string, AcpViewerHost>();
	readonly #unsubscribers: Array<() => void> = [];
	readonly #persistedReady: Promise<void>;
	#working: WorkingRowSpec | undefined;
	#disposed = false;

	constructor(
		readonly session: AgentSession,
		readonly backend: NativeBackend,
		readonly transport: TspTransport,
		readonly requestRender: () => void,
	) {
		this.#status = new StatusLineComponent<StatusLineHostSession>(session, createStatusLineHost(session.settings));
		this.#status.watchBranch(requestRender);
		const sessionFile = session.sessionManager.getSessionFile();
		this.#observers.setMainSession(sessionFile);
		const runtime = runtimes.get(session);
		const bus = runtime?.eventBus ?? runtime?.subagentEventBus;
		if (bus) this.#observers.subscribeToEventBus(bus, runtime?.subagentEventBus ?? bus);
		const registry = AgentRegistry.global();
		const belongs = (ref: AgentRef): boolean => {
			if (ref.id === MAIN_AGENT_ID) return ref.session === session;
			return ref.sessionFile
				? Boolean(sessionFile && sessionFileBelongsToRoot(ref.sessionFile, sessionFile))
				: this.#observers.getSession(ref.id) !== undefined;
		};
		this.#registry = {
			list: () => registry.list().filter(belongs),
			get: id => {
				const ref = registry.get(id);
				return ref && belongs(ref) ? ref : undefined;
			},
			onChange: listener => registry.onChange(listener),
		};
		const changed = () => {
			this.#status.setRunningSubagents(
				this.#registry
					.list()
					.filter(ref => ref.kind !== "main" && ref.status === "running")
					.map(ref => ref.id),
			);
			this.requestRender();
		};
		this.#unsubscribers.push(registry.onChange(changed), this.#observers.onChange(changed));
		changed();
		// Discover saved agents once per session so the hub remains reachable after
		// a restart, before any viewer has opened it.
		this.#persistedReady = registerPersistedSubagents(registry, sessionFile, {
			shouldContinue: () => !this.#disposed,
		}).catch(error => {
			logger.warn("ACP cockpit failed to load saved agents", { error });
		});
		if (session.isStreaming || session.isCompacting || session.isRetrying) {
			const user = session.messages.findLast(message => message.role === "user");
			this.#working = {
				label: session.isCompacting ? "Compacting context…" : "Working…",
				startedAt: session.isCompacting ? Date.now() : (user?.timestamp ?? Date.now()),
				interruptKey: "escape",
				...(session.isCompacting ? { variant: { kind: "compaction" } } : {}),
			};
			this.#status.markActivityStart();
		}
	}

	render(): readonly string[] {
		return [];
	}
	invalidate(): void {
		this.#status.invalidate();
		for (const viewer of this.#viewers.values()) viewer.invalidate();
	}

	describe(cx: DescribeContext): NativeNode {
		const facts = this.#status.describeComposerFacts();
		const chips: NativeChild[] = [
			node(
				"row",
				{
					role: "omp.composer.model",
					gap: "xs",
					align: "center",
					tone: facts.model.tone,
					title: "Switch model",
					actions: { click: "model" },
				},
				[
					node("icon", { name: "model" }),
					node("text", { spans: facts.model.spans, wrap: "none" }),
					node("icon", { name: "chev" }),
				],
				"model",
			),
			node(
				"row",
				{
					role: "omp.composer.effort",
					gap: "xs",
					align: "center",
					title: "Thinking effort",
					actions: { click: "effort" },
				},
				[
					node("effort", { level: this.session.thinkingLevel ?? "off" }),
					node("text", { text: this.session.configuredThinkingLevel() ?? "off" }),
				],
				"effort",
			),
			facts.extras,
			facts.usage,
		];
		const agents = this.#registry.list().filter(ref => ref.kind !== "main").length;
		if (agents > 0)
			chips.push(
				node(
					"seg",
					{ spans: [{ t: `Agents ${agents}` }], icon: "agents", actions: { click: "agents" }, role: "omp.agents" },
					undefined,
					"agents",
				),
			);
		const children: NativeChild[] = [
			facts.context,
			node("row", { role: "omp.status", gap: "sm", align: "center" }, chips, "status"),
		];
		if (this.#working) children.push(describeWorkingRow(this.#working, cx));
		return node("col", { role: "omp.dock", gap: "xs" }, children);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		// Stop, approvals and question answers are intercepted by the host and completed over ACP.
		if (this.#disposed || event.type !== "action" || !event.viewer) return;
		if (event.act !== "model" && event.act !== "effort" && event.act !== "agents") return;
		this.viewerLeft(event.viewer);
		const viewer = new AcpViewerHost(this.transport, this.backend, event.viewer, this.requestRender);
		this.#viewers.set(event.viewer, viewer);
		const done = () => {
			if (this.#viewers.get(event.viewer!) === viewer) this.viewerLeft(event.viewer!);
		};
		if (event.act === "model") this.#modelPicker(viewer, done);
		else if (event.act === "effort") {
			viewer.mount(
				new ThinkingSelectorComponent(
					this.session.configuredThinkingLevel(),
					this.session.getAvailableEffortSelectors(),
					level => {
						if (viewer.closed) return;
						this.session.setThinkingLevel(level);
						done();
					},
					done,
				),
			);
		} else {
			viewer.mount(
				new AgentHubOverlayComponent({
					...createAgentHubRuntime({
						settings: this.session.settings,
						sessionFile: this.session.sessionManager.getSessionFile(),
					}),
					loadPersisted: () => this.#persistedReady,
					registry: this.#registry,
					observers: this.#observers,
					hubKeys: [],
					onDone: done,
					requestRender: () => viewer.requestRender(),
					ui: viewer,
					readOnlyTranscripts: true,
					sessionFile: this.session.sessionManager.getSessionFile(),
					cwd: this.session.sessionManager.getCwd(),
					getTool: name => this.session.getToolByName(name),
					isBuiltInTool: name => this.session.hasBuiltInTool(name),
					getMessageRenderer: type => this.session.extensionRunner?.getMessageRenderer(type),
					hideThinkingBlock: () => cfgHideThinkingBlock.get(this.session.settings),
					proseOnlyThinking: () => cfgProseOnlyThinking.get(this.session.settings),
					expandThinkingBlocks: () => cfgExpandThinkingBlocks.get(this.session.settings),
				}),
			);
		}
	}

	#modelPicker(viewer: AcpViewerHost, done: () => void): void {
		const session = this.session;
		const order = cfgCycleOrder.get(session.settings);
		const cycle = session.getRoleModelCycle(order);
		let applying = false;
		const apply = async (
			model: Model,
			thinkingLevel: ConfiguredThinkingLevel | undefined,
			compactFirst: boolean,
			role?: ResolvedRoleModel,
		): Promise<void> => {
			if (applying || viewer.closed || this.#disposed) return;
			applying = true;
			try {
				const switched = await getAcpInteractionProjection(session).batchConfigChanges(() =>
					applySessionModel({
						session,
						model,
						thinkingLevel,
						compactFirst,
						role,
						isCurrent: () => !this.#disposed && !viewer.closed,
						compact: async switchModel => {
							await session.compact(undefined, { beforeResume: switchModel });
							return true;
						},
					}),
				);
				if (switched) done();
			} catch (error) {
				viewer.notice(error instanceof Error ? error.message : String(error));
			} finally {
				applying = false;
			}
		};
		viewer.mount(
			new ModelPickerComponent(
				viewer,
				createModelBrowserSource(session.settings, model => session.effectiveServiceTier(model)),
				session.modelRegistry,
				session.scopedModels,
				{
					onPick: (model, _selector, { overContext }) => {
						void apply(model, undefined, overContext);
					},
					onPickRole: entry => {
						const tokens = session.getContextUsage()?.tokens ?? 0;
						void apply(
							entry.model,
							entry.thinkingLevel,
							(entry.model.contextWindow ?? 0) > 0 && tokens > (entry.model.contextWindow ?? 0),
							entry,
						);
					},
					onCancel: done,
				},
				{
					currentSelector: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
					currentContextTokens: session.getContextUsage()?.tokens ?? 0,
					quickRoles: cycle?.models,
					quickRoleOrder: order,
					currentQuickRole: cycle?.models[cycle.currentIndex]?.role,
				},
			),
		);
	}

	handleEvent(event: AgentSessionEvent): void {
		this.#status.invalidate();
		switch (event.type) {
			case "agent_start":
				this.#working = {
					label: "Working…",
					startedAt: this.#working?.startedAt ?? Date.now(),
					interruptKey: "escape",
				};
				this.#status.markActivityStart();
				break;
			case "agent_end":
				if (event.isTerminal === false && !event.yielded) {
					this.#working = {
						label: "Waiting…",
						startedAt: this.#working?.startedAt ?? Date.now(),
						interruptKey: "escape",
					};
				} else {
					this.#working = undefined;
					this.#status.markActivityEnd();
				}
				break;
			case "manual_compaction_start":
			case "auto_compaction_start":
				this.#working = {
					label: "Compacting context…",
					startedAt: Date.now(),
					variant: { kind: "compaction" },
					interruptKey: "escape",
				};
				this.#status.markActivityStart();
				break;
			case "auto_retry_start":
				this.#working = {
					label: `Retrying · attempt ${event.attempt} of ${event.maxAttempts}`,
					startedAt: Date.now(),
					interruptKey: "escape",
					variant: { kind: "retry", attempt: event.attempt, max: event.maxAttempts, delayMs: event.delayMs },
				};
				this.#status.markActivityStart();
				break;
			case "auto_retry_end":
			case "manual_compaction_end":
			case "auto_compaction_end":
				this.#working = this.session.isStreaming
					? { label: "Working…", startedAt: Date.now(), interruptKey: "escape" }
					: undefined;
				if (!this.#working) this.#status.markActivityEnd();
				break;
		}
	}

	viewerLeft(viewer: string): void {
		const host = this.#viewers.get(viewer);
		if (!host) return;
		this.#viewers.delete(viewer);
		host.dispose();
		this.requestRender();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const viewer of this.#viewers.values()) viewer.dispose();
		this.#viewers.clear();
		for (const unsubscribe of this.#unsubscribers) unsubscribe();
		this.#observers.dispose();
		this.#status.dispose();
	}
}
