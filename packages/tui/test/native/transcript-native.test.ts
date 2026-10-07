import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { createCompactionSummaryMessage, createCustomMessage } from "@oh-my-pi/pi-agent-core/compaction/messages";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createAdvisorMessageCard } from "@oh-my-pi/pi-tui/chat/advisor-message";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { CompactionSummaryMessageComponent } from "@oh-my-pi/pi-tui/chat/compaction-summary-message";
import { CustomMessageComponent } from "@oh-my-pi/pi-tui/chat/custom-message";
import { EvalExecutionComponent } from "@oh-my-pi/pi-tui/chat/eval-execution";
import { LateDiagnosticsMessageComponent } from "@oh-my-pi/pi-tui/chat/late-diagnostics-message";
import { SkillMessageComponent } from "@oh-my-pi/pi-tui/chat/skill-message";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-tui/chat/messages";
import { StrippedToolCallsPlaceholder } from "@oh-my-pi/pi-tui/chat/stripped-tool-calls-placeholder";
import { stopSharedSpinnerTicker, ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import type { TranscriptEntryLike } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { buildAsyncResultBlock, buildFileMentionBlock } from "@oh-my-pi/pi-tui/chat/transcript-render-helpers";
import { TodoReminderComponent } from "@oh-my-pi/pi-tui/chat/todo-reminder";
import { TtsrNotificationComponent } from "@oh-my-pi/pi-tui/chat/ttsr-notification";
import { CollapsedSyntheticMessageComponent, UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { text } from "@oh-my-pi/pi-tui/native/describe";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { TspNode, TspOp } from "@oh-my-pi/pi-wire";
import { TspHarness } from "./tsp-harness";

beforeAll(async () => {
	await initTheme(false);
});

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
	setNativeRendering(false);
	stopSharedSpinnerTicker();
});

const USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"], usage = USAGE): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage,
		timestamp: 1,
	};
}

function toolResult(id: string, output: string, name = "lookup_thing"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: output }],
		isError: false,
		timestamp: 2,
	};
}

function recorded(messages: (AssistantMessage | ToolResultMessage)[]): TranscriptEntryLike[] {
	return messages.map((message, index) => ({
		type: "message",
		id: `entry-${index}`,
		parentId: index === 0 ? null : `entry-${index - 1}`,
		timestamp: "2026-01-01T00:00:00Z",
		message,
	}));
}

