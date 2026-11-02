import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { ImageBudget } from "@oh-my-pi/pi-tui/components/image";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const cx: DescribeContext = {
	cols: 80,
	reduceMotion: true,
	dark: true,
	supports: () => true,
	feature: () => false,
};

function builder(cockpit = true): ChatTranscriptBuilder {
	return new ChatTranscriptBuilder({
		ui: {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
			imageBudget: new ImageBudget(0, () => {}),
			lastFrameCostMs: 0,
		},
		cwd: process.cwd(),
		nativeIdentity: cockpit,
		retainFullToolContent: cockpit,
		requestRender() {},
	});
}

function nodes(children: readonly NativeChild[]): NativeNode[] {
	const result: NativeNode[] = [];
	for (const child of children) {
		const node = "k" in child ? child : child.describe?.(cx);
		if (!node) continue;
		result.push(node, ...nodes(node.c ?? []));
	}
	return result;
}

beforeAll(async () => {
	await initTheme(false);
});

describe("ACP cockpit transcript projection", () => {
	it("keeps streamed assistant segment keys identical after replay replaces component identities", () => {
		const message: AssistantMessage = {
			role: "assistant",
			sessionEntryId: "entry-42",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			timestamp: 123,
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			content: [
				{ type: "text", text: "Before the call" },
				{ type: "toolCall", id: "call-1", name: "custom", arguments: {} },
				{ type: "text", text: "After the call" },
			],
		};
		const transcript = builder();
		try {
			transcript.updateAssistant({ ...message, content: message.content.slice(0, 1) });
			const initial = nodes(transcript.container.children).find(node => node.p?.role === "omp.assistant");
			transcript.updateAssistant(message, false);
			const keys = nodes(transcript.container.children)
				.filter(node => node.p?.role === "omp.assistant")
				.map(node => node.p?.key);
			expect(initial?.p?.key).toBe("entry-42:before");
			expect(keys).toEqual(["entry-42:before", "entry-42:after:call-1"]);
			const { sessionEntryId: _id, ...legacy } = message;
			transcript.rebuild([
				{
					type: "message",
					id: "entry-42",
					parentId: null,
					timestamp: new Date(123).toISOString(),
					message: legacy,
				},
			]);
			expect(
				nodes(transcript.container.children)
					.filter(node => node.p?.role === "omp.assistant")
					.map(node => node.p?.key),
			).toEqual(keys);
		} finally {
			transcript.dispose();
		}
	});

	it("separates only explicit context while ordinary transcripts retain the untouched model prompt", () => {
		const message = {
			role: "user",
			timestamp: 123,
			content: "Context paragraph\n\nMessage paragraph\n\nSecond paragraph",
			clankyard: {
				turnId: "turn-42",
				context: "Context paragraph",
				displayText: "Message paragraph\n\nSecond paragraph",
			},
		} satisfies UserMessage;
		const cockpit = builder();
		const ordinary = builder(false);
		try {
			cockpit.appendMessage(message);
			ordinary.appendMessage(message);
			const projected = nodes(cockpit.container.children);
			expect(projected.find(node => node.p?.role === "omp.user")?.p?.key).toBe("turn-42");
			expect(
				projected.filter(node => node.k === "section").find(node => node.p?.role === "clankyard.context")?.p
					?.collapsed,
			).toBe(true);
			expect(projected.filter(node => node.k === "md").map(node => node.p?.text)).toEqual([
				"Message paragraph\n\nSecond paragraph",
				"Context paragraph",
			]);
			expect(
				nodes(ordinary.container.children)
					.filter(node => node.k === "md")
					.map(node => node.p?.text),
			).toEqual([message.content]);
		} finally {
			cockpit.dispose();
			ordinary.dispose();
		}
	});

	it("retains pre-card permission state and the complete folded body through approval resolution", () => {
		const transcript = builder();
		try {
			transcript.setToolPermission("call-1", {
				status: "ask",
				confirm: "card",
				ask: { allow: "Allow", deny: "Deny" },
			});
			transcript.startToolExecution("call-1", "custom", {});
			const component = transcript.container.children.find(child => child instanceof ToolExecutionComponent);
			if (!(component instanceof ToolExecutionComponent)) throw new Error("Missing tool card");
			expect(component.describe(cx).p).toMatchObject({ key: "call-1", status: "ask", confirm: "card" });
			const output = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
			transcript.updateToolResult({
				role: "toolResult",
				toolName: "custom",
				toolCallId: "call-1",
				timestamp: 124,
				content: [{ type: "text", text: output }],
				isError: false,
			});
			transcript.setToolPermission("call-1", { approved: "once" });
			const folded = component.describe(cx);
			expect(folded.p).toMatchObject({ key: "call-1", status: "done", approved: "once", collapsed: true });
			expect(JSON.stringify(nodes([folded]))).toContain("line 79");
			transcript.setToolPermission("call-1", undefined);
			expect(component.describe(cx).p).toMatchObject({ approved: undefined });
		} finally {
			transcript.dispose();
		}
	});
});
