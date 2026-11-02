import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import * as path from "node:path";
import {
	encodeTspHelloQuery,
	encodeTspJson,
	encodeTspMessage,
	type TspHello,
	TspReader,
} from "@oh-my-pi/pi-tui/native/encode";
import { connectTspTransport, type TspTransport } from "@oh-my-pi/pi-tui/native/transport";
import type { RenderScheduler } from "@oh-my-pi/pi-tui/tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type TspEvent, TSP_VERSION } from "@oh-my-pi/pi-wire";
import { ManualScheduler, TspTestTerminal } from "./tsp-harness";

const HELLO: TspHello = {
	r: "hello",
	v: TSP_VERSION,
	term: "tern €🙂",
	kinds: ["col", "text", "editor"],
	features: ["blobs"],
	cols: 98,
	dark: false,
	apc: 8192,
	credits: 2,
};

function frames(wire: string): string[] {
	return wire
		.split("\x1b\\")
		.filter(Boolean)
		.map(frame => `${frame}\x1b\\`);
}

async function nextTurn(): Promise<void> {
	const turn = Promise.withResolvers<void>();
	setImmediate(turn.resolve);
	await turn.promise;
}

class Peer {
	readonly socket: Socket;
	readonly closed: Promise<void>;
	output = "";
	#changed = Promise.withResolvers<void>();
	#ended = false;

	constructor(socket: Socket) {
		this.socket = socket;
		const closed = Promise.withResolvers<void>();
		this.closed = closed.promise;
		socket.setEncoding("utf8");
		socket.on("data", (data: string) => {
			this.output += data;
			this.#changed.resolve();
			this.#changed = Promise.withResolvers<void>();
		});
		socket.on("error", () => {});
		socket.once("close", () => {
			this.#ended = true;
			this.#changed.resolve();
			closed.resolve();
		});
	}

	async waitForOutput(expected: string): Promise<void> {
		while (!this.output.includes(expected)) {
			if (this.#ended) throw new Error(`peer closed before receiving ${JSON.stringify(expected)}`);
			await this.#changed.promise;
		}
	}

	async write(data: string | Uint8Array): Promise<void> {
		const written = Promise.withResolvers<void>();
		this.socket.write(data, error => {
			if (error) written.reject(error);
			else written.resolve();
		});
		await written.promise;
	}

	async fragment(wire: string): Promise<void> {
		const bytes = Buffer.from(wire);
		const euro = bytes.indexOf(Buffer.from("€"));
		const cuts = [...new Set([1, 2, 5, euro + 1, euro + 2, bytes.length - 1])]
			.filter(cut => cut > 0 && cut < bytes.length)
			.sort((a, b) => a - b);
		let start = 0;
		for (const end of [...cuts, bytes.length]) {
			await this.write(bytes.subarray(start, end));
			await nextTurn();
			start = end;
		}
	}
}

class SocketFixture implements AsyncDisposable {
	readonly path: string;
	readonly #dir: TempDir;
	readonly #server: Server;
	readonly #accepted = Promise.withResolvers<Peer>();
	readonly #peers: Peer[] = [];
	#transport: TspTransport | undefined;

	constructor(dir: TempDir) {
		this.#dir = dir;
		this.path = path.join(dir.path(), "tsp.sock");
		this.#server = createServer(socket => {
			const peer = new Peer(socket);
			this.#peers.push(peer);
			this.#accepted.resolve(peer);
		});
	}

	static async create(): Promise<SocketFixture> {
		const fixture = new SocketFixture(await TempDir.create("@omp-tsp-transport-"));
		const listening = Promise.withResolvers<void>();
		fixture.#server.once("error", listening.reject);
		fixture.#server.listen(fixture.path, listening.resolve);
		try {
			await listening.promise;
			return fixture;
		} catch (error) {
			await fixture[Symbol.asyncDispose]();
			throw error;
		}
	}

	async connect(scheduler?: RenderScheduler): Promise<{ transport: TspTransport; peer: Peer }> {
		const transport = await connectTspTransport(this.path, scheduler);
		this.#transport = transport;
		const peer = await this.#accepted.promise;
		await peer.waitForOutput(encodeTspHelloQuery());
		return { transport, peer };
	}

	async [Symbol.asyncDispose](): Promise<void> {
		for (const peer of this.#peers) peer.socket.destroy();
		await this.#transport?.close();
		if (this.#server.listening) {
			const closed = Promise.withResolvers<void>();
			this.#server.close(error => {
				if (error) closed.reject(error);
				else closed.resolve();
			});
			await closed.promise;
		}
		await this.#dir.remove();
	}
}

