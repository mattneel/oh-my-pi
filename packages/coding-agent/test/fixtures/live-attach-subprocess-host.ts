import { LiveAttachHost } from "../../src/attach/host";
import { SwitchableTerminal } from "../../src/attach/terminal";
import type { AgentSession } from "../../src/session/agent-session";

const evidencePath = process.argv[2];
if (!evidencePath) throw new Error("evidence path required");

const sessionId = crypto.randomUUID();
const session = {
	sessionId,
	isStreaming: false,
	subscribe: () => () => {},
} as unknown as AgentSession;
const terminal = new SwitchableTerminal();
let received = "";
terminal.start(
	data => {
		received += data;
		terminal.write(`HOST_ECHO:${data}`);
	},
	() => {},
);
const host = new LiveAttachHost({
	session,
	terminal,
	hostMode: "rpc",
	project: process.cwd(),
	onOwnershipChanged: snapshot => {
		if (snapshot.controlState === "controlled") terminal.write("HOST_CONTROLLED\r\n");
	},
});

await host.start();
process.stdout.write(`${sessionId}\n`);

const deadline = Date.now() + 15_000;
while ((received !== "attach-smoke" || host.ownershipSnapshot.controlState !== "available") && Date.now() < deadline) {
	await Bun.sleep(10);
}
await Bun.write(evidencePath, `${JSON.stringify({ received, controlState: host.ownershipSnapshot.controlState })}\n`);
await host.close();
if (received !== "attach-smoke") process.exitCode = 1;
