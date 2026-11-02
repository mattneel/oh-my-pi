import { ToolExecutionComponent, type ToolPermissionState } from "@oh-my-pi/pi-tui/chat/tool-execution";
import type { NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import type { TspQuestion, TspQuestionsProps } from "@oh-my-pi/pi-wire";
import { isRecord } from "@oh-my-pi/pi-utils";
import type {
	CreateElicitationRequest,
	CreateElicitationResponse,
	ElicitationContentValue,
} from "@oh-my-pi/pi-utils/acp";
import type { AgentSession } from "../../session/agent-session";
import type {
	ClientBridgePermissionOption,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
} from "../../session/client-bridge";

const projections = new WeakMap<AgentSession, AcpInteractionProjection>();

/** ACP owns completion; this store only projects requests and their settled results. */
export function getAcpInteractionProjection(session: AgentSession): AcpInteractionProjection {
	let projection = projections.get(session);
	if (!projection) {
		projection = new AcpInteractionProjection();
		projections.set(session, projection);
	}
	return projection;
}

type FormRequest = Extract<CreateElicitationRequest, { mode: "form" }>;

function questionItems(request: FormRequest): TspQuestion[] {
	const { properties, required } = request.requestedSchema;
	return Object.entries(properties)
		.filter(([id]) => !id.endsWith("__other"))
		.map(([id, property]) => {
			const multi = property.type === "array";
			const items = isRecord(property.items) ? property.items : undefined;
			const alternatives = property.oneOf ?? items?.anyOf;
			let choices: TspQuestion["choices"];
			if (Array.isArray(alternatives)) {
				choices = alternatives.flatMap(option => {
					if (!isRecord(option) || typeof option.const !== "string") return [];
					const recommended =
						property.default === option.const ||
						(Array.isArray(property.default) && property.default.includes(option.const));
					const detail = [
						typeof option.description === "string" ? option.description : "",
						recommended ? "Recommended" : "",
					]
						.filter(Boolean)
						.join(" · ");
					return [
						{
							value: option.const,
							label: typeof option.title === "string" ? option.title : option.const,
							...(detail ? { detail } : {}),
						},
					];
				});
			} else if (Array.isArray(property.enum)) {
				choices = property.enum.filter((value): value is string => typeof value === "string");
			} else if (property.type === "boolean") {
				choices = [
					{ value: "true", label: "Yes" },
					{ value: "false", label: "No" },
				];
			}
			return {
				id,
				prompt: property.title ?? request.message,
				...(property.description ? { description: property.description } : {}),
				...(choices ? { choices } : {}),
				...(multi ? { multi: true } : {}),
				...(!choices || properties[`${id}__other`] ? { other: true } : {}),
				...(required?.includes(id) ? { required: true } : {}),
			};
		});
}

function formAnswers(
	request: FormRequest,
	content?: Record<string, ElicitationContentValue>,
): Record<string, string | readonly string[]> {
	const answers: Record<string, string | readonly string[]> = {};
	for (const [id, property] of Object.entries(request.requestedSchema.properties)) {
		if (id.endsWith("__other")) continue;
		const value = content ? content[id] : property.default;
		if (typeof value === "string" || (Array.isArray(value) && value.every(item => typeof item === "string")))
			answers[id] = value;
		else if (typeof value === "number" || typeof value === "boolean") answers[id] = String(value);
		const other = content?.[`${id}__other`];
		if (typeof other === "string" && other.trim()) {
			const selected = answers[id];
			answers[id] =
				property.type === "array" ? [...(Array.isArray(selected) ? selected : []), other.trim()] : other.trim();
		}
	}
	return answers;
}

export class AcpQuestionComponent implements Component {
	readonly toolCallId: string | undefined;
	readonly #request: FormRequest;
	#node: NativeNode;
	constructor(id: number, request: FormRequest, toolCallId?: string) {
		this.toolCallId = toolCallId;
		this.#request = request;
		this.#node = {
			k: "questions",
			p: {
				key: `question:${id}`,
				role: "omp.questions",
				items: questionItems(request),
				answers: formAnswers(request),
				variant: "list",
				hint: request.message,
				submit: "Submit",
			},
		};
	}
	settle(response: CreateElicitationResponse | undefined): void {
		const accepted = response?.action === "accept" && response.content !== undefined;
		const props: TspQuestionsProps = {
			...(this.#node.p as TspQuestionsProps),
			answers: accepted ? formAnswers(this.#request, response.content) : {},
			readonly: true,
			hint: accepted ? "Answered" : "Cancelled",
		};
		this.#node = { ...this.#node, k: "questions", p: props };
	}
	describe(): NativeNode {
		return this.#node;
	}
	render(): readonly string[] {
		return [];
	}
	invalidate(): void {}
}

export class AcpInteractionProjection {
	readonly permissions = new Map<string, ToolPermissionState | undefined>();
	readonly questions: AcpQuestionComponent[] = [];
	readonly #listeners = new Set<() => void>();
	readonly #pendingPermissions = new Map<string, object>();
	#revision = 0;
	#decorated: { main: readonly NativeChild[]; revision: number; result: readonly NativeChild[] } | undefined;
	#configBatches = 0;
	#pendingConfigUpdate: (() => void) | undefined;

	/** One picker operation may change model and effort through several session events. */
	async batchConfigChanges<T>(apply: () => Promise<T>): Promise<T> {
		this.#configBatches++;
		try {
			return await apply();
		} finally {
			if (--this.#configBatches === 0) {
				const notify = this.#pendingConfigUpdate;
				this.#pendingConfigUpdate = undefined;
				notify?.();
			}
		}
	}
	deferConfigUpdate(notify: () => void): boolean {
		if (this.#configBatches === 0) return false;
		this.#pendingConfigUpdate = notify;
		return true;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	#changed(): void {
		this.#revision++;
		for (const listener of this.#listeners) listener();
	}
	permissionRequested(
		toolCall: ClientBridgePermissionToolCall,
		options: ClientBridgePermissionOption[],
	): (outcome?: ClientBridgePermissionOutcome) => void {
		const token = {};
		this.#pendingPermissions.set(toolCall.toolCallId, token);
		const label = (kind: ClientBridgePermissionOption["kind"]) => options.find(option => option.kind === kind)?.name;
		this.permissions.set(toolCall.toolCallId, {
			status: "ask",
			confirm: "card",
			ask: {
				text: toolCall.title,
				allow: label("allow_once"),
				always: label("allow_always"),
				deny: label("reject_once") ?? label("reject_always"),
			},
		});
		this.#changed();
		return outcome => {
			if (this.#pendingPermissions.get(toolCall.toolCallId) !== token) return;
			this.#pendingPermissions.delete(toolCall.toolCallId);
			const option =
				outcome?.outcome === "selected" ? options.find(option => option.optionId === outcome.optionId) : undefined;
			const approved =
				option?.kind === "allow_once"
					? "once"
					: option?.kind === "allow_always"
						? "session"
						: option
							? "denied"
							: undefined;
			this.permissions.set(toolCall.toolCallId, approved ? { approved } : undefined);
			this.#changed();
		};
	}
	questionRequested(
		id: number,
		request: FormRequest,
		toolCallId?: string,
	): (response?: CreateElicitationResponse) => void {
		const question = new AcpQuestionComponent(id, request, toolCallId);
		this.questions.push(question);
		this.#changed();
		let settled = false;
		return response => {
			if (settled) return;
			settled = true;
			question.settle(response);
			this.#changed();
		};
	}
	/** Keep each question directly after its asking tool, including after a transcript rebuild. */
	decorate(main: readonly NativeChild[]): readonly NativeChild[] {
		if (this.questions.length === 0) return main;
		if (this.#decorated?.main === main && this.#decorated.revision === this.#revision) return this.#decorated.result;
		const remaining = new Set(this.questions);
		const result: NativeChild[] = [];
		for (const child of main) {
			result.push(child);
			if (!(child instanceof ToolExecutionComponent)) continue;
			for (const question of remaining) {
				if (question.toolCallId !== child.toolCallId) continue;
				result.push(question);
				remaining.delete(question);
			}
		}
		result.push(...remaining);
		this.#decorated = { main, revision: this.#revision, result };
		return result;
	}
}