describe.skipIf(process.platform === "win32")("dedicated TSP transport", () => {
	it("sends only the ordinary hello query and decodes fragmented UTF-8/APC bytes", async () => {
		await using fixture = await SocketFixture.create();
		const { transport, peer } = await fixture.connect();
		expect(peer.output).toBe(encodeTspHelloQuery());
		expect(transport.columns).toBe(80);
		expect(transport.appearance).toBeUndefined();
		await peer.fragment(encodeTspJson("r", HELLO));
		expect(await transport.hello).toEqual(HELLO);
		expect(transport.columns).toBe(98);
		expect(transport.appearance).toBe("light");
	});

	it("retains interleaved events and replies around a chunked hello until subscription", async () => {
		await using fixture = await SocketFixture.create();
		const { transport, peer } = await fixture.connect();
		const helloFrames = frames(encodeTspJson("r", HELLO, undefined, 23));
		const before = encodeTspJson("e", { ev: "resize", cols: 120 });
		const reply = encodeTspJson("r", { r: "blobs", have: ["known"] });
		const after = encodeTspJson("e", { ev: "theme", dark: true });
		await peer.write(`${helloFrames[0]}${before}${helloFrames.slice(1).join("")}${reply}${after}`);
		expect(await transport.hello).toEqual(HELLO);
		const received: string[] = [];
		transport.onInput(sequence => received.push(sequence));
		expect(received).toEqual([before, reply, after]);
	});

	it("does not expose hello chunks to an early subscriber", async () => {
		await using fixture = await SocketFixture.create();
		const { transport, peer } = await fixture.connect();
		const received: string[] = [];
		transport.onInput(sequence => received.push(sequence));
		const helloFrames = frames(encodeTspJson("r", HELLO, undefined, 23));
		const event = encodeTspJson("e", { ev: "resize", cols: 120 });
		await peer.write(`${helloFrames[0]}${event}${helloFrames.slice(1).join("")}`);
		await transport.hello;
		expect(received).toEqual([event]);
	});

	it("delivers original complete reply/event chunks and supports unsubscribe", async () => {
		await using fixture = await SocketFixture.create();
		const { transport, peer } = await fixture.connect();
		await peer.write(encodeTspJson("r", HELLO));
		await transport.hello;
		const event: TspEvent = { ev: "send", sf: "s:1", id: "input", text: "first\n€漢字🙂\nlast" };
		const eventWire = encodeTspJson("e", event, undefined, 11);
		const replyWire = encodeTspJson("r", { r: "blobs", have: ["cached"] });
		const expected = frames(`${eventWire}${replyWire}`);
		const received: string[] = [];
		const delivered = Promise.withResolvers<void>();
		const unsubscribe = transport.onInput(sequence => {
			received.push(sequence);
			if (received.length === expected.length) delivered.resolve();
		});
		await peer.fragment(`${eventWire}${replyWire}`);
		await delivered.promise;
		expect(received).toEqual(expected);
		const reader = new TspReader();
		const decoded = received.map(sequence => reader.feed(sequence)).filter(message => message !== null);
		expect(decoded).toEqual([
			{ verb: "e", event },
			{ verb: "r", reply: { r: "blobs", have: ["cached"] } },
		]);
		unsubscribe();
		const next = Promise.withResolvers<string>();
		transport.onInput(next.resolve);
		const last = encodeTspJson("e", { ev: "ack", s: 1 });
		await peer.write(last);
		expect(await next.promise).toBe(last);
		expect(received).toEqual(expected);
	});

	it("retains a fragmented APC across the keyboard framer's usual timeout", async () => {
		await using fixture = await SocketFixture.create();
		const { transport, peer } = await fixture.connect();
		await peer.write(encodeTspJson("r", HELLO));
		await transport.hello;
		const event = encodeTspJson("e", { ev: "ack", s: 7 });
		const received = Promise.withResolvers<string>();
		transport.onInput(received.resolve);
		await peer.write(event.slice(0, 3));
		// Exercise real socket-read timing beyond StdinBuffer's 75 ms keyboard deadline.
		// Advancing fake timers cannot ensure that the partial has reached the native socket.
		await Bun.sleep(100);
		await peer.write(event.slice(3, -1));
		await nextTurn();
		await peer.write(event.slice(-1));
		expect(await received.promise).toBe(event);
	});

	it("flushes queued TSP close bytes and releases the socket on idempotent close", async () => {
		await using fixture = await SocketFixture.create();
		const { transport, peer } = await fixture.connect();
		await peer.write(encodeTspJson("r", HELLO));
		await transport.hello;
		const queued = encodeTspJson("f", {
			sf: "s:1",
			s: 1,
			ops: [["text", "md", "append", "x".repeat(512 * 1024)]],
		});
		const close = encodeTspJson("x", { id: "s:1", keep: true });
		transport.write(queued);
		transport.write(close);
		await transport.close();
		await transport.closed;
		await peer.closed;
		expect(peer.output).toBe(`${encodeTspHelloQuery()}${queued}${close}`);
		expect(transport.pendingOutputBytes).toBe(0);
		await transport.close();
		transport.write(close);
		expect(peer.output).toBe(`${encodeTspHelloQuery()}${queued}${close}`);
	});

	it("drains acknowledgements in flight after its final frame without resetting the peer", async () => {
		await using fixture = await SocketFixture.create();
		const { transport, peer } = await fixture.connect();
		await peer.write(encodeTspJson("r", HELLO));
		await transport.hello;
		const errors: Error[] = [];
		peer.socket.on("error", error => errors.push(error));
		const frame = encodeTspJson("f", { sf: "s:1", s: 1, ops: [] });
		const close = encodeTspJson("x", { id: "s:1", keep: true });
		let acknowledged = false;
		peer.socket.on("data", () => {
			if (acknowledged || !peer.output.includes(frame)) return;
			acknowledged = true;
			peer.socket.write(encodeTspJson("e", { ev: "ack", sf: "s:1", s: 1 }));
		});
		transport.write(frame);
		transport.write(close);
		await transport.close();
		await peer.closed;
		expect(peer.output).toBe(`${encodeTspHelloQuery()}${frame}${close}`);
		expect(acknowledged).toBe(true);
		expect(errors).toEqual([]);
	});

	it("delivers a legitimate large blob split into ordinary APC chunks", async () => {
		await using fixture = await SocketFixture.create();
		const { transport, peer } = await fixture.connect();
		await peer.write(encodeTspJson("r", HELLO));
		await transport.hello;
		const bytes = Buffer.alloc(13 * 1024 * 1024, 0x93);
		const id = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		transport.write(
			encodeTspMessage("b", bytes.toString("base64"), { id, mime: "application/octet-stream" }, HELLO.apc),
		);
		transport.write(encodeTspJson("x", { id: "s:1", keep: true }));
		await transport.close();
		await peer.closed;

		const host = new TspTestTerminal({});
		for (const apc of frames(peer.output)) host.write(apc);
		const received = host.blobs.get(id);
		expect(received?.byteLength).toBe(bytes.byteLength);
		if (!received) throw new Error("The peer did not receive the referenced TSP blob");
		expect(new Bun.CryptoHasher("sha256").update(received).digest("hex")).toBe(id);
	});

	it("releases retained output and the socket when a peer half-closes", async () => {
		using dir = TempDir.createSync("@omp-tsp-half-close-");
		const accepted = Promise.withResolvers<Bun.Socket>();
		const peerClosed = Promise.withResolvers<void>();
		const server = Bun.listen({
			unix: path.join(dir.path(), "tsp.sock"),
			allowHalfOpen: true,
			socket: {
				open: socket => accepted.resolve(socket),
				data: () => {},
				end: socket => {
					socket.end();
				},
				close: () => peerClosed.resolve(),
			},
		});
		const transport = await connectTspTransport(server.unix);
		try {
			const peer = await accepted.promise;
			peer.write(encodeTspJson("r", HELLO));
			await transport.hello;
			const queued = encodeTspJson("f", {
				sf: "s:1",
				s: 1,
				ops: [["text", "md", "append", "x".repeat(8 * 1024 * 1024)]],
			});
			const close = encodeTspJson("x", { id: "s:1", keep: true });
			transport.write(queued);
			transport.write(close);
			expect(transport.pendingOutputBytes).toBeGreaterThan(0);
			// EOF is a disconnect: release queued storage even if the peer stops sending only.
			peer.shutdown(true);
			await peerClosed.promise;
			await transport.closed;
			expect(transport.pendingOutputBytes).toBe(0);
		} finally {
			server.stop(true);
			await transport.close();
		}
	});

	it("resolves closed on peer disconnect and accepts no postmortem writes", async () => {
		await using fixture = await SocketFixture.create();
		const { transport, peer } = await fixture.connect();
		await peer.write(encodeTspJson("r", HELLO));
		await transport.hello;
		peer.socket.end();
		await transport.closed;
		transport.write(encodeTspJson("x", { id: "s:1" }));
		await peer.closed;
		expect(peer.output).toBe(encodeTspHelloQuery());
		await transport.close();
	});

	it("releases backpressured output when closing a peer that has stopped reading", async () => {
		await using fixture = await SocketFixture.create();
		const { transport, peer } = await fixture.connect();
		await peer.write(encodeTspJson("r", HELLO));
		await transport.hello;
		peer.socket.pause();
		const frame = encodeTspJson("f", {
			sf: "s:1",
			s: 1,
			ops: [["text", "md", "append", "x".repeat(1024 * 1024)]],
		});
		transport.write(frame);
		expect(transport.pendingOutputBytes).toBeGreaterThan(0);
		await transport.close();
		await transport.closed;
		expect(transport.pendingOutputBytes).toBe(0);
	});

	it("tears down a non-reading peer automatically instead of retaining an unbounded outbound queue", async () => {
		await using fixture = await SocketFixture.create();
		const { transport, peer } = await fixture.connect();
		await peer.write(encodeTspJson("r", HELLO));
		await transport.hello;
		peer.socket.pause();
		const frame = encodeTspJson("f", {
			sf: "s:1",
			s: 1,
			ops: [["text", "md", "append", "é".repeat(512 * 1024)]],
		});
		for (let index = 0; index < 66; index++) transport.write(frame);
		await transport.closed;
		expect(transport.pendingOutputBytes).toBe(0);
		transport.write(frame);
		expect(transport.pendingOutputBytes).toBe(0);
		peer.socket.resume();
		await peer.closed;
	});

	it("disconnects a wedged peer below the byte ceiling after no drain progress, without requiring a close", async () => {
		await using fixture = await SocketFixture.create();
		const scheduler = new ManualScheduler();
		const { transport, peer } = await fixture.connect(scheduler);
		await peer.write(encodeTspJson("r", HELLO));
		await transport.hello;
		peer.socket.pause();
		transport.write(
			encodeTspJson("f", {
				sf: "s:1",
				s: 1,
				ops: [["text", "md", "append", "x".repeat(1024 * 1024)]],
			}),
		);
		scheduler.flush(60_250);
		await transport.closed;
		expect(transport.pendingOutputBytes).toBe(0);
		peer.socket.resume();
		await peer.closed;
	});

	it("rejects the pending hello when the peer disconnects", async () => {
		await using fixture = await SocketFixture.create();
		const { transport, peer } = await fixture.connect();
		peer.socket.end();
		await expect(transport.hello).rejects.toThrow("peer disconnected before a valid hello reply");
		await transport.closed;
	});

	it("rejects the pending hello when the transport is closed locally", async () => {
		await using fixture = await SocketFixture.create();
		const { transport } = await fixture.connect();
		const closed = transport.close();
		await expect(transport.hello).rejects.toThrow("transport closed before a valid hello reply");
		await closed;
	});

	it("rejects an unsupported hello version without pretending the peer supports TSP", async () => {
		await using fixture = await SocketFixture.create();
		const { transport, peer } = await fixture.connect();
		await peer.write(encodeTspJson("r", { ...HELLO, v: TSP_VERSION + 1 }));
		await expect(transport.hello).rejects.toThrow(`unsupported TSP version ${TSP_VERSION + 1}`);
		await transport.closed;
	});

	it.each([
		["silent peer", ""],
		["invalid hello", encodeTspJson("r", { r: "hello", v: TSP_VERSION, term: "tern" })],
	])("bounds the hello wait for a %s", async (_label, response) => {
		await using fixture = await SocketFixture.create();
		vi.useFakeTimers();
		try {
			const { transport, peer } = await fixture.connect();
			if (response) await peer.write(response);
			vi.advanceTimersByTime(1000);
			await expect(transport.hello).rejects.toThrow(`no valid TSP v${TSP_VERSION} hello reply within 1000 ms`);
			await transport.closed;
		} finally {
			vi.useRealTimers();
		}
	});

	it("bounds input retained before the presenter subscribes", async () => {
		await using fixture = await SocketFixture.create();
		const { transport, peer } = await fixture.connect();
		await peer.write(encodeTspJson("r", HELLO));
		await transport.hello;
		const event = encodeTspJson("e", { ev: "ack", s: 1 });
		await peer.write(event.repeat(1025));
		await transport.closed;
		await transport.close();
	});

	it("reports useful Unix socket connection diagnostics", async () => {
		using dir = TempDir.createSync("@omp-tsp-unavailable-");
		const missing = path.join(dir.path(), "missing.sock");
		await expect(connectTspTransport(missing)).rejects.toThrow(`TSP socket ${JSON.stringify(missing)}`);
		const notSocket = path.join(dir.path(), "ordinary-file");
		await Bun.write(notSocket, "not a socket");
		await expect(connectTspTransport(notSocket)).rejects.toThrow(`TSP socket ${JSON.stringify(notSocket)}`);
		await expect(connectTspTransport("")).rejects.toThrow("nonempty Unix socket path");
		await expect(connectTspTransport("bad\0path")).rejects.toThrow("without NUL bytes");
	});

	it("rejects reserved, invalid, and nonstream descriptors without taking them over", async () => {
		for (const fd of [-1, 0, 1, 2, 3.5, Number.NaN]) {
			await expect(connectTspTransport(fd)).rejects.toThrow("descriptor greater than 2");
		}
		await expect(connectTspTransport(2147483647)).rejects.toThrow("cannot adopt inherited duplex stream");
		using dir = TempDir.createSync("@omp-tsp-fd-");
		const file = await fs.open(path.join(dir.path(), "ordinary-file"), "w");
		try {
			await expect(connectTspTransport(file.fd)).rejects.toThrow("descriptor is not a duplex stream");
			await file.write("still owned by the caller");
		} finally {
			await file.close();
		}
	});
});