/** Viewer transcript entries: one generic (renderer-less) tool call and its result. */
function toolTranscript(): TranscriptEntryLike[] {
	return [
		{
			type: "message",
			id: "a1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			message: assistant([{ type: "toolCall", id: "call-1", name: "lookup_thing", arguments: { q: "x" } }]),
		},
		{
			type: "message",
			id: "r1",
			parentId: "a1",
			timestamp: "2026-01-01T00:00:01Z",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "lookup_thing",
				content: [{ type: "text", text: Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n") }],
				isError: false,
				timestamp: 2,
			},
		},
	];
}

async function startWith(build: (h: TspHarness) => void): Promise<TspHarness> {
	harness = await TspHarness.start();
	build(harness);
	await harness.render();
	return harness;
}

function opsSince(h: TspHarness, frameCount: number): TspOp[] {
	return h.frames.slice(frameCount).flatMap(frame => frame.ops);
}

function markdownText(node: TspNode | undefined): string | undefined {
	return node?.k === "md" ? node.p?.text : undefined;
}

function toolProps(node: TspNode | undefined): Extract<TspNode, { k: "tool" }>["p"] {
	return node?.k === "tool" ? node.p : undefined;
}

describe("native transcript", () => {
	it("streams assistant text as appends to one md node that stops streaming when final", async () => {
		const component = new AssistantMessageComponent();
		const h = await startWith(h => h.tui.addChild(component));
		component.updateContent(assistant([{ type: "text", text: "Hello" }]), { transient: true });
		await h.render();
		const md = h.find(node => node.k === "md");
		expect(md?.p).toMatchObject({ text: "Hello", stream: true });

		const before = h.frames.length;
		component.updateContent(assistant([{ type: "text", text: "Hello, streaming world" }]), { transient: true });
		await h.render();
		expect(opsSince(h, before)).toContainEqual(["text", md!.id, "append", ", streaming world"]);

		component.updateContent(assistant([{ type: "text", text: "Hello, streaming world" }]));
		component.markTranscriptBlockFinalized();
		await h.render();
		const final = h.byId(md!.id);
		expect(final?.p).toMatchObject({ text: "Hello, streaming world" });
		expect(final?.p).not.toHaveProperty("stream");
		expect(h.errors).toEqual([]);
	});

	it("streams a table row to the terminal only once its line ends", async () => {
		const component = new AssistantMessageComponent();
		const h = await startWith(h => h.tui.addChild(component));
		const table = "| PR | Who |\n|---|---|\n| [#1](https://example.com/pull/1) | a |";
		component.updateContent(assistant([{ type: "text", text: `${table}\n| [#2](https://exa` }]), { transient: true });
		await h.render();
		const md = h.find(node => node.k === "md");
		expect(md?.p).toMatchObject({ text: table, stream: true });

		// A finished last row is sent once its newline arrives and stays sent while a tool call streams after it.
		const before = h.frames.length;
		const row = "\n| [#2](https://example.com/pull/2) | b |";
		component.updateContent(
			assistant([
				{ type: "text", text: `${table}${row}\n` },
				{ type: "toolCall", id: "call-1", name: "lookup_thing", arguments: {} },
			]),
			{ transient: true },
		);
		await h.render();
		expect(opsSince(h, before)).toContainEqual(["text", md!.id, "append", row]);

		const full = `${table}${row}\n| [#3](https://ex`;
		component.updateContent(assistant([{ type: "text", text: full }]));
		component.markTranscriptBlockFinalized();
		await h.render();
		expect(h.byId(md!.id)?.p).toMatchObject({ text: full });
		expect(h.errors).toEqual([]);
	});

	it("streams an open link as its closed form, fixing only the tail as the URL grows", async () => {
		const component = new AssistantMessageComponent();
		const h = await startWith(h => h.tui.addChild(component));
		const prose = "See [the docs](https://ex";
		component.updateContent(assistant([{ type: "text", text: prose }]), { transient: true });
		await h.render();
		const md = h.find(node => node.k === "md");
		expect(md?.p).toMatchObject({ text: `${prose})`, stream: true });

		const before = h.frames.length;
		component.updateContent(assistant([{ type: "text", text: `${prose}ample.com` }]), { transient: true });
		await h.render();
		// Only the new URL text crosses the wire: the guessed `)` stays in place behind it.
		expect(opsSince(h, before)).toEqual([["splice", md!.id, prose.length, 0, "ample.com"]]);

		const full = `${prose}ample.com) and more`;
		component.updateContent(assistant([{ type: "text", text: full }]));
		component.markTranscriptBlockFinalized();
		await h.render();
		expect(h.byId(md!.id)?.p).toMatchObject({ text: full });
		expect(h.errors).toEqual([]);
	});

	it("hands the terminal session-resolved targets for relative links once the segment closes", async () => {
		const component = new AssistantMessageComponent();
		const h = await startWith(h => h.tui.addChild(component));
		const source = [
			"| Board | Shot |",
			"|---|---|",
			"| 10×10 | [Open screenshot](artifacts/10x10.png) |",
			"",
			"See [the log][log] and [the crop](crop.png).",
			"Code `[x](artifacts/10x10.png)` stays, [web](https://x.dev) and [gone](missing.md) too.",
			"",
			"[log]: logs/run.txt",
		].join("\n");
		component.updateContent(assistant([{ type: "text", text: source }]), { transient: true });
		await h.render();
		expect(h.find(node => node.k === "md")?.p).toMatchObject({ text: source, stream: true });

		const wt = "file:///C:/Users/me/.omp/wt/cr2-43939c6";
		component.updateContent(assistant([{ type: "text", text: source }]));
		component.setLinkTargets(
			new Map([
				["artifacts/10x10.png", `${wt}/artifacts/10x10.png`],
				["logs/run.txt", `${wt}/logs/run.txt`],
				["crop.png", `${wt}/crop(1).png`],
			]),
		);
		component.markTranscriptBlockFinalized();
		await h.render();
		expect(h.find(node => node.k === "md")?.p).toMatchObject({
			text: [
				"| Board | Shot |",
				"|---|---|",
				`| 10×10 | [Open screenshot](${wt}/artifacts/10x10.png) |`,
				"",
				`See [the log][log] and [the crop](<${wt}/crop(1).png>).`,
				"Code `[x](artifacts/10x10.png)` stays, [web](https://x.dev) and [gone](missing.md) too.",
				"",
				`[log]: ${wt}/logs/run.txt`,
			].join("\n"),
		});
		expect(h.errors).toEqual([]);
	});

	it("keeps submitted skill text visible when the prompt is collapsed", async () => {
		const component = new SkillMessageComponent({
			role: "custom",
			customType: "skill-prompt",
			content: "Loaded SKILL.md instructions",
			display: true,
			attribution: "user",
			timestamp: 1,
			details: {
				name: "grill-with-docs",
				path: "/tmp/SKILL.md",
				lineCount: 3,
				prompt: "/skill:grill-with-docs Organize the project foundation",
			},
		});
		const h = await startWith(h => h.tui.addChild(component));
		const card = h.find(node => node.p?.role === "omp.skill");
		expect(card?.p).not.toHaveProperty("collapsible");
		expect(card?.c?.find(child => child.k === "md")?.p).toMatchObject({
			text: "Organize the project foundation",
		});
		const prompt = h.find(node => node.p?.role === "omp.skill.prompt");
		expect(prompt?.p).toMatchObject({ collapsible: true, collapsed: true });
		expect(prompt?.c).toBeUndefined();

		h.event({ ev: "toggle", sf: h.terminal.surface!, id: prompt!.id, collapsed: false });
		expect(h.byId(prompt!.id)?.p).toMatchObject({ collapsed: false });
		expect(h.byId(prompt!.id)?.c?.[0]?.p).toMatchObject({ text: "Loaded SKILL.md instructions" });

		h.event({ ev: "toggle", sf: h.terminal.surface!, id: prompt!.id, collapsed: true });
		expect(h.byId(prompt!.id)?.p).toMatchObject({ collapsed: true });
		expect(h.byId(prompt!.id)?.c).toBeUndefined();
		expect(h.byId(card!.id)?.c?.find(child => child.k === "md")?.p).toMatchObject({
			text: "Organize the project foundation",
		});
		expect(h.errors).toEqual([]);
	});

	it("mirrors a native toggle into the tool card and re-collapses it on a transcript-wide collapse", async () => {
		let builder: ChatTranscriptBuilder | undefined;
		const h = await startWith(h => {
			builder = new ChatTranscriptBuilder({ ui: h.tui, cwd: "/tmp", requestRender: () => h.tui.requestRender() });
			builder.append(toolTranscript());
			h.tui.addChild(builder.container);
		});
		const cardNode = h.find(node => node.k === "tool" && node.p?.role === "omp.tool.lookup_thing");
		expect(cardNode?.p).toMatchObject({ status: "done", collapsible: true, collapsed: true });

		h.event({ ev: "toggle", sf: h.terminal.surface!, id: cardNode!.id, collapsed: false });
		expect(h.byId(cardNode!.id)?.p).toMatchObject({ collapsed: false });

		builder!.setExpanded(false);
		await h.render();
		expect(h.byId(cardNode!.id)?.p).toMatchObject({ collapsed: true });
		expect(h.errors).toEqual([]);
	});

	it("keeps live builder text on one native node through finalization", async () => {
		let builder!: ChatTranscriptBuilder;
		const h = await startWith(h => {
			builder = new ChatTranscriptBuilder({ ui: h.tui, cwd: "/tmp", requestRender: () => h.tui.requestRender() });
			h.tui.addChild(builder.container);
		});
		try {
			builder.updateAssistant(assistant([{ type: "text", text: "Hello" }]));
			await h.render();
			const md = h.find(node => node.k === "md")!;
			expect(md.p).toMatchObject({ text: "Hello", stream: true });
			const before = h.frames.length;
			builder.updateAssistant(assistant([{ type: "text", text: "Hello, ACP host" }]));
			await h.render();
			expect(opsSince(h, before)).toContainEqual(["text", md.id, "append", ", ACP host"]);
			builder.updateAssistant(assistant([{ type: "text", text: "Hello, ACP host" }]), false);
			await h.render();
			expect(h.findAll(node => node.k === "md").map(node => node.id)).toEqual([md.id]);
			expect(h.byId(md.id)?.p).toMatchObject({ text: "Hello, ACP host" });
			expect(h.byId(md.id)?.p).not.toHaveProperty("stream");
			expect(h.errors).toEqual([]);
		} finally {
			builder.dispose();
		}
	});

	it("retains one streamed tool card when its final id is minted and a result arrives early", async () => {
		let builder!: ChatTranscriptBuilder;
		const h = await startWith(h => {
			builder = new ChatTranscriptBuilder({ ui: h.tui, cwd: "/tmp", requestRender: () => h.tui.requestRender() });
			h.tui.addChild(builder.container);
		});
		try {
			builder.updateAssistant(
				assistant([
					{ type: "text", text: "Checking" },
					{ type: "toolCall", id: "", name: "lookup_thing", arguments: { q: "x" } },
				]),
			);
			await h.render();
			const card = h.find(node => node.k === "tool")!;
			builder.updateToolResult({
				role: "toolResult",
				toolCallId: "minted",
				toolName: "lookup_thing",
				content: [{ type: "text", text: "Found the answer" }],
				isError: false,
				timestamp: 2,
			});
			builder.updateAssistant(
				assistant([
					{ type: "text", text: "Checking" },
					{ type: "toolCall", id: "minted", name: "lookup_thing", arguments: { q: "x" } },
					{ type: "text", text: "Finished" },
				]),
				false,
			);
			builder.startToolExecution("minted", "lookup_thing", { q: "x" });
			builder.updateToolResult({
				role: "toolResult",
				toolCallId: "minted",
				toolName: "lookup_thing",
				content: [{ type: "text", text: "Found the answer" }],
				isError: false,
				timestamp: 3,
			});
			await h.render();
			expect(h.findAll(node => node.k === "tool").map(node => node.id)).toEqual([card.id]);
			expect(h.byId(card.id)?.p).toMatchObject({ status: "done" });
			expect(h.findAll(node => node.k === "md").map(markdownText)).toEqual(["Checking", "Finished"]);
			expect(h.errors).toEqual([]);
		} finally {
			builder.dispose();
		}
	});

	it.each(["pending", "completed"] as const)(
		"adopts an execution-first %s tool card into its assistant timeline",
		async state => {
			let builder!: ChatTranscriptBuilder;
			const h = await startWith(h => {
				builder = new ChatTranscriptBuilder({ ui: h.tui, cwd: "/tmp", requestRender: () => h.tui.requestRender() });
				h.tui.addChild(builder.container);
			});
			try {
				if (state === "pending") builder.updateAssistant(assistant([]));
				builder.startToolExecution("execution-first", "lookup_thing", { q: "answer" });
				await h.render();
				const card = h.find(node => node.k === "tool")!;
				expect(toolProps(card)?.status).toBe("running");
				if (state === "completed") {
					builder.updateToolResult(toolResult("execution-first", "Early answer"));
					await h.render();
					expect(toolProps(h.byId(card.id))?.status).toBe("done");
				}
				const snapshot = assistant([
					{ type: "text", text: "Before the call" },
					{ type: "toolCall", id: "execution-first", name: "lookup_thing", arguments: { q: "answer" } },
					{ type: "text", text: "After the call" },
				]);
				builder.updateAssistant(snapshot);
				builder.updateAssistant(snapshot, false);
				await h.render();
				expect(h.findAll(node => node.k === "tool").map(node => node.id)).toEqual([card.id]);
				expect(toolProps(h.byId(card.id))?.status).toBe(state === "completed" ? "done" : "running");
				expect(
					h
						.findAll(node => node.k === "tool" || node.k === "md")
						.map(node => (node.k === "tool" ? node.id : markdownText(node))),
				).toEqual(["Before the call", card.id, "After the call"]);
				if (state === "pending") builder.updateToolResult(toolResult("execution-first", "Early answer"));
				builder.startToolExecution("execution-first", "lookup_thing", { q: "duplicate" });
				builder.appendMessage(toolResult("execution-first", "Duplicate answer"));
				await h.render();
				expect(h.findAll(node => node.k === "tool").map(node => node.id)).toEqual([card.id]);
				expect(toolProps(h.byId(card.id))?.status).toBe("done");
				expect(h.byId(card.id)?.c?.find(node => node.k === "ansi")?.p?.text).toBe("Early answer");
				expect(h.errors).toEqual([]);
			} finally {
				builder.dispose();
			}
		},
	);

	it.each(["tool", "prose"] as const)(
		"keeps a queued and running read live when %s closes its group membership",
		async boundary => {
			let builder!: ChatTranscriptBuilder;
			const h = await startWith(h => {
				builder = new ChatTranscriptBuilder({ ui: h.tui, cwd: "/tmp", requestRender: () => h.tui.requestRender() });
				h.tui.addChild(builder.container);
			});
			try {
				const read = {
					type: "toolCall" as const,
					id: "queued-read",
					name: "read",
					arguments: { path: "first.ts" },
				};
				builder.updateAssistant(assistant([read]));
				await h.render();
				const group = h.find(node => node.p?.role === "omp.tool.read")!;
				expect(toolProps(group)).toMatchObject({ status: "running", target: "first.ts" });
				const snapshot = assistant([
					read,
					boundary === "tool"
						? { type: "toolCall", id: "other", name: "lookup_thing", arguments: {} }
						: { type: "text", text: "Reading continues" },
				]);
				builder.updateAssistant(snapshot);
				await h.render();
				expect(toolProps(h.byId(group.id))).toMatchObject({ status: "running", target: "first.ts" });
				builder.startToolExecution("queued-read", "read", { path: "first.ts" });
				await h.render();
				expect(toolProps(h.byId(group.id))?.status).toBe("running");
				builder.updateToolResult(toolResult("queued-read", "Read finished", "read"));
				if (boundary === "tool") builder.updateToolResult(toolResult("other", "Other finished"));
				builder.updateAssistant(snapshot, false);
				await h.render();
				expect(toolProps(h.byId(group.id))?.status).toBe("done");
				builder.updateAssistant(
					assistant([{ type: "toolCall", id: "next-read", name: "read", arguments: { path: "second.ts" } }]),
					false,
				);
				builder.updateToolResult(toolResult("next-read", "Next read finished", "read"));
				await h.render();
				expect(h.findAll(node => node.p?.role === "omp.tool.read").map(node => toolProps(node)?.target)).toEqual([
					"first.ts",
					"second.ts",
				]);
				expect(h.findAll(node => node.p?.role === "omp.tool.read").map(node => toolProps(node)?.status)).toEqual([
					"done",
					"done",
				]);
				expect(h.errors).toEqual([]);
			} finally {
				builder.dispose();
			}
		},
	);

	it("places late post-tool prose between its tool and the next card", async () => {
		let builder!: ChatTranscriptBuilder;
		const h = await startWith(h => {
			builder = new ChatTranscriptBuilder({ ui: h.tui, cwd: "/tmp", requestRender: () => h.tui.requestRender() });
			h.tui.addChild(builder.container);
		});
		try {
			const first = { type: "toolCall" as const, id: "one", name: "lookup_thing", arguments: { q: "one" } };
			const second = { type: "toolCall" as const, id: "two", name: "lookup_thing", arguments: { q: "two" } };
			builder.updateAssistant(assistant([first, second]));
			await h.render();
			const cards = h.findAll(node => node.k === "tool").map(node => node.id);
			builder.updateAssistant(
				assistant([first, { type: "text", text: "Progress" }, second, { type: "text", text: "Answer" }]),
			);
			await h.render();
			expect(h.findAll(node => node.k === "tool").map(node => node.id)).toEqual(cards);
			expect(
				h
					.findAll(node => node.k === "tool" || node.k === "md")
					.map(node => (node.k === "tool" ? node.id : markdownText(node))),
			).toEqual([cards[0], "Progress", cards[1], "Answer"]);
			expect(h.errors).toEqual([]);
		} finally {
			builder.dispose();
		}
	});

	it.each(["live", "replay"] as const)("renders separate results for reused provider call ids in %s", async mode => {
		let builder!: ChatTranscriptBuilder;
		const h = await startWith(h => {
			builder = new ChatTranscriptBuilder({ ui: h.tui, cwd: "/tmp", requestRender: () => h.tui.requestRender() });
			h.tui.addChild(builder.container);
		});
		try {
			const id = "ollama:0:lookup_thing";
			const messages = ["first", "second"].flatMap(query => [
				assistant([{ type: "toolCall", id, name: "lookup_thing", arguments: { q: query } }]),
				toolResult(id, `${query} answer`),
			]);
			if (mode === "replay") {
				builder.rebuild(recorded(messages));
			} else {
				for (const message of messages) {
					if (message.role === "assistant") {
						builder.updateAssistant(message);
						builder.updateAssistant(message, false);
						builder.startToolExecution(id, "lookup_thing", { q: "running" });
					} else {
						builder.updateToolResult(message);
						// Both execution_end and persisted message_end report this call.
						builder.appendMessage(toolResult(id, "duplicate result"));
						builder.startToolExecution(id, "lookup_thing", { q: "duplicate" });
					}
					await h.render();
				}
			}
			await h.render();
			const cards = h.findAll(node => node.k === "tool");
			expect(cards).toHaveLength(2);
			expect(cards[0]!.id).not.toBe(cards[1]!.id);
			expect(cards.map(card => toolProps(card)?.status)).toEqual(["done", "done"]);
			expect(cards.map(card => card.c?.find(node => node.k === "ansi")?.p?.text)).toEqual([
				"first answer",
				"second answer",
			]);
			expect(h.errors).toEqual([]);
		} finally {
			builder.dispose();
		}
	});

	it("retracts cancelled streamed calls and their after-tool segments without losing surviving prose", async () => {
		let builder!: ChatTranscriptBuilder;
		const h = await startWith(h => {
			builder = new ChatTranscriptBuilder({
				ui: h.tui,
				cwd: "/tmp",
				requestRender: () => h.tui.requestRender(),
				displayPreferences: {
					hideToolActivity: false,
					readToolResultPreview: false,
					showImages: false,
					cacheMissMarker: false,
					showTokenUsage: true,
					showTurnTime: false,
					advisorCollapsedLines: 0,
				},
			});
			h.tui.addChild(builder.container);
		});
		try {
			const interrupted = { type: "toolCall" as const, id: "cancelled", name: "lookup_thing", arguments: {} };
			const read = { type: "toolCall" as const, id: "read", name: "read", arguments: { path: "pending.ts" } };
			const incompleteRead = { type: "toolCall" as const, id: "partial-read", name: "read", arguments: {} };
			builder.updateAssistant(
				assistant([interrupted, { type: "text", text: "Surviving prose" }, read, incompleteRead]),
			);
			await h.render();
			expect(h.findAll(node => node.k === "tool")).toHaveLength(2);
			builder.updateToolPreview("partial-read", { text: "unfinished preview" });
			builder.updateAssistant(
				{
					...assistant([{ type: "text", text: "Surviving prose" }], { ...USAGE, input: 4, output: 2 }),
					stopReason: "aborted",
					errorMessage: USER_INTERRUPT_LABEL,
				},
				false,
			);
			await h.render();
			expect(h.findAll(node => node.k === "tool")).toEqual([]);
			expect(h.findAll(node => node.k === "md").map(markdownText)).toEqual(["Surviving prose"]);
			expect(h.findAll(node => node.p?.role === "omp.usage.turn")).toHaveLength(1);

			builder.updateAssistant(
				assistant([interrupted, { ...incompleteRead, arguments: { path: "ready.ts" } }]),
				false,
			);
			builder.updateToolResult(toolResult("cancelled", "Fresh result"));
			builder.updateToolResult(toolResult("partial-read", "Read result", "read"));
			await h.render();
			expect(h.findAll(node => node.k === "tool").map(node => toolProps(node)?.status)).toEqual(["done", "done"]);
			expect(h.find(node => node.k === "ansi" && node.p?.text === "Fresh result")).toBeDefined();
			expect(toolProps(h.find(node => node.p?.role === "omp.tool.read"))?.target).toBe("ready.ts");
			expect(h.errors).toEqual([]);
		} finally {
			builder.dispose();
		}
	});

	it("keeps the completed sibling's identity when cancellation removes an earlier content index", async () => {
		let builder!: ChatTranscriptBuilder;
		const h = await startWith(h => {
			builder = new ChatTranscriptBuilder({ ui: h.tui, cwd: "/tmp", requestRender: () => h.tui.requestRender() });
			h.tui.addChild(builder.container);
		});
		try {
			const unfinished = { type: "toolCall" as const, id: "unfinished", name: "lookup_thing", arguments: {} };
			const finished = { type: "toolCall" as const, id: "finished", name: "lookup_thing", arguments: {} };
			builder.updateAssistant(assistant([unfinished, finished, { type: "text", text: "Keep this" }]));
			builder.updateToolResult(toolResult("finished", "Completed answer"));
			await h.render();
			const completedCard = h.find(node => node.k === "tool" && node.p?.status === "done")!;
			builder.updateAssistant(
				{
					...assistant([finished, { type: "text", text: "Keep this" }]),
					stopReason: "aborted",
					errorMessage: USER_INTERRUPT_LABEL,
				},
				false,
			);
			await h.render();
			expect(h.findAll(node => node.k === "tool").map(node => node.id)).toEqual([completedCard.id]);
			expect(toolProps(h.byId(completedCard.id))?.status).toBe("done");
			expect(h.byId(completedCard.id)?.c?.find(node => node.k === "ansi")?.p?.text).toBe("Completed answer");
			expect(h.findAll(node => node.k === "md").map(markdownText)).toEqual(["Keep this"]);
			expect(h.errors).toEqual([]);
		} finally {
			builder.dispose();
		}
	});

	it("retracts only the cancelled read member while retaining its completed group sibling", async () => {
		let builder!: ChatTranscriptBuilder;
		const h = await startWith(h => {
			builder = new ChatTranscriptBuilder({ ui: h.tui, cwd: "/tmp", requestRender: () => h.tui.requestRender() });
			h.tui.addChild(builder.container);
		});
		try {
			const unfinished = {
				type: "toolCall" as const,
				id: "unfinished-read",
				name: "read",
				arguments: { path: "pending.ts" },
			};
			const finished = {
				type: "toolCall" as const,
				id: "finished-read",
				name: "read",
				arguments: { path: "complete.ts" },
			};
			builder.updateAssistant(assistant([unfinished, finished]));
			builder.updateToolResult(toolResult("finished-read", "Completed read", "read"));
			await h.render();
			const group = h.find(node => node.p?.role === "omp.tool.read")!;
			expect(group.p).toMatchObject({ status: "running", target: "2 files" });
			builder.updateAssistant(
				{
					...assistant([finished]),
					stopReason: "aborted",
					errorMessage: USER_INTERRUPT_LABEL,
				},
				false,
			);
			await h.render();
			expect(h.findAll(node => node.p?.role === "omp.tool.read").map(node => node.id)).toEqual([group.id]);
			expect(h.byId(group.id)?.p).toMatchObject({ status: "done", target: "complete.ts" });
			builder.updateAssistant(assistant([{ ...unfinished, arguments: { path: "next.ts" } }]), false);
			builder.updateToolResult(toolResult("unfinished-read", "Next read", "read"));
			await h.render();
			expect(h.findAll(node => node.p?.role === "omp.tool.read").map(node => toolProps(node)?.target)).toEqual([
				"complete.ts",
				"next.ts",
			]);
			expect(h.findAll(node => node.p?.role === "omp.tool.read").map(node => toolProps(node)?.status)).toEqual([
				"done",
				"done",
			]);
			expect(h.errors).toEqual([]);
		} finally {
			builder.dispose();
		}
	});

	it("settles abandoned foreground calls at run end while background task results remain live", async () => {
		let builder!: ChatTranscriptBuilder;
		const h = await startWith(h => {
			builder = new ChatTranscriptBuilder({
				ui: h.tui,
				cwd: "/tmp",
				isBuiltInTool: () => false,
				requestRender: () => h.tui.requestRender(),
				displayPreferences: {
					hideToolActivity: false,
					readToolResultPreview: false,
					showImages: false,
					cacheMissMarker: false,
					showTokenUsage: true,
					showTurnTime: false,
					advisorCollapsedLines: 0,
				},
			});
			h.tui.addChild(builder.container);
		});
		try {
			builder.updateAssistant(
				assistant(
					[
						{ type: "toolCall", id: "foreground", name: "lookup_thing", arguments: {} },
						{ type: "toolCall", id: "background", name: "task", arguments: { task: "Continue working" } },
					],
					{ ...USAGE, input: 5, output: 2 },
				),
				false,
			);
			builder.updateToolResult({
				...toolResult("background", "Delegated", "task"),
				details: { async: { state: "running" } },
			});
			await h.render();
			expect(h.findAll(node => node.p?.role === "omp.usage.turn")).toEqual([]);
			builder.settleRun();
			await h.render();
			const foreground = h.find(node => node.p?.role === "omp.tool.lookup_thing")!;
			const background = h.find(node => node.p?.role === "omp.tool.task")!;
			expect(toolProps(foreground)?.status).toBe("cancelled");
			expect(toolProps(background)?.status).toBe("running");
			expect(h.findAll(node => node.p?.role === "omp.usage.turn")).toHaveLength(1);
			builder.updateToolResult(
				{
					...toolResult("background", "Background answer", "task"),
					details: { async: { state: "completed" } },
				},
				true,
			);
			await h.render();
			expect(toolProps(h.byId(background.id))?.status).toBe("done");
			expect(h.byId(background.id)?.c?.find(node => node.k === "ansi")?.p?.text).toBe("Background answer");
			expect(toolProps(h.byId(foreground.id))?.status).toBe("cancelled");
			expect(h.errors).toEqual([]);
		} finally {
			builder.dispose();
		}
	});

	it("seals a run without a final assistant snapshot and starts the next assistant separately", async () => {
		let builder!: ChatTranscriptBuilder;
		const h = await startWith(h => {
			builder = new ChatTranscriptBuilder({ ui: h.tui, cwd: "/tmp", requestRender: () => h.tui.requestRender() });
			h.tui.addChild(builder.container);
		});
		try {
			const call = { type: "toolCall" as const, id: "reused", name: "lookup_thing", arguments: {} };
			builder.updateAssistant(assistant([{ type: "text", text: "Stopped midway" }, call]));
			await h.render();
			const stoppedText = h.find(node => node.k === "md")!;
			builder.settleRun();
			await h.render();
			expect(h.byId(stoppedText.id)?.p).toMatchObject({ text: "Stopped midway" });
			expect(h.byId(stoppedText.id)?.p).not.toHaveProperty("stream");
			expect(toolProps(h.find(node => node.k === "tool"))?.status).toBe("cancelled");

			builder.updateAssistant(assistant([{ type: "text", text: "Next run" }, call]), false);
			builder.updateToolResult(toolResult("reused", "Next answer"));
			await h.render();
			expect(h.findAll(node => node.k === "md").map(markdownText)).toEqual(["Stopped midway", "Next run"]);
			expect(h.findAll(node => node.k === "tool").map(node => toolProps(node)?.status)).toEqual([
				"cancelled",
				"done",
			]);
			expect(h.find(node => node.k === "ansi" && node.p?.text === "Next answer")).toBeDefined();
			expect(h.errors).toEqual([]);
		} finally {
			builder.dispose();
		}
	});

	it("keeps reused read ids in separate groups without replacing earlier content", async () => {
		let builder!: ChatTranscriptBuilder;
		const h = await startWith(h => {
			builder = new ChatTranscriptBuilder({
				ui: h.tui,
				cwd: "/tmp",
				requestRender: () => h.tui.requestRender(),
				displayPreferences: {
					hideToolActivity: false,
					readToolResultPreview: true,
					showImages: false,
					cacheMissMarker: false,
					showTokenUsage: false,
					showTurnTime: false,
					advisorCollapsedLines: 0,
				},
			});
			h.tui.addChild(builder.container);
		});
		try {
			const id = "ollama:0:read";
			const messages = ["first", "second"].flatMap(name => [
				assistant([{ type: "toolCall", id, name: "read", arguments: { path: `${name}.ts` } }]),
				toolResult(id, `${name} content`, "read"),
			]);
			builder.rebuild(recorded(messages));
			await h.render();
			const groups = h.findAll(node => node.p?.role === "omp.tool.read");
			expect(groups.map(group => toolProps(group)?.target)).toEqual(["first.ts", "second.ts"]);
			expect(groups.map(group => toolProps(group)?.status)).toEqual(["done", "done"]);
			expect(groups.map(group => group.c?.find(node => node.k === "code")?.p?.text)).toEqual([
				"first content",
				"second content",
			]);
			expect(h.errors).toEqual([]);
		} finally {
			builder.dispose();
		}
	});

	it("separates read groups at the first streamed prose transition just as recorded replay does", async () => {
		let builder!: ChatTranscriptBuilder;
		const h = await startWith(h => {
			builder = new ChatTranscriptBuilder({ ui: h.tui, cwd: "/tmp", requestRender: () => h.tui.requestRender() });
			h.tui.addChild(builder.container);
		});
		try {
			const first = assistant([{ type: "toolCall", id: "first", name: "read", arguments: { path: "first.ts" } }]);
			const result = toolResult("first", "first content", "read");
			const explanation = { type: "text" as const, text: "Explaining next read" };
			const second = assistant([
				explanation,
				{ type: "toolCall", id: "second", name: "read", arguments: { path: "second.ts" } },
			]);
			const secondResult = toolResult("second", "second content", "read");
			builder.updateAssistant(first, false);
			builder.updateToolResult(result);
			await h.render();
			const firstGroup = h.find(node => node.p?.role === "omp.tool.read")!;
			builder.updateAssistant(assistant([]));
			builder.updateAssistant(assistant([explanation]));
			await h.render();
			builder.updateAssistant(second);
			builder.updateAssistant(second, false);
			builder.updateToolResult(secondResult);
			await h.render();
			const order = () =>
				h
					.findAll(node => node.p?.role === "omp.tool.read" || node.k === "md")
					.map(node => (node.k === "md" ? markdownText(node) : toolProps(node)?.target));
			expect(h.findAll(node => node.p?.role === "omp.tool.read")).toHaveLength(2);
			expect(h.byId(firstGroup.id)?.p).toMatchObject({ target: "first.ts", status: "done" });
			expect(order()).toEqual(["first.ts", "Explaining next read", "second.ts"]);
			builder.rebuild(recorded([first, result, second, secondResult]));
			await h.render();
			expect(order()).toEqual(["first.ts", "Explaining next read", "second.ts"]);
			expect(h.errors).toEqual([]);
		} finally {
			builder.dispose();
		}
	});

	it("keeps a streaming write open until it settles, then folds it like a finished thought", () => {
		const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
		const content = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).join("\n");
		const tool = new ToolExecutionComponent("write", { path: "src/a.ts", content }, {}, undefined, ui);
		try {
			expect(tool.describe().p).toMatchObject({ status: "pending", collapsible: true, collapsed: false });
			tool.setArgsComplete("call-1");
			tool.setExecutionStarted("call-1");
			expect(tool.describe().p).toMatchObject({ status: "running", collapsed: false });
			tool.updateResult({ content: [{ type: "text", text: "Wrote 40 lines" }], isError: false });
			expect(tool.describe().p).toMatchObject({ status: "done", collapsed: true });
		} finally {
			tool.dispose();
		}
	});

	it("keeps a finished todo call's checklist open", () => {
		const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
		const tool = new ToolExecutionComponent("todo", { op: "start", task: "lex" }, {}, undefined, ui);
		try {
			tool.setArgsComplete("call-1");
			tool.setExecutionStarted("call-1");
			tool.updateResult({
				content: [{ type: "text", text: "ok" }],
				details: {
					storage: "memory",
					phases: [{ name: "Build", tasks: [{ content: "lex", status: "in_progress" }] }],
				},
				isError: false,
			});
			expect(tool.describe().p).toMatchObject({ status: "done", collapsible: true, collapsed: false });
		} finally {
			tool.dispose();
		}
	});

	it("describes a custom tool (MCP) through the tool's own describe hooks", async () => {
		const tool = {
			name: "mcp__demo_lookup",
			label: "demo/lookup",
			description: "demo",
			parameters: {},
			execute: async () => ({ content: [] }),
			mergeCallAndResult: true,
			describeCall: () => ({ body: [text("call body")] }),
			describeResult: () => ({ body: [text("result body")] }),
		} as unknown as AgentTool;
		const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
		const component = new ToolExecutionComponent(
			"mcp__demo_lookup",
			{ q: "x" },
			{ useBuiltInRenderer: false },
			tool,
			ui,
		);
		const h = await startWith(h => h.tui.addChild(component));
		expect(h.find(node => node.k === "text" && node.p?.text === "call body")).toBeDefined();

		component.updateResult({ content: [{ type: "text", text: "raw" }], isError: false });
		await h.render();
		expect(h.find(node => node.k === "text" && node.p?.text === "result body")).toBeDefined();
		expect(h.find(node => node.k === "text" && node.p?.text === "call body")).toBeUndefined();
		expect(h.errors).toEqual([]);
		component.dispose();
	});

	it("settles finalized blocks and still delivers later changes to them", async () => {
		let builder: ChatTranscriptBuilder | undefined;
		const h = await startWith(h => {
			builder = new ChatTranscriptBuilder({ ui: h.tui, cwd: "/tmp", requestRender: () => h.tui.requestRender() });
			builder.append(toolTranscript());
			h.tui.addChild(builder.container);
		});
		const cardNode = h.find(node => node.k === "tool" && node.p?.role === "omp.tool.lookup_thing");
		expect(opsSince(h, 0)).toContainEqual(["settle", cardNode!.id]);

		const before = h.frames.length;
		builder!.setExpanded(true);
		await h.render();
		expect(opsSince(h, before)).toContainEqual(["set", cardNode!.id, expect.objectContaining({ collapsed: false })]);
		expect(h.byId(cardNode!.id)?.p).toMatchObject({ collapsed: false });
		expect(h.errors).toEqual([]);
	});

	it("schedules no repaint timers for spinners or the thinking pulse while a surface is live", () => {
		vi.useFakeTimers();
		setNativeRendering(true);
		let repaints = 0;
		const ui = {
			requestRender: () => repaints++,
			requestComponentRender: () => repaints++,
			resetDisplay: () => {},
		};
		// A generic tool whose call is still streaming would tick the shared spinner on the ANSI path.
		const tool = new ToolExecutionComponent("lookup_thing", { q: "x" }, {}, undefined, ui);
		tool.setExecutionStarted("call-1");
		const thinking = new AssistantMessageComponent(undefined, true, () => repaints++);
		thinking.updateContent(assistant([{ type: "thinking", thinking: "Weighing the options carefully." }]), {
			transient: true,
		});
		repaints = 0;
		try {
			vi.advanceTimersByTime(2_000);
			expect(repaints).toBe(0);
			expect(tool.describe().p).toMatchObject({ status: "running" });
		} finally {
			tool.dispose();
			thinking.dispose();
			vi.useRealTimers();
		}
	});

	it("describes every transcript block semantically: no rows fallback, ANSI styling or box glyphs", async () => {
		const h = await startWith(h => {
			const builder = new ChatTranscriptBuilder({
				ui: h.tui,
				cwd: "/tmp",
				requestRender: () => h.tui.requestRender(),
			});
			builder.append(toolTranscript());
			const container = builder.container;
			const user = new UserMessageComponent("Please **fix** the build");
			user.setReaction("👍");
			container.addChild(user);
			container.addChild(new CollapsedSyntheticMessageComponent("# Session update\nbody"));
			const reply = new AssistantMessageComponent(
				assistant([
					{ type: "thinking", thinking: "Considering the failing step." },
					{ type: "text", text: "Done. See `make`." },
				]),
			);
			reply.setCacheInvalidation({ reprocessedTokens: 50_000 });
			container.addChild(reply);
			const bash = new BashExecutionComponent("ls -la", h.tui);
			bash.appendOutput("\x1b[31mred\x1b[0m output\nsecond line");
			bash.setComplete(1, false);
			container.addChild(bash);
			const cell = new EvalExecutionComponent("print(1)", h.tui);
			cell.appendOutput("1\n");
			cell.setComplete(0, false);
			container.addChild(cell);
			container.addChild(
				new CompactionSummaryMessageComponent(
					createCompactionSummaryMessage("Summary text", 256_000, "2026-01-01"),
				),
			);
			container.addChild(
				new CustomMessageComponent(
					createCustomMessage("note", "Injected **context**", true, undefined, "2026-01-01"),
				),
			);
			container.addChild(
				new TtsrNotificationComponent([{ name: "no-sleep", description: "Never sleep\nin tests" }]),
			);
			container.addChild(new TodoReminderComponent([{ content: "Ship it", status: "pending" }], 1, 3));
			container.addChild(
				new LateDiagnosticsMessageComponent([
					{ path: "src/a.ts", summary: "1 error", errored: true, messages: ["src/a.ts:1:1 [error] bad"] },
				]),
			);
			container.addChild(new StrippedToolCallsPlaceholder(2, true));
			container.addChild(
				buildAsyncResultBlock(
					createCustomMessage(
						"async-result",
						"done",
						true,
						{ jobId: "j1", type: "bash", durationMs: 1200 },
						"2026",
					),
				),
			);
			container.addChild(buildFileMentionBlock([{ path: "src/a.ts", content: "", lineCount: 3 }], 0));
			container.addChild(
				createAdvisorMessageCard({ notes: [{ note: "Check the cache", severity: "blocker" }] }, () => false, theme),
			);
			h.tui.addChild(container);
		});

		const offending: string[] = [];
		const visit = (node: TspNode): void => {
			if (node.k === "rows") offending.push(`rows fallback ${node.id}`);
			if (node.k !== "ansi") {
				const props = JSON.stringify(node.p ?? {});
				if (props.includes("\\u001b")) offending.push(`ANSI escape in ${node.k} ${node.id}: ${props}`);
				if (/[─│╭╮╰╯┌┐└┘]/.test(props)) offending.push(`box glyph in ${node.k} ${node.id}: ${props}`);
			}
			for (const child of node.c ?? []) visit(child);
		};
		visit(h.doc());
		expect(offending).toEqual([]);
		const roles = h.findAll(node => typeof node.p?.role === "string").map(node => node.p!.role);
		expect(roles).toEqual(
			expect.arrayContaining([
				"omp.tool.lookup_thing",
				"omp.user",
				"omp.user.synthetic",
				"omp.assistant",
				"omp.thinking",
				"omp.bash",
				"omp.eval",
				"omp.compaction",
				"omp.custom",
				"omp.notice.ttsr",
				"omp.notice.todo",
				"omp.diagnostics.late",
				"omp.marker.cache-miss",
				"omp.status-block",
				"omp.advisor",
			]),
		);
		expect(h.errors).toEqual([]);
	});
});

