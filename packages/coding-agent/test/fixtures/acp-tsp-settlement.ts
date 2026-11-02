import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

/** Real extension lifecycle and subprocess ownership, controlled by the wire test's HTTP peer. */
export default function (pi: ExtensionAPI): void {
	const endpoint = process.env.OMP_ACP_SETTLEMENT_URL;
	if (!endpoint) throw new Error("Missing ACP settlement fixture endpoint");
	const mark = async (name: string, data?: Record<string, unknown>): Promise<void> => {
		const response = await fetch(new URL(`/fixture/${name}`, endpoint), {
			method: "POST",
			body: JSON.stringify(data ?? {}),
		});
		if (!response.ok) throw new Error(`Settlement fixture ${name}: ${response.status}`);
		await response.text();
	};

	pi.on("session_start", (_event, ctx) => {
		if (process.env.OMP_ACP_SETTLEMENT_START_ASK === "1") {
			// Extensions may return while their UI callback is still in flight.
			void ctx.ui.confirm("Startup settlement", "Hold this session's startup callback.");
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (event.willContinue) return;
		if (process.env.OMP_ACP_SETTLEMENT_END_ASK === "1") {
			void ctx.ui.confirm("End settlement", "Hold this turn's final callback.");
		}
		await mark("end-entered");
		pi.sendMessage(
			{ customType: "settlement-cleanup", content: "Turn cleanup completed.", display: true },
			{ triggerTurn: false },
		);
		await mark("end-completed");
	});

	pi.registerTool({
		name: "settlement_process",
		label: "Settlement process",
		description: "Own a subprocess until cancellation and reap it before completing the tool.",
		parameters: pi.zod.object({}),
		async execute(_toolCallId, _params, signal, onUpdate, ctx) {
			const child = Bun.spawn(["cat"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
			const aborted = Promise.withResolvers<void>();
			const abort = (): void => aborted.resolve();
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
			try {
				// The child echoes its readiness token: no timer stands in for process startup.
				child.stdin.write("settlement-process-ready\n");
				await child.stdin.flush();
				const reader = child.stdout.getReader();
				try {
					const decoder = new TextDecoder();
					let token = "";
					while (!token.endsWith("\n")) {
						const chunk = await reader.read();
						if (chunk.done) throw new Error("Settlement subprocess exited before readiness");
						token += decoder.decode(chunk.value, { stream: true });
					}
					if (token !== "settlement-process-ready\n") {
						throw new Error("Settlement subprocess did not acknowledge readiness");
					}
				} finally {
					reader.releaseLock();
				}
				if (process.env.OMP_ACP_SETTLEMENT_TOOL_ASK === "1") {
					void ctx.ui.confirm("Running settlement", "Hold the running tool's callback.");
				}
				await mark("tool-ready", { pid: child.pid });
				await aborted.promise;
				// The peer holds this HTTP response while the real child is still alive.
				await mark("abort-entered");
				child.kill();
				await child.exited;
				onUpdate?.({ content: [{ type: "text", text: "Settlement subprocess reaped." }], details: {} });
				await mark("process-reaped", { pid: child.pid });
				return { content: [{ type: "text", text: "Settlement subprocess reaped." }], details: {} };
			} finally {
				signal?.removeEventListener("abort", abort);
				child.kill();
				await child.exited;
			}
		},
	});
}
