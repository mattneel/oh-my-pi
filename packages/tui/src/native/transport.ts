import * as fs from "node:fs";
import { DuplexFd } from "@oh-my-pi/pi-natives";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { TSP_VERSION } from "@oh-my-pi/pi-wire";
import { STDOUT_BACKLOG_CLEAR_BYTES, StdoutStallWatchdog, type TerminalAppearance } from "../terminal";
import { DEFAULT_RENDER_SCHEDULER, type RenderScheduler, type RenderTimer } from "../tui";
import { encodeTspHelloQuery, splitTspMessage, TSP_PREFIX, type TspHello, TspReader } from "./encode";

/** A dedicated ordinary TSP channel, independent of the process's terminal and stdio. */
export interface TspTransport {
	/** Rejects if the peer disconnects or does not answer with a supported hello. */
	readonly hello: Promise<TspHello>;
	/** Resolves once the stream and its owned descriptor have been released. */
	readonly closed: Promise<void>;
	/** Hello-reported width, or 80 before the handshake. Resize events belong to the backend. */
	readonly columns: number;
	/** Hello-reported appearance; theme events belong to the backend. */
	readonly appearance: TerminalAppearance | undefined;
	readonly pendingOutputBytes?: number;
	write(data: string): void;
	/** Complete APCs, with their original TSP chunk boundaries, in wire order. */
	onInput(callback: (completeApc: string) => void): () => void;
	/** Drain accepted writes, then release the stream. Safe to call more than once. */
	close(): Promise<void>;
}

// Match the interactive TUI's real-hello confirmation window, without its optimistic rendering.
const HELLO_TIMEOUT_MS = 1000;
const CLOSE_TIMEOUT_MS = 1000;
// An optional presentation must not retain an unbounded queue, even while ACK credits expire.
const MAX_OUTPUT_BACKLOG_BYTES = 64 * 1024 * 1024;
const OUTPUT_STALL_POLL_MS = 250;
const MAX_STARTUP_INPUT_BYTES = 1024 * 1024;
const MAX_STARTUP_INPUT_FRAMES = 1024;
// Match the existing terminal input framer's generous string-sequence bound.
const MAX_APC_LENGTH = 16 * 1024 * 1024;
const APC = "\x1b_";
const ST = "\x1b\\";

function targetError(target: string, detail: string, cause?: unknown): Error {
	return new Error(`TSP ${target}: ${detail}`, cause === undefined ? undefined : { cause });
}

class DuplexTspTransport implements TspTransport {
	#socket: Bun.Socket | undefined;
	#fd: DuplexFd | undefined;
	#fdWrite: Promise<void> | undefined;
	#fdClosing: Promise<void> | undefined;
	readonly #target: string;
	readonly #hello = Promise.withResolvers<TspHello>();
	readonly #closed = Promise.withResolvers<void>();
	readonly #subscribers = new Set<(completeApc: string) => void>();
	#reader: TspReader | undefined = new TspReader();
	#helloTimer: NodeJS.Timeout | undefined;
	#closeTimer: NodeJS.Timeout | undefined;
	#initialized = false;
	#helloSettled = false;
	#closing = false;
	#columns = 80;
	#appearance: TerminalAppearance | undefined;
	#input = "";
	#searchFrom = 0;
	#startupInput: string[] = [];
	#startupBytes = 0;
	readonly #decoder = new TextDecoder();
	#failure: Error | undefined;
	#output: Buffer[] = [];
	#outputOffset = 0;
	#outputBytes = 0;
	readonly #outputStall = new StdoutStallWatchdog(STDOUT_BACKLOG_CLEAR_BYTES);
	#outputStallTimer: RenderTimer | undefined;

	constructor(
		target: string,
		private readonly scheduler: RenderScheduler = DEFAULT_RENDER_SCHEDULER,
	) {
		this.#target = target;
		// Preserve a startup rejection even if the caller has not begun awaiting hello.
		void this.#hello.promise.catch(() => {});
	}

	get hello(): Promise<TspHello> {
		return this.#hello.promise;
	}

	get closed(): Promise<void> {
		return this.#closed.promise;
	}

	get columns(): number {
		return this.#columns;
	}

	get appearance(): TerminalAppearance | undefined {
		return this.#appearance;
	}

	get pendingOutputBytes(): number {
		const remaining = this.#fd?.pendingWriteBytes ?? undefined;
		return remaining === undefined
			? this.#outputBytes
			: this.#outputBytes - (this.#output[0]?.byteLength ?? 0) + remaining;
	}

