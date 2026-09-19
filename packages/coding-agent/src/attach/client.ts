import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import { createInterface } from "node:readline/promises";
import { ProcessTerminal } from "@oh-my-pi/pi-tui";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { APP_NAME, isRecord } from "@oh-my-pi/pi-utils";
import {
	ATTACH_PROTOCOL_VERSION,
	ATTACH_RECONNECT_GRACE_MS,
	type AttachClientFrame,
	type AttachHelloFrame,
	type AttachServerFrame,
	encodeAttachFrame,
} from "./protocol";
import { type LiveSessionRecord, readLiveSessionRecords, removeLiveSession } from "./registry";

export interface AttachCommandOptions {
	target?: string;
	all?: boolean;
	force?: boolean;
	yes?: boolean;
	list?: boolean;
	json?: boolean;
}

function socketRequest(record: LiveSessionRecord, frame: AttachHelloFrame): Promise<AttachServerFrame> {
	const { promise, resolve, reject } = Promise.withResolvers<AttachServerFrame>();
	const socket = net.createConnection({ path: record.metadata.endpoint });
	let buffer = "";
	const timer = setTimeout(() => {
		socket.destroy();
		reject(new Error("attach status probe timed out"));
	}, 2_000);
	const cleanup = (): void => clearTimeout(timer);
	socket.once("connect", () => socket.write(encodeAttachFrame(frame)));
	socket.on("data", data => {
		buffer += data.toString("utf8");
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		cleanup();
		try {
			resolve(JSON.parse(buffer.slice(0, newline)) as AttachServerFrame);
		} catch (error) {
			reject(error);
		}
		socket.end();
	});
	socket.once("error", error => {
		cleanup();
		reject(error);
	});
	return promise;
}

function hello(record: LiveSessionRecord, action: AttachHelloFrame["action"]): AttachHelloFrame {
	return {
		type: "hello",
		protocolVersion: ATTACH_PROTOCOL_VERSION,
		action,
		sessionId: record.metadata.sessionId,
		token: record.token,
	};
}

/**
 * A host killed without running its shutdown path leaves its endpoint directory — including the
 * shared secret — behind. Discovery is the only routine that learns the endpoint is gone, so it
 * reclaims the directory. A probe that merely timed out is left alone: that host may just be busy.
 */
function isDeadEndpoint(error: unknown): boolean {
	const code = isRecord(error) ? error.code : undefined;
	return code === "ENOENT" || code === "ECONNREFUSED";
}

export async function discoverLiveSessions(): Promise<LiveSessionRecord[]> {
	const records = await readLiveSessionRecords();
	const live = await Promise.all(
		records.map(async record => {
			try {
				const frame = await socketRequest(record, hello(record, "status"));
				if (frame.type !== "status") return null;
				return { ...record, snapshot: frame.snapshot };
			} catch (error) {
				if (isDeadEndpoint(error)) {
					await removeLiveSession(record.metadata.hostId).catch(() => {});
				}
				return null;
			}
		}),
	);
	return live
		.filter((record): record is LiveSessionRecord & { snapshot: NonNullable<LiveSessionRecord["snapshot"]> } =>
			Boolean(record),
		)
		.sort((left, right) => right.snapshot.updatedAt - left.snapshot.updatedAt);
}

function selectRecord(records: LiveSessionRecord[], target: string | undefined): LiveSessionRecord {
	if (!target) {
		if (records.length === 1) return records[0];
		throw new Error(
			records.length === 0
				? "No live attachable sessions."
				: `Multiple live sessions match. Choose one with ${APP_NAME} attach <session-id>.`,
		);
	}
	const matches = records.filter(record => record.metadata.sessionId.startsWith(target));
	if (matches.length === 1) return matches[0];
	if (matches.length === 0) throw new Error(`No live session matches ${target}.`);
	throw new Error(`Session prefix ${target} is ambiguous: ${matches.map(item => item.metadata.sessionId).join(", ")}`);
}

export function renderLiveSessionList(records: LiveSessionRecord[], json: boolean): string {
	if (json) {
		return JSON.stringify({ schemaVersion: 1, sessions: records.map(record => record.snapshot) }, null, 2);
	}
	if (records.length === 0) return "No live attachable sessions.";
	return records
		.map(record => {
			const snapshot = record.snapshot!;
			return [
				snapshot.sessionId,
				snapshot.hostMode,
				shortenPath(snapshot.project),
				snapshot.activity,
				snapshot.controlState,
			].join("\t");
		})
		.join("\n");
}

async function confirmForce(record: LiveSessionRecord): Promise<boolean> {
	const snapshot = record.snapshot;
	const label = snapshot?.controller?.label ?? "the current terminal";
	const readline = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const line = (await readline.question(`Force takeover will displace ${label}. Continue? [y/N] `))
			.trim()
			.toLowerCase();
		return line === "y" || line === "yes";
	} finally {
		readline.close();
	}
}

