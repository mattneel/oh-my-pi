import { afterEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import { LiveAttachHost } from "../src/attach/host";
import {
	ATTACH_PROTOCOL_VERSION,
	type AttachClientFrame,
	type AttachServerFrame,
	encodeAttachFrame,
} from "../src/attach/protocol";
import { type LiveSessionRecord, readLiveSessionRecords } from "../src/attach/registry";
import { AttachedSocketTerminal, SwitchableTerminal } from "../src/attach/terminal";
import type { AgentSession } from "../src/session/agent-session";

class SocketFrames {
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
				const line = this.#buffer.slice(0, newline);
				this.#buffer = this.#buffer.slice(newline + 1);
				this.#frames.push(JSON.parse(line) as AttachServerFrame);
			}
		});
	}

	send(frame: AttachClientFrame): void {
		this.socket.write(encodeAttachFrame(frame));
	}

	async next(type: AttachServerFrame["type"], timeoutMs = 500): Promise<AttachServerFrame> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const index = this.#frames.findIndex(frame => frame.type === type);
			if (index >= 0) return this.#frames.splice(index, 1)[0]!;
			await Bun.sleep(2);
		}
		throw new Error(`timed out waiting for attach frame: ${type}`);
	}
}

const hosts: LiveAttachHost[] = [];

afterEach(async () => {
	for (const host of hosts.splice(0)) await host.close();
});

function fakeSession(sessionId: string, streaming = false): AgentSession {
	return {
		sessionId,
		get isStreaming() {
			return streaming;
		},
		subscribe: () => () => {},
	} as unknown as AgentSession;
}

async function startHost(options?: {
	mode?: "interactive" | "rpc";
	local?: AttachedSocketTerminal;
	forceTimeoutMs?: number;
	reconnectGraceMs?: number;
	outputBacklogBytes?: number;
}): Promise<{ host: LiveAttachHost; record: LiveSessionRecord; terminal: SwitchableTerminal; input: string[] }> {
	const sessionId = crypto.randomUUID();
	const terminal = new SwitchableTerminal(options?.local);
	const input: string[] = [];
	terminal.start(
		data => input.push(data),
		() => {},
	);
	const host = new LiveAttachHost({
		session: fakeSession(sessionId),
		terminal,
		hostMode: options?.mode ?? "rpc",
		project: process.cwd(),
		forceTimeoutMs: options?.forceTimeoutMs,
		reconnectGraceMs: options?.reconnectGraceMs,
		outputBacklogBytes: options?.outputBacklogBytes,
	});
	hosts.push(host);
	await host.start();
	const record = (await readLiveSessionRecords()).find(candidate => candidate.metadata.sessionId === sessionId);
	if (!record) throw new Error("live attach test host was not published");
	return { host, record, terminal, input };
}

async function connect(
	record: LiveSessionRecord,
	frame: Omit<Extract<AttachClientFrame, { type: "hello" }>, "type" | "protocolVersion" | "sessionId" | "token">,
): Promise<SocketFrames> {
	const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
	const socket = net.createConnection(record.metadata.endpoint);
	socket.once("connect", () => resolve(socket));
	socket.once("error", reject);
	const connected = await promise;
	const frames = new SocketFrames(connected);
	frames.send({
		type: "hello",
		protocolVersion: ATTACH_PROTOCOL_VERSION,
		sessionId: record.metadata.sessionId,
		token: record.token,
		...frame,
	});
	return frames;
}

