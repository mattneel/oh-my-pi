import { afterEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn, type StdioOptions } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { Duplex, Writable } from "node:stream";
import { encodeTspJson, TSP_PREFIX } from "@oh-my-pi/pi-tui/native/encode";
import { TSP_KINDS, type TspEvent, type TspNode } from "@oh-my-pi/pi-wire";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { TspTestTerminal } from "../../tui/test/native/tsp-harness";
import { ONE_PIXEL_PNG } from "./helpers/skill-image-vision";

const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");
const seedEntry = path.resolve(import.meta.dir, "fixtures/acp-tsp-session.ts");
const flagExtension = path.resolve(import.meta.dir, "fixtures/acp-tsp-flags.ts");
const timeoutMs = 30_000;
const cliIsolation = [
	"--no-extensions",
	"--no-skills",
	"--no-rules",
	"--no-tools",
	"--no-lsp",
	"--no-title",
	"--no-prewalk",
];
const roots: string[] = [];
const processes = new Set<CliProcess>();
const peers = new Set<Duplex>();
const servers = new Set<Server>();

/** Event-driven predicate waits: only IO changes wake a waiter; the timer is a deadline. */
class Changes {
	#listeners = new Set<() => void>();
	#error: Error | undefined;

	changed(): void {
		for (const listener of this.#listeners) listener();
	}

	fail(error: Error): void {
		this.#error ??= error;
		this.changed();
	}

	wait<T>(description: string, read: () => T | undefined): Promise<T> {
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const finish = (): void => {
			clearTimeout(timer);
			this.#listeners.delete(check);
		};
		const check = (): void => {
			try {
				if (this.#error) throw this.#error;
				const result = read();
				if (result === undefined) return;
				finish();
				resolve(result);
			} catch (error) {
				finish();
				reject(error);
			}
		};
		const timer = setTimeout(() => {
			finish();
			reject(new Error(`Timed out waiting for ${description}`));
		}, timeoutMs);
		this.#listeners.add(check);
		check();
		return promise;
	}
}

interface RpcMessage {
	jsonrpc: string;
	id?: unknown;
	result?: Record<string, unknown>;
	error?: unknown;
	method?: string;
	params?: Record<string, unknown>;
}

class CliProcess {
	readonly child: ChildProcess;
	readonly changes = new Changes();
	readonly messages: RpcMessage[] = [];
	stdout = "";
	stderr = "";
	#pending = "";
	#nextId = 1;
	readonly #exitChanges = new Changes();
	#exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

	constructor(
		args: string[],
		cwd: string,
		env: NodeJS.ProcessEnv,
		inherited?: { fd: number; socket: Socket },
		rpc = true,
		isolation = cliIsolation,
	) {
		const stdio: StdioOptions = ["pipe", "pipe", "pipe"];
		if (inherited) {
			for (let i = 3; i <= inherited.fd; i++) stdio.push(i === inherited.fd ? inherited.socket : "ignore");
		}
		this.child = spawn(process.execPath, [cliEntry, ...args, ...isolation], { cwd, env, stdio });
		processes.add(this);
		this.child.on("error", error => this.changes.fail(error));
		this.child.stdout?.setEncoding("utf8");
		this.child.stdout?.on("data", (data: string) => {
			this.stdout += data;
			if (rpc) {
				this.#pending += data;
				try {
					for (;;) {
						const end = this.#pending.indexOf("\n");
						if (end < 0) break;
						const line = this.#pending.slice(0, end);
						this.#pending = this.#pending.slice(end + 1);
						const message: unknown = JSON.parse(line);
						if (!isRecord(message) || message.jsonrpc !== "2.0") throw new Error(`Non-RPC stdout: ${line}`);
						this.messages.push({
							jsonrpc: message.jsonrpc,
							id: message.id,
							result: isRecord(message.result) ? message.result : undefined,
							error: message.error,
							method: typeof message.method === "string" ? message.method : undefined,
							params: isRecord(message.params) ? message.params : undefined,
						});
					}
				} catch (error) {
					this.changes.fail(error instanceof Error ? error : new Error(String(error)));
				}
			}
			this.changes.changed();
		});
		this.child.stderr?.setEncoding("utf8");
		this.child.stderr?.on("data", (data: string) => {
			this.stderr += data;
			this.changes.changed();
		});
		this.child.once("close", (code, signal) => {
			this.#exit = { code, signal };
			this.#exitChanges.changed();
			this.changes.changed();
		});
	}

	get stdin(): Writable {
		if (!this.child.stdin) throw new Error("CLI stdin is not piped");
		return this.child.stdin;
	}

	async request(method: string, params: Record<string, unknown>): Promise<RpcMessage> {
		const id = this.#nextId++;
		this.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		const response = await this.changes.wait(`${method} response; stderr=${this.stderr}`, () => {
			const message = this.messages.find(message => message.id === id && message.method === undefined);
			if (message) return message;
			if (this.#exit) throw new Error(`CLI exited before ${method}: ${this.stderr}`);
			return undefined;
		});
		expect(response.error, this.stderr).toBeUndefined();
		expect(response.result).toBeDefined();
		return response;
	}

	async exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
		return this.#exitChanges.wait(`CLI exit; stderr=${this.stderr}`, () => this.#exit);
	}

	assertRpcOnly(): void {
		expect(this.#pending).toBe("");
		expect(this.messages.length).toBeGreaterThan(0);
		expect(this.stdout).not.toContain("\x1b");
		for (const line of this.stdout.trimEnd().split("\n")) {
			expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
		}
	}
}

/** Reuse the terminal-side document applier, adding stream framing and real IO. */
class SideChannel extends TspTestTerminal {
	readonly changes = new Changes();
	readonly peer: Duplex;
	helloQueries = 0;
	closed = false;
	#pending = "";

	constructor(peer: Duplex, features: readonly string[] = ["blobs", "settle", "adopt", "dock"]) {
		super({ autoAck: false });
		this.peer = peer;
		peers.add(peer);
		peer.setEncoding("utf8");
		peer.on("error", error => this.changes.fail(error));
		peer.on("data", (data: string) => {
			this.#pending += data;
			try {
				for (;;) {
					const end = this.#pending.indexOf("\x1b\\");
					if (end < 0) break;
					const sequence = this.#pending.slice(0, end + 2);
					this.#pending = this.#pending.slice(end + 2);
					if (!sequence.startsWith(TSP_PREFIX)) throw new Error(`Non-TSP side-channel bytes: ${sequence}`);
					const before = this.log.length;
					super.write(sequence);
					if (this.log.length === before) continue;
					const last = this.log.at(-1);
					if (last?.verb === "q" && isRecord(last.body) && last.body.q === "hello") {
						this.helloQueries++;
						this.send(
							encodeTspJson("r", {
								r: "hello",
								v: 1,
								term: "ordinary-acp-test-host",
								kinds: TSP_KINDS,
								features,
								cols: 100,
								dark: true,
								credits: 1,
							}),
						);
					}
					if (last?.verb === "f") this.ackAll();
				}
				this.changes.changed();
			} catch (error) {
				this.changes.fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
		peer.once("close", () => {
			this.closed = true;
			this.changes.changed();
		});
	}

	override send(data: string): void {
		this.peer.write(data);
	}

	event(event: TspEvent): void {
		this.send(encodeTspJson("e", event));
	}

	find(predicate: (node: TspNode) => boolean, surface = this.surface): TspNode | undefined {
		if (!surface) return undefined;
		const root = this.docs.get(surface)?.snapshot();
		const visit = (node: TspNode): TspNode | undefined => {
			if (predicate(node)) return node;
			for (const child of node.c ?? []) {
				const found = visit(child);
				if (found) return found;
			}
			return undefined;
		};
		return root ? visit(root) : undefined;
	}

	async waitForNode(predicate: (node: TspNode) => boolean, surface?: string): Promise<TspNode> {
		return this.changes.wait("semantic transcript node", () => this.find(predicate, surface));
	}

	assertValid(): void {
		expect(this.helloQueries).toBe(1);
		expect(this.frames.length).toBeGreaterThan(0);
		expect(this.errors).toEqual([]);
		expect(this.rowBytes).toBe("");
		expect(this.#pending).toBe("");
	}
}

async function isolatedEnvironment(): Promise<{ cwd: string; env: NodeJS.ProcessEnv }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-tsp-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	const xdg = path.join(root, "xdg");
	await Promise.all([cwd, agentDir, xdg].map(dir => fs.mkdir(dir, { recursive: true })));
	// A static fixture model prevents implicit localhost catalog discovery. Its
	// non-network base URL also makes SDK preconnect unable to open an HTTP socket.
	await fs.writeFile(
		path.join(agentDir, "config.yml"),
		JSON.stringify({
			plan: { enabled: false },
			modelRoles: { default: "acp-fixture/transcript" },
			disabledProviders: ["ollama", "llama.cpp", "lm-studio", "apple"],
		}),
	);
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		JSON.stringify({
			providers: {
				"acp-fixture": {
					baseUrl: "local://acp-transcript-fixture",
					api: "anthropic-messages",
					auth: "none",
					models: [
						{
							id: "transcript",
							name: "Persisted transcript fixture",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 8192,
							maxTokens: 1024,
						},
					],
				},
			},
		}),
	);
	// Preserve HOME for Bun's transpile cache, but isolate all agent settings/state.
	// Deliberately advertise no Tern terminal: only this ordinary socket host supplies hello.
	const env: NodeJS.ProcessEnv = {
		...process.env,
		XDG_DATA_HOME: xdg,
		XDG_CONFIG_HOME: xdg,
		PI_CODING_AGENT_DIR: agentDir,
		PI_NO_TITLE: "1",
		NO_COLOR: "1",
		TERM: "dumb",
		TERM_PROGRAM: "not-tern",
	};
	for (const key of Object.keys(env)) {
		if (key.startsWith("TERN_") || key.endsWith("_API_KEY") || key.endsWith("_AUTH_TOKEN")) delete env[key];
	}
	return { cwd, env };
}

async function seedSession(cwd: string, env: NodeJS.ProcessEnv, imageCount = 1): Promise<string> {
	const proc = Bun.spawn([process.execPath, seedEntry, String(imageCount)], {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const changes = new Changes();
	let exit: number | undefined;
	void proc.exited.then(code => {
		exit = code;
		changes.changed();
	});
	const stdout = new Response(proc.stdout).text();
	const stderr = new Response(proc.stderr).text();
	try {
		const code = await changes.wait("session fixture exit", () => exit);
		expect(code, await stderr).toBe(0);
		const seeded: unknown = JSON.parse(await stdout);
		if (!isRecord(seeded) || typeof seeded.sessionId !== "string") throw new Error("Invalid seeded session id");
		return seeded.sessionId;
	} finally {
		proc.kill();
		await proc.exited;
	}
}

async function initializeAndLoad(proc: CliProcess, cwd: string, sessionId: string): Promise<void> {
	const initialized = await proc.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
	expect(initialized.result?.protocolVersion).toBe(1);
	await proc.request("session/load", { cwd, sessionId, mcpServers: [] });
}

async function gracefulShutdown(proc: CliProcess, host: SideChannel): Promise<void> {
	proc.stdin.end();
	const [exit] = await Promise.all([
		proc.exited(),
		host.changes.wait("side channel released after ACP EOF", () => (host.closed ? true : undefined)),
	]);
	expect(exit, proc.stderr).toEqual({ code: 0, signal: null });
	expect(host.log.some(message => message.verb === "x")).toBe(true);
	proc.assertRpcOnly();
	host.assertValid();
}

async function listen(socketPath: string): Promise<{ server: Server; connection: Promise<Socket> }> {
	const changes = new Changes();
	let peer: Socket | undefined;
	let ready = false;
	const server = createServer(socket => {
		peer = socket;
		changes.changed();
	});
	servers.add(server);
	server.on("error", error => changes.fail(error));
	server.listen(socketPath, () => {
		ready = true;
		changes.changed();
	});
	await changes.wait("Unix socket listener", () => (ready ? true : undefined));
	return { server, connection: changes.wait("TSP socket connection", () => peer) };
}

async function connectInheritedSocket(socketPath: string): Promise<Socket> {
	const changes = new Changes();
	let connected = false;
	const socket = createConnection(socketPath);
	peers.add(socket);
	socket.on("error", error => changes.fail(error));
	socket.once("connect", () => {
		connected = true;
		changes.changed();
	});
	await changes.wait("inherited Unix socket connection", () => (connected ? true : undefined));
	return socket;
}

afterEach(async () => {
	for (const proc of processes) {
		proc.child.stdin?.destroy();
		proc.child.kill("SIGKILL");
	}
	await Promise.allSettled([...processes].map(proc => proc.exited()));
	processes.clear();
	for (const peer of peers) peer.destroy();
	peers.clear();
	await Promise.all(
		[...servers].map(server => {
			const { promise, resolve } = Promise.withResolvers<void>();
			server.close(() => resolve());
			return promise;
		}),
	);
	servers.clear();
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("ACP TSP side channel", () => {
	it("negotiates the cockpit over a real CLI side channel while ACP exclusively settles confirm cards", async () => {
		const { cwd, env } = await isolatedEnvironment();
		let calls = 0;
		const provider = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				const tool = calls++ === 0;
				const events = [
					{
						type: "message_start",
						message: {
							id: `msg-${calls}`,
							type: "message",
							role: "assistant",
							model: "transcript",
							content: [],
							stop_reason: null,
							stop_sequence: null,
							usage: { input_tokens: 8, output_tokens: 0 },
						},
					},
					{
						type: "content_block_start",
						index: 0,
						content_block: tool
							? { type: "tool_use", id: "cli-confirm-tool", name: "bash", input: {} }
							: { type: "text", text: "" },
					},
					tool
						? {
								type: "content_block_delta",
								index: 0,
								delta: {
									type: "input_json_delta",
									partial_json: JSON.stringify({ command: "printf cockpit-permission" }),
								},
							}
						: {
								type: "content_block_delta",
								index: 0,
								delta: { type: "text_delta", text: "CLI permission completed." },
							},
					{ type: "content_block_stop", index: 0 },
					{
						type: "message_delta",
						delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
						usage: { output_tokens: 8 },
					},
					{ type: "message_stop" },
				];
				return new Response(
					events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		try {
			const modelsFile = path.join(env.PI_CODING_AGENT_DIR!, "models.yml");
			// Use the same isolated real registry as the ordinary CLI tests, backed
			// by a deterministic local protocol peer rather than a fake session.
			const models = JSON.parse(await fs.readFile(modelsFile, "utf8"));
			models.providers["acp-fixture"].baseUrl = provider.url.href;
			models.providers["acp-fixture"].models.push({
				...models.providers["acp-fixture"].models[0],
				id: "transcript-alternate",
				name: "Alternate transcript fixture",
			});
			await fs.writeFile(modelsFile, JSON.stringify(models));
			const socketPath = path.join(cwd, "cockpit.sock");
			const listener = await listen(socketPath);
			const proc = new CliProcess(
				["acp", "--tsp", socketPath, "--tools", "bash"],
				cwd,
				env,
				undefined,
				true,
				cliIsolation.filter(flag => flag !== "--no-tools"),
			);
			const host = new SideChannel(await listener.connection, ["blobs", "settle", "dock", "viewers", "keys"]);
			await proc.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
			const created = await proc.request("session/new", { cwd, mcpServers: [] });
			await proc.changes.wait("bootstrap command catalogue", () =>
				proc.messages.find(
					message =>
						isRecord(message.params?.update) &&
						message.params.update.sessionUpdate === "available_commands_update",
				),
			);
			const configUpdates = () =>
				proc.messages.filter(
					message =>
						isRecord(message.params?.update) && message.params.update.sessionUpdate === "config_option_update",
				);
			const configBaseline = configUpdates().length;
			const shared = host.surface!;
			await host.waitForNode(node => node.p?.role === "omp.dock", shared);
			const model = await host.waitForNode(node => node.p?.role === "omp.composer.model", shared);
			host.event({ ev: "action", sf: shared, id: model.id, act: "model", viewer: "window-a", mods: [] });
			const viewer = await host.changes.wait("audience-addressed model picker", () => {
				const open = host.log.find(
					message => message.verb === "o" && isRecord(message.body) && message.body.viewer === "window-a",
				);
				return open && isRecord(open.body) && typeof open.body.id === "string" ? open.body.id : undefined;
			});
			expect(viewer).toMatch(/^v\.window-a\./);
			await host.waitForNode(node => node.k === "picker", viewer);
			expect(host.find(node => node.k === "picker", shared)).toBeUndefined();
			host.event({ ev: "key", sf: viewer, viewer: "window-a", data: "transcript" });
			host.event({ ev: "action", sf: shared, id: model.id, act: "effort", viewer: "window-b", mods: [] });
			const otherViewer = await host.changes.wait("second isolated viewer", () => {
				const open = host.log.find(
					message => message.verb === "o" && isRecord(message.body) && message.body.viewer === "window-b",
				);
				return open && isRecord(open.body) && typeof open.body.id === "string" ? open.body.id : undefined;
			});
			await host.waitForNode(node => node.k === "picker", otherViewer);
			await host.waitForNode(node => node.k === "picker" && node.p?.query === "transcript", viewer);
			expect(host.find(node => node.k === "picker", otherViewer)?.p).not.toHaveProperty("query", "transcript");
			host.event({ ev: "key", sf: viewer, viewer: "window-b", data: "stolen" });
			host.event({ ev: "viewer", viewer: "window-b", present: false });
			await host.changes.wait("second viewer disposal", () =>
				host.log.some(message => message.verb === "x" && isRecord(message.body) && message.body.id === otherViewer)
					? true
					: undefined,
			);
			expect(host.find(node => node.k === "picker", viewer)?.p).toHaveProperty("query", "transcript");
			const picker = host.find(node => node.k === "picker", viewer);
			if (picker?.k !== "picker") throw new Error("Model picker disappeared");
			const alternate = picker.p?.items?.find(item => item.id.includes("transcript-alternate"));
			if (!alternate) throw new Error("Real model catalogue omitted the alternate model");
			host.event({ ev: "activate", sf: viewer, id: picker.id, item: alternate.id, viewer: "window-a" });
			await host.changes.wait("viewer picker close", () =>
				host.log.some(message => message.verb === "x" && isRecord(message.body) && message.body.id === viewer)
					? true
					: undefined,
			);
			await proc.changes.wait("one model config notification", () =>
				configUpdates().length > configBaseline ? true : undefined,
			);
			expect(configUpdates()).toHaveLength(configBaseline + 1);
			await proc.request("session/prompt", {
				sessionId: created.result?.sessionId,
				prompt: [{ type: "text", text: "/model acp-fixture/transcript" }],
			});
			expect(configUpdates()).toHaveLength(configBaseline + 2);
			const prompt = proc.request("session/prompt", {
				sessionId: created.result?.sessionId,
				prompt: [{ type: "text", text: "Run the permission fixture." }],
			});
			void prompt.catch(() => {});
			const permission = await proc.changes.wait("real ACP permission request", () =>
				proc.messages.find(message => message.method === "session/request_permission"),
			);
			const card = await host.waitForNode(
				node => node.k === "tool" && node.p?.key === "cli-confirm-tool" && node.p.status === "ask",
				shared,
			);
			expect(card.p).toMatchObject({
				confirm: "card",
				ask: { allow: "Allow once", always: "Always allow", deny: "Reject" },
			});
			await host.waitForNode(node => node.p?.role === "omp.working.stop", shared);
			await host.waitForNode(node => node.k === "spinner", shared);
			await host.waitForNode(node => node.k === "elapsed", shared);
			host.event({ ev: "action", sf: shared, id: card.id, act: "allow", mods: [] });
			expect(calls).toBe(1);
			proc.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: permission.id, result: { outcome: { outcome: "selected", optionId: "allow_once" } } })}\n`,
			);
			await prompt;
			await host.waitForNode(
				node =>
					node.k === "tool" &&
					node.p?.key === "cli-confirm-tool" &&
					node.p.approved === "once" &&
					node.p.status === "done",
				shared,
			);
			const settled = host.find(node => node.k === "tool" && node.p?.key === "cli-confirm-tool", shared)!;
			expect(settled.p).not.toHaveProperty("confirm");
			expect(settled.p).not.toHaveProperty("ask");
			expect(calls).toBe(2);
			expect(configUpdates()).toHaveLength(configBaseline + 2);
			// Await session-owned producers, including a bootstrap update that
			// may still be scanning commands, before closing the ACP stream.
			const closed = await proc.request("session/close", { sessionId: created.result?.sessionId });
			expect(closed.error).toBeUndefined();
			await gracefulShutdown(proc, host);
		} finally {
			await provider.stop(true);
		}
	}, 60_000);

	it("loads a real transcript over an ordinary Unix socket, applies native events, and releases it on ACP EOF", async () => {
		const { cwd, env } = await isolatedEnvironment();
		const sessionId = await seedSession(cwd, env);
		const socketPath = path.join(cwd, "surface.sock");
		const listener = await listen(socketPath);
		const proc = new CliProcess(["acp", "--tsp", socketPath], cwd, env);
		const host = new SideChannel(await listener.connection);
		await initializeAndLoad(proc, cwd, sessionId);
		await host.waitForNode(node => node.k === "md" && node.p?.text === "Saved assistant transcript");
		await host.waitForNode(
			node => node.p !== undefined && "text" in node.p && node.p.text === "Find the saved surface fixture",
		);
		const tool = await host.waitForNode(node => node.k === "tool" && node.p?.role === "omp.tool.lookup_thing");
		expect(tool.p).toMatchObject({ status: "done", collapsible: true, collapsed: true });
		host.event({ ev: "toggle", sf: host.surface!, id: tool.id, collapsed: false });
		await host.waitForNode(node => node.k === "tool" && node.id === tool.id && node.p?.collapsed === false);
		await host.waitForNode(
			node => node.k === "ansi" && typeof node.p?.text === "string" && node.p.text.includes("Saved result row 29"),
		);
		const image = await host.waitForNode(node => node.k === "image");
		if (image.k !== "image" || !image.p?.blob) throw new Error("Expected a native image blob reference");
		const blobId = image.p.blob;
		const blob = await host.changes.wait("referenced TSP image blob", () => host.blobs.get(blobId));
		expect(Buffer.from(blob).toString("base64")).toBe(ONE_PIXEL_PNG);

		const previousSurface = host.surface!;
		host.docs.delete(previousSurface);
		host.event({ ev: "gone", ids: [previousSurface] });
		await host.changes.wait("fresh surface after gone", () =>
			host.surface && host.surface !== previousSurface ? host.surface : undefined,
		);
		await host.waitForNode(node => node.k === "md" && node.p?.text === "Saved assistant transcript");
		await gracefulShutdown(proc, host);
	}, 60_000);

	for (const fd of [3, 4]) {
		it(`uses inherited duplex fd ${fd}${fd === 3 ? " with the bare flag" : " with an explicit target"}`, async () => {
			const { cwd, env } = await isolatedEnvironment();
			const sessionId = await seedSession(cwd, env);
			const socketPath = path.join(cwd, "inherited.sock");
			const listener = await listen(socketPath);
			const socket = await connectInheritedSocket(socketPath);
			const host = new SideChannel(await listener.connection);
			const proc = new CliProcess(["acp", ...(fd === 3 ? ["--tsp"] : ["--tsp=4"])], cwd, env, { fd, socket });
			// The child owns its inherited duplicate. Keeping the parent's duplicate
			// open would hide a leaked descriptor during the EOF/close assertion.
			socket.destroy();
			await initializeAndLoad(proc, cwd, sessionId);
			await host.waitForNode(node => node.k === "md" && node.p?.text === "Saved assistant transcript");
			await gracefulShutdown(proc, host);
		}, 60_000);
	}

	it("keeps inherited-fd presentation active while uploading many distinct image blobs in one frame", async () => {
		const { cwd, env } = await isolatedEnvironment();
		const imageCount = 1025;
		const sessionId = await seedSession(cwd, env, imageCount);
		const listener = await listen(path.join(cwd, "many-blobs.sock"));
		const socket = await connectInheritedSocket(path.join(cwd, "many-blobs.sock"));
		const host = new SideChannel(await listener.connection);
		const proc = new CliProcess(["acp", "--tsp"], cwd, env, { fd: 3, socket });
		socket.destroy();
		await initializeAndLoad(proc, cwd, sessionId);
		await host.changes.wait("all distinct native image blobs", () => {
			if (host.closed) throw new Error("TSP peer disconnected during a valid image upload burst");
			return host.blobs.size === imageCount ? true : undefined;
		});
		await host.waitForNode(node => node.k === "md" && node.p?.text === "Saved assistant transcript");
		await gracefulShutdown(proc, host);
	}, 60_000);

	it("reserves --tsp for ACP while preserving ordinary built-in-shadowing extension flags", async () => {
		const { cwd, env } = await isolatedEnvironment();
		const socketPath = path.join(cwd, "owned-flag.sock");
		const listener = await listen(socketPath);
		const socket = await connectInheritedSocket(socketPath);
		const host = new SideChannel(await listener.connection);
		const proc = new CliProcess(["acp", "-e", flagExtension, "--thinking", "--tsp", "4", "--plan"], cwd, env, {
			fd: 4,
			socket,
		});
		socket.destroy();
		await proc.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
		const created = await proc.request("session/new", { cwd, mcpServers: [] });
		const response = await proc.request("session/prompt", {
			sessionId: created.result?.sessionId,
			prompt: [{ type: "text", text: "/flag-ownership" }],
		});
		expect(response.result?.stopReason).toBe("end_turn");
		await host.waitForNode(
			node =>
				node.p !== undefined &&
				"text" in node.p &&
				typeof node.p.text === "string" &&
				node.p.text.includes("tsp=extension-default") &&
				node.p.text.includes("plan=true") &&
				node.p.text.includes("thinking=true"),
		);
		await gracefulShutdown(proc, host);
	}, 60_000);

	it("rejects reserved stdio descriptors before loading an extension with a colliding --tsp flag", async () => {
		const { cwd, env } = await isolatedEnvironment();
		const proc = new CliProcess(["acp", "-e", flagExtension, "--thinking", "--tsp=0"], cwd, env);
		expect(await proc.exited()).toEqual({ code: 2, signal: null });
		expect(proc.stdout).toBe("");
		expect(proc.stderr).toContain("descriptors 0, 1, and 2 are reserved");
	}, 60_000);

	it("keeps ACP sessions usable after an established side-channel peer disconnects", async () => {
		const { cwd, env } = await isolatedEnvironment();
		const sessionId = await seedSession(cwd, env);
		const listener = await listen(path.join(cwd, "disconnect.sock"));
		const proc = new CliProcess(["acp", "--tsp", path.join(cwd, "disconnect.sock")], cwd, env);
		const host = new SideChannel(await listener.connection);
		await initializeAndLoad(proc, cwd, sessionId);
		await host.waitForNode(node => node.k === "md" && node.p?.text === "Saved assistant transcript");
		host.peer.destroy();
		await host.changes.wait("peer disconnect", () => (host.closed ? true : undefined));
		const next = await proc.request("session/new", { cwd, mcpServers: [] });
		expect(typeof next.result?.sessionId).toBe("string");
		expect(next.result?.sessionId).not.toBe(sessionId);
		proc.stdin.end();
		expect(await proc.exited(), proc.stderr).toEqual({ code: 0, signal: null });
		proc.assertRpcOnly();
		host.assertValid();
	}, 60_000);

	for (const target of ["999999", "missing.sock"]) {
		it(`fails an explicit unavailable ${target === "999999" ? "descriptor" : "socket"} before emitting ACP stdout`, async () => {
			const { cwd, env } = await isolatedEnvironment();
			const value = target === "999999" ? target : path.join(cwd, target);
			const proc = new CliProcess(["acp", `--tsp=${value}`], cwd, env);
			const exit = await proc.exited();
			expect(exit.signal).toBeNull();
			expect(exit.code).not.toBe(0);
			expect(proc.stdout).toBe("");
			expect(proc.stderr).toContain("TSP");
			expect(proc.stderr).toContain(value);
			expect(proc.stderr).toMatch(/socket|descriptor|fd|open|connect|ENOENT|EBADF/i);
		}, 60_000);
	}

	it("reports a clean usage error for --tsp outside ACP rather than attempting a connection", async () => {
		const { cwd, env } = await isolatedEnvironment();
		const proc = new CliProcess(
			["--mode=json", "--print", `--tsp=${path.join(cwd, "unused.sock")}`],
			cwd,
			env,
			undefined,
			false,
		);
		proc.stdin.end();
		const exit = await proc.exited();
		expect(exit.signal).toBeNull();
		expect(exit.code).not.toBe(0);
		expect(proc.stdout).toBe("");
		expect(proc.stderr).toContain("--tsp requires ACP mode");
		expect(proc.stderr).not.toContain("ENOENT");
		expect(proc.stderr).not.toContain(" at ");
	}, 60_000);
});