export async function runAttachCommand(options: AttachCommandOptions): Promise<number> {
	if (options.yes && !options.force) throw new Error("--yes requires --force");
	const currentProject = await fsRealpath(process.cwd());
	const discovered = await discoverLiveSessions();
	const records = options.all
		? discovered
		: discovered.filter(record => pathEquals(record.metadata.project, currentProject));
	if (options.list || options.json) {
		process.stdout.write(`${renderLiveSessionList(records, options.json === true)}\n`);
		return 0;
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("interactive attach requires a TTY");
	const record = selectRecord(records, options.target);
	if (options.force && !options.yes && !(await confirmForce(record))) return 0;
	return runAttachedTerminal(record, options.force === true);
}

async function fsRealpath(value: string): Promise<string> {
	try {
		return await fs.realpath(value);
	} catch {
		return value;
	}
}

function pathEquals(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function runAttachedTerminal(record: LiveSessionRecord, force: boolean): Promise<number> {
	const terminal = new ProcessTerminal();
	let socket: net.Socket | undefined;
	let buffer = "";
	let inputSequence = 0;
	let epoch: number | undefined;
	let attachmentId: string | undefined;
	let resumeToken: string | undefined;
	let reconnectDeadline = Date.now() + ATTACH_RECONNECT_GRACE_MS;
	let detached = false;
	let suspendAfterDetach = false;
	const finished = Promise.withResolvers<number>();

	const send = (frame: AttachClientFrame): void => {
		if (socket && !socket.destroyed) socket.write(encodeAttachFrame(frame));
	};
	const stop = (code: number, destroySocket = true): void => {
		if (detached) return;
		detached = true;
		terminal.stop();
		if (destroySocket) socket?.destroy();
		else socket?.end();
		finished.resolve(code);
	};
	const finishRevocation = async (message: string): Promise<void> => {
		try {
			terminal.write(`\r\n${message}\r\n`);
			if (process.stdout.writableNeedDrain) await once(process.stdout, "drain");
			if (attachmentId) send({ type: "revocation_rendered", attachmentId });
			stop(1, false);
		} catch {
			stop(1);
		}
	};
	const connect = (action: AttachHelloFrame["action"]): void => {
		const next = net.createConnection({ path: record.metadata.endpoint });
		socket = next;
		buffer = "";
		next.once("connect", () => {
			next.write(
				encodeAttachFrame({
					...hello(record, action),
					rows: terminal.rows,
					columns: terminal.columns,
					attachmentId,
					resumeToken,
					expectedEpoch: force ? record.snapshot?.epoch : undefined,
				}),
			);
		});
		next.on("data", data => {
			buffer += data.toString("utf8");
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				let frame: AttachServerFrame;
				try {
					frame = JSON.parse(line) as AttachServerFrame;
				} catch {
					terminal.write("\r\nAttach host sent an invalid protocol frame.\r\n");
					stop(1);
					return;
				}
				if (frame.type === "accepted") {
					attachmentId = frame.attachmentId;
					resumeToken = frame.resumeToken;
					reconnectDeadline = frame.reconnectDeadlineMs;
					epoch = frame.epoch;
				} else if (frame.type === "control") {
					epoch = frame.epoch;
				} else if (frame.type === "output") {
					terminal.write(Buffer.from(frame.data, "base64").toString("utf8"));
					send({ type: "output_ack", sequence: frame.sequence });
				} else if (frame.type === "heartbeat") {
					reconnectDeadline = frame.reconnectDeadlineMs;
				} else if (frame.type === "revoked") {
					void finishRevocation(frame.message);
					return;
				} else if (frame.type === "detached") {
					terminal.write(`\r\n${frame.message}\r\n`);
					stop(0);
					if (suspendAfterDetach && process.platform !== "win32") process.kill(process.pid, "SIGTSTP");
				} else if (frame.type === "error") {
					terminal.write(`\r\n${frame.message}\r\nReason: ${frame.reason}\r\n`);
					stop(1);
				}
			}
		});
		next.once("close", () => {
			if (detached) return;
			if (!attachmentId || !resumeToken || Date.now() >= reconnectDeadline) {
				stop(1);
				return;
			}
			terminal.write("\r\nLIVE · RECONNECTING\r\n");
			setTimeout(() => {
				if (!detached && Date.now() < reconnectDeadline) connect("reconnect");
				else stop(1);
			}, 200);
		});
		next.once("error", () => {});
	};

	terminal.start(
		data => {
			if (data === "\x04") {
				send({ type: "detach", sequence: ++inputSequence });
				return;
			}
			if (data === "\x1a") {
				suspendAfterDetach = true;
				send({ type: "detach", sequence: ++inputSequence });
				return;
			}
			if (epoch !== undefined) {
				send({ type: "input", epoch, sequence: ++inputSequence, data: Buffer.from(data).toString("base64") });
			}
		},
		() => {
			if (epoch !== undefined) {
				send({
					type: "resize",
					epoch,
					sequence: ++inputSequence,
					rows: terminal.rows,
					columns: terminal.columns,
				});
			}
		},
		() => stop(1),
	);
	connect(force ? "force" : "attach");
	const heartbeat = setInterval(() => send({ type: "heartbeat", sequence: ++inputSequence }), 2_000);
	const code = await finished.promise;
	clearInterval(heartbeat);
	return code;
}
