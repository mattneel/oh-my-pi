import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	ATTACH_PROTOCOL_VERSION,
	type AttachClientFrame,
	type AttachServerFrame,
	encodeAttachFrame,
} from "../src/attach/protocol";
import { type LiveSessionRecord, readLiveSessionRecords } from "../src/attach/registry";

const FIXTURE = path.join(import.meta.dir, "fixtures", "live-attach-subprocess-host.ts");

interface Harness {
	proc: Bun.Subprocess;
	evidencePath: string;
	tempDir: string;
}

const harnesses: Harness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		harness.proc.kill();
		await harness.proc.exited;
		await fs.rm(harness.tempDir, { recursive: true, force: true });
	}
});

/** Reads newline-delimited protocol frames off a real socket, mirroring the shipped client's framing. */
class FrameReader {
	readonly socket: net.Socket;
	#buffer = "";
	readonly #frames: AttachServerFrame[] = [];

	constructor(socket: net.Socket) {
		this.socket = socket;
		socket.on("data", data => {
			this.#buffer += data.toString("utf8");
			while (true) {
				const newline = this.#buffer.indexOf("\n");
				if (newline < 0) break;
				this.#frames.push(JSON.parse(this.#buffer.slice(0, newline)) as AttachServerFrame);
				this.#buffer = this.#buffer.slice(newline + 1);
			}
		});
	}

	send(frame: AttachClientFrame): void {
		this.socket.write(encodeAttachFrame(frame));
	}

	async next(type: AttachServerFrame["type"], timeoutMs = 5_000): Promise<AttachServerFrame> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const index = this.#frames.findIndex(frame => frame.type === type);
			if (index >= 0) return this.#frames.splice(index, 1)[0]!;
			await Bun.sleep(5);
		}
		throw new Error(`timed out waiting for ${type}`);
	}

	/** Concatenated payload of every `output` frame seen so far, acknowledging each one. */
	drainOutput(): string {
		let text = "";
		for (const frame of this.#frames.splice(0)) {
			if (frame.type !== "output") continue;
			text += Buffer.from(frame.data, "base64").toString("utf8");
			this.send({ type: "output_ack", sequence: frame.sequence });
		}
		return text;
	}
}

async function startHostProcess(): Promise<{ harness: Harness; record: LiveSessionRecord }> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-attach-smoke-"));
	const evidencePath = path.join(tempDir, "evidence.json");
	const proc = Bun.spawn(["bun", "run", FIXTURE, evidencePath], {
		cwd: path.join(import.meta.dir, ".."),
		stdout: "pipe",
		stderr: "pipe",
	});
	const harness: Harness = { proc, evidencePath, tempDir };
	harnesses.push(harness);

	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let announced = "";
	while (!announced.includes("\n")) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`attach host exited before announcing a session: ${announced}`);
		announced += decoder.decode(value, { stream: true });
	}
	const sessionId = announced.slice(0, announced.indexOf("\n")).trim();

	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const record = (await readLiveSessionRecords()).find(entry => entry.metadata.sessionId === sessionId);
		if (record) return { harness, record };
		await Bun.sleep(20);
	}
	throw new Error(`attach host never published session ${sessionId}`);
}

async function connect(record: LiveSessionRecord): Promise<FrameReader> {
	const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
	const socket = net.createConnection(record.metadata.endpoint);
	socket.once("connect", () => resolve(socket));
	socket.once("error", reject);
	return new FrameReader(await promise);
}

describe("live attach cross-process smoke", () => {
	test("drives a separate host process end to end over its published socket", async () => {
		const { harness, record } = await startHostProcess();

		// The registry is the only channel: endpoint path and shared secret both come from disk.
		expect(record.metadata.hostMode).toBe("rpc");
		expect(record.token.length).toBeGreaterThan(0);

		const client = await connect(record);
		client.send({
			type: "hello",
			protocolVersion: ATTACH_PROTOCOL_VERSION,
			action: "attach",
			sessionId: record.metadata.sessionId,
			token: record.token,
			columns: 110,
			rows: 32,
		});
		const accepted = await client.next("accepted");
		if (accepted.type !== "accepted") throw new Error("expected accepted");
		const control = await client.next("control");
		if (control.type !== "control") throw new Error("expected control");

		client.send({
			type: "input",
			epoch: control.epoch,
			sequence: 1,
			data: Buffer.from("attach-smoke").toString("base64"),
		});

		let echoed = "";
		const echoDeadline = Date.now() + 5_000;
		while (!echoed.includes("HOST_ECHO:attach-smoke") && Date.now() < echoDeadline) {
			echoed += client.drainOutput();
			await Bun.sleep(5);
		}
		expect(echoed).toContain("HOST_CONTROLLED");
		expect(echoed).toContain("HOST_ECHO:attach-smoke");

		client.send({ type: "detach", sequence: 2 });
		expect(await client.next("detached")).toMatchObject({ type: "detached" });

		expect(await harness.proc.exited).toBe(0);
		const evidence = (await Bun.file(harness.evidencePath).json()) as { received: string; controlState: string };
		expect(evidence).toEqual({ received: "attach-smoke", controlState: "available" });

		// The host removes its endpoint directory on shutdown, so the secret does not outlive it.
		const remaining = (await readLiveSessionRecords()).find(
			entry => entry.metadata.sessionId === record.metadata.sessionId,
		);
		expect(remaining).toBeUndefined();
	}, 30_000);
});