describe("retained transcript regressions", () => {
	function renderedText(node: TspNode): string {
		const own = node.k === "text" ? (node.p?.text ?? node.p?.spans?.map(span => span.t).join("") ?? "") : "";
		return own + (node.c ?? []).map(renderedText).join("");
	}

	it.each(["error", "aborted"] as const)(
		"keeps one failure-settled card through synthetic execution/results after %s",
		async stopReason => {
			let builder!: ChatTranscriptBuilder;
			const h = await startWith(h => {
				builder = new ChatTranscriptBuilder({
					ui: h.tui,
					cwd: "/tmp",
					isBuiltInTool: () => false,
					requestRender: () => h.tui.requestRender(),
				});
				h.tui.addChild(builder.container);
			});
			try {
				const call = {
					type: "toolCall" as const,
					id: `failed-${stopReason}`,
					name: "lookup_thing",
					arguments: { q: `retained-${stopReason}` },
				};
				builder.updateAssistant(assistant([call]));
				await h.render();
				const streamedId = h.find(node => node.k === "tool")!.id;
				const failed = {
					...assistant([call]),
					stopReason,
					errorMessage: stopReason === "error" ? "Provider connection failed" : "Execution deadline exceeded",
				};
				builder.updateAssistant(failed, false);
				const synthetic = {
					...toolResult(call.id, "Call emitted but not executed"),
					isError: true,
					details: {
						__synthetic: true,
						executed: false,
						source: stopReason === "error" ? "assistant_stop_error" : "assistant_stop_aborted",
					},
				};
				// agent-loop emits execution_start/end, then the persisted result.
				builder.startToolExecution(call.id, call.name, call.arguments);
				builder.updateToolResult(synthetic);
				builder.appendMessage(synthetic);
				await h.render();
				const cards = h.findAll(node => node.k === "tool");
				expect(cards.map(node => node.id)).toEqual([streamedId]);
				expect(toolProps(cards[0])?.status).toBe("error");
				expect(cards[0]?.c?.find(node => node.k === "ansi")?.p?.text).toContain(failed.errorMessage);
				const settled = cards.map(node => ({
					status: toolProps(node)?.status,
					output: node.c?.find(child => child.k === "ansi")?.p?.text,
				}));
				builder.rebuild(recorded([failed, synthetic]));
				await h.render();
				expect(
					h
						.findAll(node => node.k === "tool")
						.map(node => ({
							status: toolProps(node)?.status,
							output: node.c?.find(child => child.k === "ansi")?.p?.text,
						})),
				).toEqual(settled);
				expect(h.errors).toEqual([]);
			} finally {
				builder.dispose();
			}
		},
	);

	it("keeps each request's computed usage beside its tools while a background task stays parked", async () => {
		let builder!: ChatTranscriptBuilder;
		const h = await startWith(h => {
			builder = new ChatTranscriptBuilder({
				ui: h.tui,
				cwd: "/tmp",
				isBuiltInTool: () => false,
				requestRender: () => h.tui.requestRender(),
				displayPreferences: {
					hideToolActivity: false,
					readToolResultPreview: true,
					showImages: false,
					cacheMissMarker: false,
					showTokenUsage: true,
					showTurnTime: false,
					advisorCollapsedLines: 0,
				},
			});
			h.tui.addChild(builder.container);
		});
		try {
			const dispatch = {
				...assistant(
					[{ type: "toolCall", id: "parked-task", name: "task", arguments: { task: "Investigate elsewhere" } }],
					{ ...USAGE, input: 11, cacheWrite: 4, output: 14 },
				),
				stopReason: "toolUse" as const,
				duration: 2_000,
				ttft: 300,
			};
			const parked = {
				...toolResult("parked-task", "Working in background", "task"),
				details: { async: { state: "running" } },
			};
			const read = {
				...assistant(
					[{ type: "toolCall", id: "foreground-read", name: "read", arguments: { path: "usage-anchor.ts" } }],
					{ ...USAGE, input: 23, cacheWrite: 9, output: 27 },
				),
				stopReason: "toolUse" as const,
				duration: 1_500,
				ttft: 500,
			};
			const readResult = toolResult("foreground-read", "export const answer = 42;", "read");
			const answer = {
				...assistant([{ type: "text", text: "Foreground answer" }], { ...USAGE, input: 37, output: 40 }),
				duration: 4_000,
			};
			const finished = {
				...toolResult("parked-task", "Background answer", "task"),
				details: { async: { state: "completed" } },
			};
			builder.updateAssistant(dispatch);
			builder.updateAssistant(dispatch, false);
			builder.updateToolResult(parked);
			await h.render();
			const backgroundId = h.find(node => node.p?.role === "omp.tool.task")!.id;
			builder.updateAssistant(read);
			await h.render();
			expect(toolProps(h.byId(backgroundId))?.status).toBe("running");
			expect(h.findAll(node => node.p?.role === "omp.usage.turn")).toHaveLength(1);
			builder.updateAssistant(read, false);
			builder.updateToolResult(readResult);
			builder.updateAssistant(answer);
			await h.render();
			const readGroup = h.find(node => node.p?.role === "omp.tool.read")!;
			const readUsage = h.find(node => node.p?.role === "omp.usage")!;
			expect(readGroup.c?.some(node => node.id === readUsage.id)).toBe(true);
			expect(renderedText(readUsage)).toContain("32");
			expect(renderedText(readUsage)).toContain("27");
			expect(renderedText(readUsage)).toContain("0.5s");
			expect(renderedText(readUsage)).toContain("18.0/s");
			builder.updateAssistant(answer, false);
			builder.updateToolResult(finished, true);
			await h.render();
			expect(toolProps(h.byId(backgroundId))?.status).toBe("done");
			expect(
				h.findAll(node => node.k === "rate").map(node => (node.k === "rate" ? node.p?.value : undefined)),
			).toEqual([7, 10]);
			const rows = h.findAll(node => node.p?.role === "omp.usage.turn").map(renderedText);
			expect(rows).toHaveLength(2);
			expect(rows[0]).toContain("in 15 · out 14");
			expect(rows[0]).toContain("ttft 0.3s");
			expect(rows[1]).toContain("in 37 · out 40");
			const visibleOrder = (): string[] =>
				h
					.findAll(node => node.k === "md" || node.k === "tool" || node.p?.role === "omp.usage.turn")
					.map(node => (node.k === "md" ? markdownText(node)! : (node.p?.role as string)));
			expect(visibleOrder()).toEqual([
				"omp.tool.task",
				"omp.usage.turn",
				"omp.tool.read",
				"Foreground answer",
				"omp.usage.turn",
			]);
			builder.rebuild(recorded([dispatch, parked, read, readResult, answer, finished]));
			await h.render();
			expect(h.findAll(node => node.p?.role === "omp.usage.turn").map(renderedText)).toEqual(rows);
			expect(
				h.findAll(node => node.k === "rate").map(node => (node.k === "rate" ? node.p?.value : undefined)),
			).toEqual([7, 10]);
			expect(renderedText(h.find(node => node.p?.role === "omp.usage")!)).toEqual(renderedText(readUsage));
			expect(visibleOrder()).toEqual([
				"omp.tool.task",
				"omp.usage.turn",
				"omp.tool.read",
				"Foreground answer",
				"omp.usage.turn",
			]);
			expect(h.errors).toEqual([]);
		} finally {
			builder.dispose();
		}
	});

	it.each(["", "shared-provider-id"])(
		"orders split sibling cards and post-tool prose like replay while retaining the last %j card",
		async providerId => {
			let builder!: ChatTranscriptBuilder;
			const h = await startWith(h => {
				builder = new ChatTranscriptBuilder({
					ui: h.tui,
					cwd: "/tmp",
					isBuiltInTool: () => false,
					requestRender: () => h.tui.requestRender(),
				});
				h.tui.addChild(builder.container);
			});
			try {
				const first = {
					type: "toolCall" as const,
					id: "split-first",
					name: "lookup_thing",
					arguments: { q: "first query" },
				};
				const second = { ...first, id: "split-second", arguments: { q: "second query" } };
				const final = assistant([
					{ type: "text", text: "Intro" },
					first,
					{ type: "text", text: "First progress" },
					second,
					{ type: "text", text: "Second answer" },
				]);
				const shared = assistant(
					final.content.map(block => (block.type === "toolCall" ? { ...block, id: providerId } : block)),
				);
				builder.updateAssistant(shared);
				await h.render();
				const retainedCardId = h.find(node => node.k === "tool")!.id;
				const retainedProseId = h.find(node => node.k === "md" && markdownText(node) === "Second answer")?.id;
				builder.updateAssistant(final, false);
				builder.updateToolResult(toolResult(first.id, "First result"));
				builder.updateToolResult(toolResult(second.id, "Second result"));
				await h.render();
				const cards = h.findAll(node => node.k === "tool");
				expect(cards).toHaveLength(2);
				expect(cards[1]?.id).toBe(retainedCardId);
				if (providerId !== "") {
					expect(retainedProseId).toBeDefined();
					expect(h.byId(retainedProseId!)?.p).toMatchObject({ text: "Second answer" });
				}
				const visibleTimeline = (): (string | undefined)[] =>
					h
						.findAll(node => node.k === "tool" || node.k === "md")
						.map(node =>
							node.k === "tool" ? node.c?.find(child => child.k === "ansi")?.p?.text : markdownText(node),
						);
				expect(visibleTimeline()).toEqual([
					"Intro",
					"First result",
					"First progress",
					"Second result",
					"Second answer",
				]);
				builder.rebuild(
					recorded([final, toolResult(first.id, "First result"), toolResult(second.id, "Second result")]),
				);
				await h.render();
				expect(visibleTimeline()).toEqual([
					"Intro",
					"First result",
					"First progress",
					"Second result",
					"Second answer",
				]);
				expect(h.errors).toEqual([]);
			} finally {
				builder.dispose();
			}
		},
	);
});
