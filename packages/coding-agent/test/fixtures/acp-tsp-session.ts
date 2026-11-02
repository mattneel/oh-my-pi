import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ONE_PIXEL_PNG } from "../helpers/skill-image-vision";

// Seed real on-disk session history in the same isolated environment as the CLI.
// No provider, model request, extension, or terminal is needed to write a journal.
const session = SessionManager.create(process.cwd());
const imageCount = Number(process.argv[2] ?? 1);
const statusUsage = process.argv[3] === "status";
const png = Buffer.from(ONE_PIXEL_PNG, "base64");
session.appendMessage({ role: "user", content: "Find the saved surface fixture", timestamp: 1 });
session.appendMessage({
	role: "assistant",
	content: [
		{ type: "text", text: "Saved assistant transcript" },
		{ type: "toolCall", id: "surface-lookup", name: "lookup_thing", arguments: { q: "surface fixture" } },
		...(statusUsage
			? [{ type: "toolCall" as const, id: "surface-status", name: "inspect_status", arguments: {} }]
			: []),
	],
	api: "anthropic-messages",
	provider: "acp-fixture",
	model: "transcript",
	stopReason: "toolUse",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	timestamp: 2,
});
session.appendMessage({
	role: "toolResult",
	toolCallId: "surface-lookup",
	toolName: "lookup_thing",
	content: [
		{ type: "text", text: Array.from({ length: 30 }, (_, i) => `Saved result row ${i}`).join("\n") },
		...Array.from({ length: imageCount }, (_, index) => ({
			type: "image" as const,
			// PNG decoders ignore bytes after IEND; the suffix gives each fixture a distinct blob ID.
			data:
				imageCount === 1
					? ONE_PIXEL_PNG
					: Buffer.concat([png, Buffer.from(`fixture image ${index}`)]).toString("base64"),
			mimeType: "image/png",
		})),
	],
	isError: false,
	timestamp: 3,
});
if (statusUsage) {
	session.appendMessage({
		role: "toolResult",
		toolCallId: "surface-status",
		toolName: "inspect_status",
		content: [{ type: "text", text: "Status inspection from the saved session's second tool." }],
		isError: false,
		timestamp: 4,
	});
	session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Saved status overlay usage" }],
		api: "anthropic-messages",
		provider: "acp-fixture",
		model: "transcript",
		stopReason: "stop",
		usage: {
			input: 1024,
			output: 64,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1088,
			cost: { input: 0.1, output: 0.025, cacheRead: 0, cacheWrite: 0, total: 0.125 },
		},
		timestamp: 5,
	});
}
await session.ensureOnDisk();
await session.flush();
await session.close();
process.stdout.write(`${JSON.stringify({ sessionId: session.getSessionId() })}\n`);