	async open(target: number | string): Promise<void> {
		// Native readiness/cancellation also handles raw PTYs; ordinary file
		// streams can block their reads or teardown on an inherited descriptor.
		try {
			if (typeof target === "number") {
				this.#fd = DuplexFd.open(target);
				fs.closeSync(target);
				void this.#readFd(this.#fd);
				this.#queryHello();
				return;
			}
			await Bun.connect({
				unix: target,
				allowHalfOpen: true,
				socket: {
					open: socket => {
						this.#socket = socket;
						this.#queryHello();
					},
					data: (_socket, data) => this.#receive(this.#decoder.decode(data, { stream: true })),
					drain: () => this.#flushOutput(),
					error: (_socket, error) => this.#fail(targetError(this.#target, error.message, error)),
					close: () => this.#release(),
					end: () => {
						this.#rejectHello(targetError(this.#target, "peer disconnected before a valid hello reply"));
						void this.close();
					},
				},
			});
			if (this.#closing) throw this.#failure ?? targetError(this.#target, "peer disconnected while opening");
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			this.#fail(targetError(this.#target, `could not open duplex stream: ${failure.message}`, failure));
			if (!this.#socket && !this.#fd) this.#release();
			throw this.#failure ?? failure;
		}
	}

	async #readFd(fd: DuplexFd): Promise<void> {
		try {
			while (!this.#closing) {
				const bytes = await fd.read();
				if (bytes === null) {
					this.#rejectHello(targetError(this.#target, "peer disconnected before a valid hello reply"));
					void this.close();
					return;
				}
				if (!this.#closing) this.#receive(this.#decoder.decode(bytes, { stream: true }));
			}
		} catch (error) {
			if (!this.#closing) this.#fail(targetError(this.#target, `read failed: ${String(error)}`, error));
		}
	}

	#queryHello(): void {
		if (this.#closing) return;
		this.#helloTimer = setTimeout(() => {
			this.#fail(
				targetError(this.#target, `no valid TSP v${TSP_VERSION} hello reply within ${HELLO_TIMEOUT_MS} ms`),
			);
		}, HELLO_TIMEOUT_MS);
		this.#helloTimer.unref();
		this.write(encodeTspHelloQuery());
		if (!this.#closing) this.#initialized = true;
	}

	write(data: string): void {
		if (this.#closing || (!this.#socket && !this.#fd) || data.length === 0) return;
		const bytes = Buffer.byteLength(data);
		if (this.#outputBytes + this.#outputOffset + bytes > MAX_OUTPUT_BACKLOG_BYTES) {
			this.#fail(targetError(this.#target, `outbound backlog exceeds ${MAX_OUTPUT_BACKLOG_BYTES} bytes`));
			return;
		}
		try {
			if (this.#fd) {
				this.#output.push(Buffer.from(data));
				this.#outputBytes += bytes;
				this.#flushOutput();
				this.#trackOutputBacklog();
				return;
			}
			if (this.#output.length === 0) {
				const written = this.#socket!.write(data);
				if (written < 0) throw new Error("socket is closed");
				if (written === bytes) return;
				this.#outputOffset = written;
				this.#outputBytes += bytes - written;
			} else {
				this.#outputBytes += bytes;
			}
			// Allocate UTF-8 storage only when backpressure requires retaining bytes.
			this.#output.push(Buffer.from(data));
			this.#trackOutputBacklog();
		} catch (error) {
			this.#fail(targetError(this.#target, `write failed: ${String(error)}`, error));
		}
	}

	#flushOutput(): void {
		if (this.#fd) {
			if (!this.#fdWrite) {
				this.#fdWrite = this.#writeFd(this.#fd);
				void this.#fdWrite
					.catch(error => {
						if (this.#fdClosing) return;
						const failure = targetError(this.#target, `write failed: ${String(error)}`, error);
						if (this.#closing) {
							logger.warn("TSP transport: unable to drain output", {
								target: this.#target,
								error: failure.message,
							});
							void this.#closeFd();
						} else this.#fail(failure);
					})
					.finally(() => {
						this.#fdWrite = undefined;
						if (this.#fdClosing) return;
						if (this.#output.length > 0) this.#flushOutput();
						else if (this.#closing) void this.#closeFd();
					});
			}
			return;
		}
		const socket = this.#socket;
		if (!socket) return;
		try {
			while (this.#output.length > 0) {
				const bytes = this.#output[0]!;
				const written = socket.write(bytes, this.#outputOffset, bytes.byteLength - this.#outputOffset);
				if (written < 0) throw new Error("socket is closed");
				this.#outputBytes -= written;
				this.#outputOffset += written;
				if (this.#outputOffset < bytes.byteLength) return;
				this.#trackOutputBacklog();
				this.#output.shift();
				this.#outputOffset = 0;
			}
			if (this.#closing) socket.end();
		} catch (error) {
			const failure = targetError(this.#target, `write failed: ${String(error)}`, error);
			if (this.#closing) {
				logger.warn("TSP transport: unable to drain output", { target: this.#target, error: failure.message });
				socket.terminate();
			} else this.#fail(failure);
		}
	}

	async #writeFd(fd: DuplexFd): Promise<void> {
		while (this.#output.length > 0) {
			const bytes = this.#output[0]!;
			await fd.write(bytes);
			if (this.#fdClosing) return;
			this.#outputBytes -= bytes.byteLength;
			this.#output.shift();
		}
		this.#trackOutputBacklog();
	}

	#closeFd(): Promise<void> {
		if (this.#fdClosing) return this.#fdClosing;
		const fd = this.#fd;
		if (!fd) return this.#closed.promise;
		this.#fdClosing = fd
			.close()
			.catch(error => {
				logger.warn("TSP transport: descriptor close failed", { target: this.#target, error: String(error) });
			})
			.finally(() => {
				this.#fd = undefined;
				this.#release();
			});
		return this.#fdClosing;
	}

	#trackOutputBacklog(): void {
		if (this.#closing) return;
		if (this.#outputStall.sample(this.pendingOutputBytes, this.scheduler.now())) {
			this.#fail(targetError(this.#target, "outbound backlog stalled without draining"));
			return;
		}
		if (!this.#outputStall.armed) {
			this.#clearOutputStall();
		} else if (!this.#outputStallTimer) {
			this.#outputStallTimer = this.scheduler.scheduleRender(() => {
				this.#outputStallTimer = undefined;
				this.#trackOutputBacklog();
			}, OUTPUT_STALL_POLL_MS);
		}
	}

	#clearOutputStall(): void {
		this.#outputStallTimer?.cancel();
		this.#outputStallTimer = undefined;
		this.#outputStall.reset();
	}

	#release(): void {
		this.#closing = true;
		this.#clearHelloTimer();
		this.#clearOutputStall();
		clearTimeout(this.#closeTimer);
		this.#rejectHello(this.#failure ?? targetError(this.#target, "peer disconnected before a valid hello reply"));
		this.#reader = undefined;
		this.#input = "";
		this.#startupInput = [];
		this.#startupBytes = 0;
		this.#output = [];
		this.#outputBytes = 0;
		this.#subscribers.clear();
		this.#closed.resolve();
	}

	onInput(callback: (completeApc: string) => void): () => void {
		if (this.#closing) return () => {};
		this.#subscribers.add(callback);
		this.#flushStartupInput();
		return () => this.#subscribers.delete(callback);
	}

	#flushStartupInput(): void {
		if (!this.#helloSettled || this.#subscribers.size === 0) return;
		const pending = this.#startupInput;
		this.#startupInput = [];
		this.#startupBytes = 0;
		for (const sequence of pending) {
			if (this.#closing) break;
			for (const callback of this.#subscribers) this.#deliver(callback, sequence);
		}
	}

	#deliver(callback: (completeApc: string) => void, sequence: string): void {
		if (this.#closing) return;
		try {
			callback(sequence);
		} catch (error) {
			logger.warn("TSP transport: input subscriber failed", { target: this.#target, error: String(error) });
		}
	}

	#receive(data: string): void {
		if (this.#closing) return;
		this.#input += data;
		// StdinBuffer intentionally flushes ambiguous keyboard prefixes on a timer. A socket
		// has no keyboard ambiguity: retain partial APCs until ST, independent of read timing.
		for (;;) {
			if (!this.#input.startsWith(APC)) {
				const start = this.#input.indexOf(APC);
				if (start === -1) {
					this.#input = this.#input.endsWith("\x1b") ? "\x1b" : "";
					this.#searchFrom = 0;
					return;
				}
				this.#input = this.#input.slice(start);
				this.#searchFrom = 0;
			}
			const end = this.#input.indexOf(ST, Math.max(APC.length, this.#searchFrom - 1));
			if (end === -1) {
				if (this.#input.length > MAX_APC_LENGTH) {
					this.#fail(targetError(this.#target, "APC frame exceeds the input limit"));
					return;
				}
				this.#searchFrom = this.#input.length;
				return;
			}
			if (end > MAX_APC_LENGTH) {
				this.#fail(targetError(this.#target, "APC frame exceeds the input limit"));
				return;
			}
			const sequence = this.#input.slice(0, end + ST.length);
			this.#input = this.#input.slice(end + ST.length);
			this.#searchFrom = 0;
			if (sequence.startsWith(TSP_PREFIX)) this.#handleApc(sequence);
			if (this.#closing || this.#input.length === 0) return;
		}
	}

	#handleApc(sequence: string): void {
		const message = this.#reader?.feed(sequence);
		if (message?.verb === "r" && message.reply.r === "hello") {
			const hello = message.reply;
			if (hello.v !== TSP_VERSION) {
				this.#fail(targetError(this.#target, `unsupported TSP version ${hello.v}; expected ${TSP_VERSION}`));
				return;
			}
			// The reader owns hello chunk assembly. Remove only those original chunks from the
			// startup inbox, preserving any interleaved events and replies for the backend.
			const chunk = splitTspMessage(sequence)?.params.c;
			if (chunk !== undefined) {
				this.#startupInput = this.#startupInput.filter(input => splitTspMessage(input)?.params.c !== chunk);
				this.#startupBytes = this.#startupInput.reduce((sum, input) => sum + Buffer.byteLength(input), 0);
			}
			if (typeof hello.cols === "number" && Number.isFinite(hello.cols) && hello.cols >= 1) {
				this.#columns = Math.trunc(hello.cols);
			}
			this.#appearance = typeof hello.dark === "boolean" ? (hello.dark ? "dark" : "light") : undefined;
			this.#helloSettled = true;
			this.#clearHelloTimer();
			this.#reader = undefined;
			this.#hello.resolve(hello);
			this.#flushStartupInput();
			return;
		}
		if (this.#helloSettled && this.#subscribers.size > 0) {
			for (const callback of this.#subscribers) this.#deliver(callback, sequence);
			return;
		}
		const bytes = Buffer.byteLength(sequence);
		if (
			this.#startupInput.length >= MAX_STARTUP_INPUT_FRAMES ||
			this.#startupBytes + bytes > MAX_STARTUP_INPUT_BYTES
		) {
			this.#fail(targetError(this.#target, "input before subscription exceeds the startup buffer limit"));
			return;
		}
		this.#startupInput.push(sequence);
		this.#startupBytes += bytes;
	}

	#clearHelloTimer(): void {
		clearTimeout(this.#helloTimer);
		this.#helloTimer = undefined;
	}

	#rejectHello(error: Error): void {
		if (this.#helloSettled) return;
		this.#helloSettled = true;
		this.#hello.reject(error);
	}

	#fail(error: Error): void {
		if (this.#closing) return;
		if (this.#initialized) logger.warn("TSP transport disconnected", { target: this.#target, error: error.message });
		this.#closing = true;
		this.#clearHelloTimer();
		this.#clearOutputStall();
		this.#failure = error;
		this.#rejectHello(error);
		this.#socket?.terminate();
		if (this.#fd) void this.#closeFd();
	}

	close(): Promise<void> {
		if (this.#closing) return this.#closed.promise;
		this.#closing = true;
		this.#clearHelloTimer();
		this.#clearOutputStall();
		this.#rejectHello(targetError(this.#target, "transport closed before a valid hello reply"));
		if (!this.#socket && !this.#fd) {
			this.#release();
			return this.#closed.promise;
		}
		this.#closeTimer = setTimeout(() => {
			logger.warn("TSP transport: timed out draining output", { target: this.#target });
			this.#socket?.terminate();
			if (this.#fd) void this.#closeFd();
		}, CLOSE_TIMEOUT_MS);
		this.#closeTimer.unref();
		this.#flushOutput();
		return this.#closed.promise;
	}
}

/** Adopt an inherited duplex descriptor, or connect to an already-listening Unix socket. */
export async function connectTspTransport(
	target: number | string,
	scheduler: RenderScheduler = DEFAULT_RENDER_SCHEDULER,
): Promise<TspTransport> {
	const description = typeof target === "number" ? `fd ${target}` : `socket ${JSON.stringify(target)}`;
	if (typeof target === "number") {
		if (!Number.isSafeInteger(target) || target <= 2) {
			throw targetError(description, "expected an inherited descriptor greater than 2 (stdio is reserved)");
		}
		try {
			const stat = fs.fstatSync(target);
			if (!stat.isSocket() && !stat.isCharacterDevice() && !stat.isFIFO()) {
				throw new Error("descriptor is not a duplex stream");
			}
		} catch (error) {
			throw targetError(description, `cannot adopt inherited duplex stream: ${String(error)}`, error);
		}
	} else if (target.length === 0 || target.includes("\0")) {
		throw targetError(description, "expected a nonempty Unix socket path without NUL bytes");
	}
	const transport = new DuplexTspTransport(description, scheduler);
	try {
		await transport.open(target);
		return transport;
	} catch (error) {
		await transport.close();
		throw error;
	}
}