async function attach(record: LiveSessionRecord): Promise<{
	client: SocketFrames;
	attachmentId: string;
	resumeToken: string;
	epoch: number;
}> {
	const client = await connect(record, { action: "attach", columns: 100, rows: 30 });
	const accepted = await client.next("accepted");
	if (accepted.type !== "accepted") throw new Error("expected accepted frame");
	const control = await client.next("control");
	if (control.type !== "control") throw new Error("expected control frame");
	return {
		client,
		attachmentId: accepted.attachmentId,
		resumeToken: accepted.resumeToken,
		epoch: control.epoch,
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(2);
	if (!predicate()) throw new Error("timed out waiting for condition");
}

describe("live terminal attachment", () => {
	test("force takeover fences the old epoch and commits after the revocation timeout", async () => {
		const { host, record, terminal, input } = await startHost({ forceTimeoutMs: 30 });
		const first = await attach(record);
		first.client.send({
			type: "input",
			epoch: first.epoch,
			sequence: 1,
			data: Buffer.from("first").toString("base64"),
		});
		await waitFor(() => input.join("") === "first");

		const replacement = await connect(record, {
			action: "force",
			expectedEpoch: first.epoch,
			columns: 120,
			rows: 40,
		});
		const pending = await replacement.next("accepted");
		expect(pending).toMatchObject({ type: "accepted", state: "control_pending" });
		expect(await first.client.next("revoked")).toMatchObject({ type: "revoked" });
		first.client.send({
			type: "input",
			epoch: first.epoch,
			sequence: 2,
			data: Buffer.from("blocked").toString("base64"),
		});
		await Bun.sleep(10);
		expect(input).toEqual(["first"]);
		first.client.send({ type: "resize", epoch: first.epoch, sequence: 3, columns: 200, rows: 50 });

		const control = await replacement.next("control", 250);
		if (control.type !== "control") throw new Error("expected replacement control frame");
		expect({ columns: terminal.columns, rows: terminal.rows }).toEqual({ columns: 120, rows: 40 });
		replacement.send({ type: "resize", epoch: control.epoch, sequence: 1, columns: 132, rows: 43 });
		await waitFor(() => terminal.columns === 132 && terminal.rows === 43);
		replacement.send({
			type: "input",
			epoch: control.epoch,
			sequence: 2,
			data: Buffer.from("second").toString("base64"),
		});
		await waitFor(() => input.join("") === "firstsecond");
		replacement.send({ type: "detach", sequence: 3 });
		expect(await replacement.next("detached")).toMatchObject({ type: "detached" });
		await waitFor(() => host.ownershipSnapshot.controlState === "available");
	});

	test("a dropped controller can reconnect during the grace period with the same epoch", async () => {
		const { host, record, input } = await startHost({ reconnectGraceMs: 100 });
		const first = await attach(record);
		first.client.socket.destroy();
		await waitFor(() => host.ownershipSnapshot.controlState === "reconnecting");

		const resumed = await connect(record, {
			action: "reconnect",
			attachmentId: first.attachmentId,
			resumeToken: first.resumeToken,
			columns: 90,
			rows: 25,
		});
		const accepted = await resumed.next("accepted");
		expect(accepted).toMatchObject({ type: "accepted", state: "control", epoch: first.epoch });
		resumed.send({ type: "input", epoch: first.epoch, sequence: 1, data: Buffer.from("resumed").toString("base64") });
		await waitFor(() => input.join("") === "resumed");
		resumed.send({ type: "detach", sequence: 2 });
		await resumed.next("detached");
	});

	test("a disconnected force claimant restores the existing controller", async () => {
		const { host, record, input } = await startHost({ forceTimeoutMs: 100 });
		const first = await attach(record);
		const replacement = await connect(record, {
			action: "force",
			expectedEpoch: first.epoch,
			columns: 80,
			rows: 24,
		});
		await replacement.next("accepted");
		await first.client.next("revoked");
		replacement.socket.destroy();
		await waitFor(() => host.ownershipSnapshot.controlState === "controlled");

		first.client.send({
			type: "input",
			epoch: first.epoch,
			sequence: 1,
			data: Buffer.from("still-controller").toString("base64"),
		});
		await waitFor(() => input.join("") === "still-controller");
		first.client.send({ type: "detach", sequence: 2 });
		await first.client.next("detached");
	});

	test("unacknowledged output beyond the cap releases a slow controller", async () => {
		const { host, record, terminal } = await startHost({ outputBacklogBytes: 8 });
		await attach(record);
		terminal.write("more than eight bytes");
		await waitFor(() => host.ownershipSnapshot.controlState === "available");
	});

	test("a force takeover aimed at a claim awaiting a safe boundary uses the published epoch", async () => {
		const streamingSession = { streaming: true };
		const sessionId = crypto.randomUUID();
		const terminal = new SwitchableTerminal();
		terminal.start(
			() => {},
			() => {},
		);
		const host = new LiveAttachHost({
			session: {
				sessionId,
				get isStreaming() {
					return streamingSession.streaming;
				},
				subscribe: () => () => {},
			} as unknown as AgentSession,
			terminal,
			hostMode: "rpc",
			project: process.cwd(),
			forceTimeoutMs: 30,
		});
		hosts.push(host);
		await host.start();
		const record = (await readLiveSessionRecords()).find(candidate => candidate.metadata.sessionId === sessionId);
		if (!record) throw new Error("live attach test host was not published");

		// The first claimant cannot be granted control: the session is mid-turn.
		const watcher = await connect(record, { action: "attach", columns: 100, rows: 30 });
		expect(await watcher.next("accepted")).toMatchObject({ type: "accepted", state: "control_pending" });
		expect(host.ownershipSnapshot.controlState).toBe("control_pending");

		// A claimant that read the published epoch must be accepted rather than rejected as stale.
		const replacement = await connect(record, {
			action: "force",
			expectedEpoch: host.ownershipSnapshot.epoch,
			columns: 80,
			rows: 24,
		});
		expect(await replacement.next("accepted")).toMatchObject({ type: "accepted", state: "control_pending" });
		expect(await watcher.next("revoked")).toMatchObject({ type: "revoked" });

		streamingSession.streaming = false;
		expect(await replacement.next("control", 500)).toMatchObject({ type: "control" });
	});

	test("a claim dropped before its safe boundary keeps its reconnect grace", async () => {
		const streamingSession = { streaming: true };
		const sessionId = crypto.randomUUID();
		const terminal = new SwitchableTerminal();
		const input: string[] = [];
		terminal.start(
			data => input.push(data),
			() => {},
		);
		const listeners: Array<() => void> = [];
		const host = new LiveAttachHost({
			session: {
				sessionId,
				get isStreaming() {
					return streamingSession.streaming;
				},
				subscribe: (listener: () => void) => {
					listeners.push(listener);
					return () => {};
				},
			} as unknown as AgentSession,
			terminal,
			hostMode: "rpc",
			project: process.cwd(),
			reconnectGraceMs: 5_000,
		});
		hosts.push(host);
		await host.start();
		const record = (await readLiveSessionRecords()).find(candidate => candidate.metadata.sessionId === sessionId);
		if (!record) throw new Error("live attach test host was not published");

		const watcher = await connect(record, { action: "attach", columns: 100, rows: 30 });
		const accepted = await watcher.next("accepted");
		if (accepted.type !== "accepted") throw new Error("expected accepted frame");
		watcher.socket.destroy();
		await waitFor(() => host.ownershipSnapshot.controller?.state === "reconnecting");

		const resumed = await connect(record, {
			action: "reconnect",
			attachmentId: accepted.attachmentId,
			resumeToken: accepted.resumeToken,
			columns: 90,
			rows: 25,
		});
		expect(await resumed.next("accepted")).toMatchObject({ type: "accepted", state: "control_pending" });

		// Reaching the safe boundary now promotes the resumed claim instead of expiring it.
		streamingSession.streaming = false;
		for (const listener of listeners) listener();
		const control = await resumed.next("control", 500);
		if (control.type !== "control") throw new Error("expected control frame");
		resumed.send({
			type: "input",
			epoch: control.epoch,
			sequence: 1,
			data: Buffer.from("resumed").toString("base64"),
		});
		await waitFor(() => input.join("") === "resumed");
	});

	test("the displaced interactive frontend parks and resumes after detach", async () => {
		const localOutput: string[] = [];
		const local = new AttachedSocketTerminal(80, 24, data => localOutput.push(data));
		const { host, record, input } = await startHost({
			mode: "interactive",
			local,
			forceTimeoutMs: 20,
		});
		local.input("before");
		await waitFor(() => input.join("") === "before");

		const replacement = await connect(record, {
			action: "force",
			expectedEpoch: host.ownershipSnapshot.epoch,
			columns: 80,
			rows: 24,
		});
		await replacement.next("accepted");
		local.input("fenced");
		await Bun.sleep(10);
		expect(input).toEqual(["before"]);
		const control = await replacement.next("control", 250);
		if (control.type !== "control") throw new Error("expected replacement control frame");
		expect(localOutput.join("")).toContain("frontend will park");
		replacement.send({ type: "detach", sequence: 1 });
		await replacement.next("detached");
		await waitFor(() => host.ownershipSnapshot.controller?.label === "Original terminal");
		local.input("after");
		await waitFor(() => input.join("") === "beforeafter");
		expect(localOutput.join("")).toContain("resumed automatically");
	});
});
