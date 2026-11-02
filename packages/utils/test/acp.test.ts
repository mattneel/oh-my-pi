import { describe, expect, it } from "bun:test";
import {
	AgentSideConnection,
	type AnyMessage,
	type Client,
	ClientSideConnection,
	ndJsonStream,
	RequestError,
	RpcConnection,
	schema,
} from "../src/acp";

function transportPair() {
	const leftToRight = new TransformStream<Uint8Array, Uint8Array>();
	const rightToLeft = new TransformStream<Uint8Array, Uint8Array>();
	return {
		left: ndJsonStream(leftToRight.writable, rightToLeft.readable),
		right: ndJsonStream(rightToLeft.writable, leftToRight.readable),
	};
}

describe("ACP JSON-RPC transport", () => {
	it("round-trips requests, notifications, and errors", async () => {
		const pair = transportPair();
		const updates: unknown[] = [];
		const updateReceived = Promise.withResolvers<void>();
		const client: Client = {
			requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
			sessionUpdate: async update => {
				updates.push(update);
				updateReceived.resolve();
			},
		};
		const clientConnection = new ClientSideConnection(() => client, pair.left);
		const agentConnection = new AgentSideConnection(
			connection => ({
				initialize: params => ({ protocolVersion: params.protocolVersion }),
				newSession: async () => ({ sessionId: "session-1" }),
				prompt: async params => {
					if (params.prompt.length === 0) throw RequestError.invalidParams({ field: "prompt" });
					await connection.requestPermission({
						sessionId: params.sessionId,
						toolCall: { toolCallId: "tool-1" },
						options: [],
					});
					return { stopReason: "end_turn" };
				},
				cancel: async () => {},
			}),
			pair.right,
		);

		await expect(clientConnection.initialize({ protocolVersion: 1, clientCapabilities: {} })).resolves.toEqual({
			protocolVersion: 1,
		});
		await agentConnection.sessionUpdate({ sessionId: "session-1", update: { sessionUpdate: "plan", entries: [] } });
		await updateReceived.promise;
		expect(updates).toHaveLength(1);
		await expect(
			clientConnection.prompt({
				sessionId: "session-1",
				prompt: [{ type: "text", text: "nested request" }],
			}),
		).resolves.toEqual({ stopReason: "end_turn" });
		await expect(clientConnection.prompt({ sessionId: "session-1", prompt: [] })).rejects.toMatchObject({
			code: -32602,
			data: { field: "prompt" },
		});
	});

	it("correlates out-of-order responses", async () => {
		const requests = new TransformStream<AnyMessage, AnyMessage>();
		const responses = new TransformStream<AnyMessage, AnyMessage>();
		const connection = new RpcConnection(
			{ writable: requests.writable, readable: responses.readable },
			() => undefined,
		);
		const reader = requests.readable.getReader();
		const writer = responses.writable.getWriter();
		const first = connection.request<string>("first");
		const second = connection.request<string>("second");
		const firstMessage = await reader.read();
		const secondMessage = await reader.read();
		if (firstMessage.done || secondMessage.done || !("id" in firstMessage.value) || !("id" in secondMessage.value))
			throw new Error("Expected requests");
		await writer.write({ jsonrpc: "2.0", id: secondMessage.value.id, result: "two" });
		await writer.write({ jsonrpc: "2.0", id: firstMessage.value.id, result: "one" });
		await expect(Promise.all([first, second])).resolves.toEqual(["one", "two"]);
		reader.releaseLock();
		writer.releaseLock();
	});

	it("decodes split and batched NDJSON frames", async () => {
		const bytes = new TransformStream<Uint8Array, Uint8Array>();
		const output = new TransformStream<Uint8Array, Uint8Array>();
		const stream = ndJsonStream(output.writable, bytes.readable);
		const writer = bytes.writable.getWriter();
		const reader = stream.readable.getReader();
		await writer.write(new TextEncoder().encode('{"jsonrpc":"2.0","method":"a","par'));
		await writer.write(new TextEncoder().encode('ams":{}}\n{"jsonrpc":"2.0","method":"b"}\n'));
		expect(await reader.read()).toMatchObject({ value: { method: "a", params: {} } });
		expect(await reader.read()).toMatchObject({ value: { method: "b" } });
		writer.releaseLock();
		reader.releaseLock();
	});
	it("drains accepted inbound requests before resolving closed on clean EOF", async () => {
		const inbound = new TransformStream<AnyMessage, AnyMessage>();
		const outbound = new TransformStream<AnyMessage, AnyMessage>();
		const sessionStarted = Promise.withResolvers<void>();
		const releaseSession = Promise.withResolvers<void>();
		const connection = new RpcConnection(
			{ writable: outbound.writable, readable: inbound.readable },
			async method => {
				if (method === "initialize") return { protocolVersion: 1 };
				if (method === "session/new") {
					sessionStarted.resolve();
					await releaseSession.promise;
					return { sessionId: "session-1" };
				}
				throw RequestError.methodNotFound(method);
			},
		);
		const writer = inbound.writable.getWriter();
		const reader = outbound.readable.getReader();
		await writer.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
		await writer.write({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
		await sessionStarted.promise;
		await writer.close();

		const initialize = await reader.read();
		expect(initialize.done).toBe(false);
		expect(initialize.value).toEqual({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });

		const closedBeforeDrain = await Promise.race([
			connection.closed.then(() => true),
			new Promise<boolean>(resolve => setTimeout(() => resolve(false), 25)),
		]);
		expect(closedBeforeDrain).toBe(false);

		releaseSession.resolve();
		const created = await reader.read();
		expect(created.done).toBe(false);
		expect(created.value).toEqual({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } });
		await connection.closed;
		reader.releaseLock();
	});

	it("still fail-fast closes on read errors without waiting for inbound handlers", async () => {
		const inbound = new TransformStream<AnyMessage, AnyMessage>();
		const outbound = new TransformStream<AnyMessage, AnyMessage>();
		const started = Promise.withResolvers<void>();
		const hold = Promise.withResolvers<void>();
		const connection = new RpcConnection({ writable: outbound.writable, readable: inbound.readable }, async () => {
			started.resolve();
			await hold.promise;
			return {};
		});
		const writer = inbound.writable.getWriter();
		await writer.write({ jsonrpc: "2.0", id: 1, method: "slow" });
		await started.promise;
		await writer.abort(new Error("broken pipe"));
		await connection.closed;
		hold.resolve();
	});

	it("drops queued and late notifications once the connection closes", async () => {
		const inbound = new TransformStream<AnyMessage>();
		const messages: AnyMessage[] = [];
		const writable = new WritableStream<AnyMessage>({
			write(message) {
				messages.push(message);
			},
		});
		const connection = new RpcConnection({ writable, readable: inbound.readable }, () => undefined);
		const queued = connection.notify("queued");
		connection.close();
		const late = connection.notify("late");
		await Promise.all([queued, late]);
		expect(messages).toEqual([]);
		await inbound.writable.close();
		await writable.close();
	});

	it("closes on a failed notification write and rejects pending requests without rejecting the notification", async () => {
		const inbound = new TransformStream<AnyMessage>();
		const failure = new Error("outbound stream closed");
		let writes = 0;
		const writable = new WritableStream<AnyMessage>({
			write() {
				writes++;
				throw failure;
			},
		});
		const connection = new RpcConnection({ writable, readable: inbound.readable }, () => undefined);
		const notification = connection.notify("event");
		const request = connection.request("pending");
		const rejected = request.catch((error: unknown) => error);
		await notification;
		expect(await rejected).toBe(failure);
		await connection.closed;
		expect(connection.signal.reason).toBe(failure);
		expect(writes).toBe(1);
		await expect(connection.request("after-close")).rejects.toThrow("Connection closed");
		await inbound.writable.close();
	});

	it("lets an accepted write settle while dropping writes queued behind it at close", async () => {
		const inbound = new TransformStream<AnyMessage>();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const messages: AnyMessage[] = [];
		const writable = new WritableStream<AnyMessage>({
			async write(message) {
				messages.push(message);
				started.resolve();
				await release.promise;
			},
		});
		const connection = new RpcConnection({ writable, readable: inbound.readable }, () => undefined);
		const accepted = connection.notify("accepted");
		await started.promise;
		const queued = connection.notify("queued");
		connection.close();
		release.resolve();
		await Promise.all([accepted, queued]);
		expect(messages).toEqual([{ jsonrpc: "2.0", method: "accepted" }]);
		await inbound.writable.close();
		await writable.close();
	});

	it.each(["success", "error"])("exposes inbound response write completion for %s responses", async outcome => {
		const inbound = new TransformStream<AnyMessage>();
		const writeStarted = Promise.withResolvers<void>();
		const releaseWrite = Promise.withResolvers<void>();
		const messages: AnyMessage[] = [];
		const dispatched = Promise.withResolvers<{ responseWritten: Promise<void> }>();
		const writable = new WritableStream<AnyMessage>({
			async write(message) {
				messages.push(message);
				writeStarted.resolve();
				await releaseWrite.promise;
			},
		});
		const connection = new RpcConnection(
			{ writable, readable: inbound.readable },
			(_method, _params, _notification, _signal, written) => {
				if (!written) throw new Error("Expected inbound response write promise");
				dispatched.resolve({ responseWritten: written });
				if (outcome === "error") throw RequestError.invalidParams();
				return "result";
			},
		);
		const writer = inbound.writable.getWriter();
		await writer.write({ jsonrpc: "2.0", id: 42, method: "request", params: {} });
		await writeStarted.promise;
		const { responseWritten } = await dispatched.promise;
		let settled = false;
		const written = responseWritten.then(() => {
			settled = true;
		});
		await connection.waitForSessionRequests("unrelated");
		expect(settled).toBe(false);
		expect(messages).toEqual([
			outcome === "error"
				? { jsonrpc: "2.0", id: 42, error: { code: -32602, message: "Invalid params" } }
				: { jsonrpc: "2.0", id: 42, result: "result" },
		]);
		releaseWrite.resolve();
		await written;
		expect(settled).toBe(true);
		await writer.close();
		await connection.closed;
		await writable.close();
		writer.releaseLock();
	});

	it("looks up response writes by the agent handler's exact params object", async () => {
		const inbound = new TransformStream<AnyMessage>();
		const writeStarted = Promise.withResolvers<void>();
		const releaseWrite = Promise.withResolvers<void>();
		const dispatched = Promise.withResolvers<{ responseWritten: Promise<void> }>();
		const writable = new WritableStream<AnyMessage>({
			async write() {
				writeStarted.resolve();
				await releaseWrite.promise;
			},
		});
		const connection = new AgentSideConnection(
			agent => ({
				initialize: params => ({ protocolVersion: params.protocolVersion }),
				newSession: params => {
					dispatched.resolve({ responseWritten: agent.responseWritten(params) });
					return { sessionId: "session" };
				},
				prompt: () => ({ stopReason: "end_turn" }),
				cancel: () => {},
			}),
			{ writable, readable: inbound.readable },
		);
		await connection.responseWritten({});
		const writer = inbound.writable.getWriter();
		await writer.write({
			jsonrpc: "2.0",
			id: 42,
			method: "session/new",
			params: { cwd: "/project", mcpServers: [] },
		});
		await writeStarted.promise;
		const { responseWritten } = await dispatched.promise;
		let settled = false;
		const written = responseWritten.then(() => {
			settled = true;
		});
		await connection.responseWritten({ cwd: "/project", mcpServers: [] });
		expect(settled).toBe(false);
		releaseWrite.resolve();
		await written;
		await writer.close();
		await connection.closed;
		await writable.close();
		writer.releaseLock();
	});

	it("settles only correlated requests for the requested session, including peer errors", async () => {
		const inbound = new TransformStream<AnyMessage>();
		const outbound = new TransformStream<AnyMessage>();
		const connection = new RpcConnection(
			{ writable: outbound.writable, readable: inbound.readable },
			() => undefined,
		);
		const reader = outbound.readable.getReader();
		const writer = inbound.writable.getWriter();
		const read = connection.request("fs/read_text_file", { sessionId: "first", path: "/read" });
		const permission = connection.request("session/request_permission", { sessionId: "first" });
		const elicitation = connection.request("elicitation/create", { sessionId: "second" });
		const write = connection.request("fs/write_text_file", { sessionId: "second", path: "/write", content: "" });
		const rejected = permission.catch((error: unknown) => error);
		const frames = [];
		for (let i = 0; i < 4; i++) {
			const frame = (await reader.read()).value;
			if (!frame || !("id" in frame)) throw new Error("Expected request");
			frames.push(frame);
		}
		let firstSettled = false;
		let secondSettled = false;
		const firstBarrier = connection.waitForSessionRequests("first").then(() => {
			firstSettled = true;
		});
		const secondBarrier = connection.waitForSessionRequests("second").then(() => {
			secondSettled = true;
		});
		await connection.waitForSessionRequests("unrelated");
		await writer.write({ jsonrpc: "2.0", id: "unknown", result: {} });
		await writer.write({ jsonrpc: "2.0", id: frames[2].id, result: { action: "cancel" } });
		await elicitation;
		await writer.write({ jsonrpc: "2.0", id: frames[0].id, result: { content: "read" } });
		await read;
		expect(firstSettled).toBe(false);
		expect(secondSettled).toBe(false);
		await writer.write({
			jsonrpc: "2.0",
			id: frames[1].id,
			error: { code: -32602, message: "Denied" },
		});
		await firstBarrier;
		expect(await rejected).toMatchObject({ code: -32602, message: "Denied" });
		expect(firstSettled).toBe(true);
		expect(secondSettled).toBe(false);
		await writer.write({ jsonrpc: "2.0", id: frames[3].id, result: {} });
		await Promise.all([write, secondBarrier]);
		expect(secondSettled).toBe(true);
		connection.close();
		await writer.close();
		reader.releaseLock();
		writer.releaseLock();
	});

	it("keeps draining matching requests started by a settling request's continuation", async () => {
		const inbound = new TransformStream<AnyMessage>();
		const outbound = new TransformStream<AnyMessage>();
		const connection = new RpcConnection(
			{ writable: outbound.writable, readable: inbound.readable },
			() => undefined,
		);
		const reader = outbound.readable.getReader();
		const writer = inbound.writable.getWriter();
		const first = connection.request("first", { sessionId: "session" });
		const followOn = first.then(() => connection.request("follow-on", { sessionId: "session" }));
		let settled = false;
		const barriers = Promise.all([
			connection.waitForSessionRequests("session"),
			connection.waitForSessionRequests("session"),
		]).then(() => {
			settled = true;
		});
		const firstFrame = (await reader.read()).value;
		if (!firstFrame || !("id" in firstFrame)) throw new Error("Expected request");
		await writer.write({ jsonrpc: "2.0", id: firstFrame.id, result: {} });
		const nextFrame = (await reader.read()).value;
		if (!nextFrame || !("id" in nextFrame)) throw new Error("Expected follow-on request");
		expect(settled).toBe(false);
		await writer.write({ jsonrpc: "2.0", id: nextFrame.id, result: "done" });
		await expect(followOn).resolves.toBe("done");
		await barriers;
		connection.close();
		await writer.close();
		reader.releaseLock();
		writer.releaseLock();
	});

	it.each(["before", "after"])("waits for the cancellation write and a peer response arriving %s it", async order => {
		const inbound = new TransformStream<AnyMessage>();
		const cancelStarted = Promise.withResolvers<void>();
		const releaseCancel = Promise.withResolvers<void>();
		const messages: AnyMessage[] = [];
		const writable = new WritableStream<AnyMessage>({
			async write(message) {
				messages.push(message);
				if ("method" in message && message.method === "$/cancel_request") {
					cancelStarted.resolve();
					await releaseCancel.promise;
				}
			},
		});
		const connection = new RpcConnection({ writable, readable: inbound.readable }, () => undefined);
		const writer = inbound.writable.getWriter();
		const request = connection.requestCancellable("elicitation/create", { sessionId: "session" });
		if (request.id === undefined) throw new Error("Expected cancellable request id");
		const rejected = request.promise.catch((error: unknown) => error);
		let settled = false;
		const barrier = connection.waitForSessionRequests("session").then(() => {
			settled = true;
		});
		request.cancel();
		expect(await rejected).toMatchObject({ code: -32800 });
		await cancelStarted.promise;
		expect(settled).toBe(false);
		expect(messages).toEqual([
			{ jsonrpc: "2.0", id: request.id, method: "elicitation/create", params: { sessionId: "session" } },
			{ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: request.id } },
		]);
		await connection.waitForSessionRequests("other");
		const response: AnyMessage =
			order === "before"
				? { jsonrpc: "2.0", id: request.id, result: { action: "cancel" } }
				: { jsonrpc: "2.0", id: request.id, error: { code: -32800, message: "Cancelled" } };
		if (order === "before") {
			// Even a peer reply cannot bypass an unfinished cancellation write.
			await writer.write(response);
			expect(settled).toBe(false);
		}
		request.cancel();
		releaseCancel.resolve();
		if (order === "after") {
			// A subsequent queued write fences completion of the cancel write.
			await connection.notify("write-fence");
			expect(settled).toBe(false);
			await writer.write({ jsonrpc: "2.0", id: "unrelated", result: {} });
			expect(settled).toBe(false);
			await writer.write(response);
		}
		await barrier;
		await connection.waitForSessionRequests("session");
		expect(messages.filter(message => "method" in message && message.method === "$/cancel_request")).toHaveLength(1);
		expect(connection.signal.aborted).toBe(false);
		connection.close();
		await writer.close();
		await writable.close();
		writer.releaseLock();
	});

	it("rejects active session barriers and requests when the connection closes", async () => {
		const inbound = new TransformStream<AnyMessage>();
		const writable = new WritableStream<AnyMessage>();
		const connection = new RpcConnection({ writable, readable: inbound.readable }, () => undefined);
		const failure = new Error("connection lost");
		const request = connection.request("fs/read_text_file", { sessionId: "session", path: "/file" });
		const requestRejected = request.catch((error: unknown) => error);
		const barrierRejected = connection.waitForSessionRequests("session").catch((error: unknown) => error);
		connection.close(failure);
		const rejected = await Promise.all([requestRejected, barrierRejected]);
		expect(rejected).toEqual([failure, failure]);
		await expect(connection.waitForSessionRequests("session")).rejects.toBe(failure);
		await inbound.writable.close();
		await writable.close();
	});

	it("rejects a cancelled session barrier on close even if its cancellation write is held", async () => {
		const inbound = new TransformStream<AnyMessage>();
		const cancelStarted = Promise.withResolvers<void>();
		const releaseCancel = Promise.withResolvers<void>();
		const writable = new WritableStream<AnyMessage>({
			async write(message) {
				if ("method" in message && message.method === "$/cancel_request") {
					cancelStarted.resolve();
					await releaseCancel.promise;
				}
			},
		});
		const connection = new RpcConnection({ writable, readable: inbound.readable }, () => undefined);
		const request = connection.requestCancellable("session/request_permission", { sessionId: "session" });
		const requestRejected = request.promise.catch((error: unknown) => error);
		const barrierRejected = connection.waitForSessionRequests("session").catch((error: unknown) => error);
		request.cancel();
		expect(await requestRejected).toMatchObject({ code: -32800 });
		await cancelStarted.promise;
		connection.close();
		expect(await barrierRejected).toMatchObject({ message: "Connection closed" });
		releaseCancel.resolve();
		await inbound.writable.close();
		await writable.close();
	});

	it("cancels only matching session requests once while retaining wire settlement", async () => {
		const inbound = new TransformStream<AnyMessage>();
		const messages: AnyMessage[] = [];
		const writable = new WritableStream<AnyMessage>({
			write(message) {
				messages.push(message);
			},
		});
		const connection = new AgentSideConnection(
			() => ({
				initialize: params => ({ protocolVersion: params.protocolVersion }),
				newSession: () => ({ sessionId: "first" }),
				prompt: () => ({ stopReason: "end_turn" }),
				cancel: () => {},
			}),
			{ writable, readable: inbound.readable },
		);
		const writer = inbound.writable.getWriter();
		const read = connection.readTextFile({ sessionId: "first", path: "/file" });
		const permission = connection.requestPermissionWithCancel({
			sessionId: "first",
			toolCall: { toolCallId: "permission" },
			options: [],
		});
		const other = connection.readTextFile({ sessionId: "second", path: "/file" });
		const unscoped = connection.request("unscoped");
		const readRejected = read.catch((error: unknown) => error);
		const permissionRejected = permission.promise.catch((error: unknown) => error);
		let firstSettled = false;
		let secondSettled = false;
		const firstBarrier = connection.waitForSessionRequests("first").then(() => {
			firstSettled = true;
		});
		const secondBarrier = connection.waitForSessionRequests("second").then(() => {
			secondSettled = true;
		});
		connection.cancelSessionRequests("first");
		connection.cancelSessionRequests("first");
		connection.cancelSessionRequests("unknown");
		permission.cancel();
		await connection.notify("write-fence");
		expect(await readRejected).toMatchObject({ code: -32800, data: { method: "fs/read_text_file" } });
		expect(await permissionRejected).toMatchObject({ code: -32800, data: { method: "session/request_permission" } });
		const [readFrame, permissionFrame, otherFrame, unscopedFrame] = messages;
		if (!("id" in readFrame) || !("id" in permissionFrame) || !("id" in otherFrame) || !("id" in unscopedFrame))
			throw new Error("Expected outgoing request frames");
		expect(messages.filter(message => "method" in message && message.method === "$/cancel_request")).toEqual([
			{ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: readFrame.id } },
			{ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: permissionFrame.id } },
		]);
		expect(firstSettled).toBe(false);
		expect(secondSettled).toBe(false);
		await writer.write({ jsonrpc: "2.0", id: readFrame.id, result: { content: "late" } });
		expect(firstSettled).toBe(false);
		await writer.write({
			jsonrpc: "2.0",
			id: permissionFrame.id,
			error: { code: -32800, message: "Cancelled" },
		});
		await firstBarrier;
		expect(firstSettled).toBe(true);
		expect(secondSettled).toBe(false);
		await writer.write({ jsonrpc: "2.0", id: otherFrame.id, result: { content: "other" } });
		await writer.write({ jsonrpc: "2.0", id: unscopedFrame.id, result: "unscoped" });
		await expect(other).resolves.toEqual({ content: "other" });
		await expect(unscoped).resolves.toBe("unscoped");
		await secondBarrier;
		await writer.close();
		await connection.closed;
		await writable.close();
		writer.releaseLock();
	});

	it("associates terminal creation and every terminal handle request with the creating session", async () => {
		const inbound = new TransformStream<AnyMessage>();
		const outbound = new TransformStream<AnyMessage>();
		const connection = new AgentSideConnection(
			() => ({
				initialize: params => ({ protocolVersion: params.protocolVersion }),
				newSession: () => ({ sessionId: "session" }),
				prompt: () => ({ stopReason: "end_turn" }),
				cancel: () => {},
			}),
			{ writable: outbound.writable, readable: inbound.readable },
		);
		const reader = outbound.readable.getReader();
		const writer = inbound.writable.getWriter();
		const creating = connection.createTerminal({ sessionId: "session", command: "shell" });
		let created = false;
		const creationBarrier = connection.waitForSessionRequests("session").then(() => {
			created = true;
		});
		const createFrame = (await reader.read()).value;
		if (!createFrame || !("id" in createFrame)) throw new Error("Expected terminal creation");
		expect(created).toBe(false);
		await writer.write({ jsonrpc: "2.0", id: createFrame.id, result: { terminalId: "terminal" } });
		const terminal = await creating;
		await creationBarrier;
		const methods = ["terminal/output", "terminal/wait_for_exit", "terminal/kill", "terminal/release"];
		const requests = [terminal.currentOutput(), terminal.waitForExit(), terminal.kill(), terminal.release()];
		let settled = false;
		const barrier = connection.waitForSessionRequests("session").then(() => {
			settled = true;
		});
		for (const method of methods) {
			const frame = (await reader.read()).value;
			if (!frame || !("id" in frame)) throw new Error("Expected terminal request");
			expect(frame).toEqual({
				jsonrpc: "2.0",
				id: frame.id,
				method,
				params: { sessionId: "session", terminalId: "terminal" },
			});
			expect(settled).toBe(false);
			await writer.write({
				jsonrpc: "2.0",
				id: frame.id,
				result: method === "terminal/output" ? { output: "", truncated: false } : {},
			});
		}
		await Promise.all([...requests, barrier]);
		expect(settled).toBe(true);
		await writer.close();
		await connection.closed;
		reader.releaseLock();
		writer.releaseLock();
	});

	it("matches the SDK error-code fixtures", () => {
		expect([
			RequestError.parseError().toErrorResponse(),
			RequestError.invalidRequest().toErrorResponse(),
			RequestError.methodNotFound("missing").toErrorResponse(),
			RequestError.invalidParams().toErrorResponse(),
			RequestError.internalError().toErrorResponse(),
			RequestError.requestCancelled().toErrorResponse(),
			RequestError.authRequired().toErrorResponse(),
			RequestError.resourceNotFound("file:///missing").toErrorResponse(),
			RequestError.sessionBusy("Agent is already processing.", { reason: "session_busy" }).toErrorResponse(),
		]).toEqual([
			{ code: -32700, message: "Parse error" },
			{ code: -32600, message: "Invalid request" },
			{ code: -32601, message: '"Method not found": missing', data: { method: "missing" } },
			{ code: -32602, message: "Invalid params" },
			{ code: -32603, message: "Internal error" },
			{ code: -32800, message: "Request cancelled" },
			{ code: -32000, message: "Authentication required" },
			{ code: -32002, message: "Resource not found: file:///missing", data: { uri: "file:///missing" } },
			{ code: -32003, message: "Agent is already processing.", data: { reason: "session_busy" } },
		]);
	});

	it("requestCancellable rejects the pending entry, notifies $/cancel_request, and ignores late responses", async () => {
		const inbound = new TransformStream<AnyMessage, AnyMessage>();
		const outbound = new TransformStream<AnyMessage, AnyMessage>();
		const connection = new RpcConnection({ writable: outbound.writable, readable: inbound.readable }, async () => {
			throw RequestError.methodNotFound("unused");
		});
		const reader = outbound.readable.getReader();
		const writer = inbound.writable.getWriter();

		const { promise, cancel } = connection.requestCancellable<{ outcome: unknown }>("session/request_permission", {
			sessionId: "session-1",
		});

		// The request frame goes out with a fresh id.
		const requestFrame = await reader.read();
		expect(requestFrame.value).toMatchObject({ jsonrpc: "2.0", method: "session/request_permission" });
		const requestId = (requestFrame.value as { id: number }).id;

		cancel();

		// The promise rejects as request-cancelled …
		const error = await promise.then(
			() => undefined,
			(rejection: unknown) => rejection,
		);
		expect(error).toBeInstanceOf(RequestError);
		expect((error as RequestError).code).toBe(-32800);

		// … the peer is told via $/cancel_request …
		const cancelFrame = await reader.read();
		expect(cancelFrame.value).toEqual({
			jsonrpc: "2.0",
			method: "$/cancel_request",
			params: { requestId },
		});

		// … and a late response for the dropped entry is ignored rather than
		// rejecting anything or throwing on an unknown id.
		await writer.write({
			jsonrpc: "2.0",
			id: requestId,
			result: { outcome: { outcome: "selected", optionId: "x" } },
		});
		await Bun.sleep(0);
		expect(connection.signal.aborted).toBe(false);

		// A second cancel is a no-op — the entry is already gone.
		cancel();
		await Bun.sleep(0);
		await connection.close();
		reader.releaseLock();
		writer.releaseLock();
	});

	it("requestPermissionWithCancel ends the client's inbound handler via its abort signal", async () => {
		// The receiving half of a cancelled elicit: `cancel()` used to only
		// drop the sender's pending entry and send `$/cancel_request` — the
		// client-side handler (a dialog) never learned about it and held the
		// clean-EOF drain until the 30 s timeout. The handler now receives the
		// request's abort signal, ends on it, and its late response is
		// suppressed on the agent side.
		const pair = transportPair();
		const handlerStarted = Promise.withResolvers<void>();
		const handlerEnded = Promise.withResolvers<void>();
		let handlerSignal: AbortSignal | undefined;
		const client: Client = {
			requestPermission(_params, options) {
				handlerSignal = options?.signal;
				handlerStarted.resolve();
				const gate = Promise.withResolvers<void>();
				if (options?.signal?.aborted) gate.resolve();
				else options?.signal?.addEventListener("abort", () => gate.resolve(), { once: true });
				return gate.promise.then(() => {
					handlerEnded.resolve();
					return { outcome: { outcome: "cancelled" as const } };
				});
			},
			sessionUpdate: async () => {},
		};
		const _clientConnection = new ClientSideConnection(() => client, pair.left);
		const agentConnection = new AgentSideConnection(
			connection => ({
				initialize: params => ({ protocolVersion: params.protocolVersion }),
				newSession: async () => ({ sessionId: "session-1" }),
				prompt: async () => {
					void connection;
					return { stopReason: "end_turn" };
				},
				cancel: async () => {},
			}),
			pair.right,
		);

		const { promise, cancel } = agentConnection.requestPermissionWithCancel({
			sessionId: "session-1",
			toolCall: { toolCallId: "tool-1" },
			options: [],
		});
		await handlerStarted.promise;
		expect(handlerSignal).toBeDefined();

		// Agent-side cancellation must reach the handler through its signal…
		cancel();
		await handlerEnded.promise;

		// …and reject the elicit as request-cancelled; the handler's late
		// response for the dropped id is ignored (covered by the sender-side
		// test above), so nothing throws on either side.
		const error = await promise.then(
			() => undefined,
			(rejection: unknown) => rejection,
		);
		expect(error).toBeInstanceOf(RequestError);
		expect((error as RequestError).code).toBe(-32800);
	});

	it("answers a peer $/cancel_request with -32800 on the wire when the dispatcher honors cancellation", async () => {
		// ACP v1 spec: a cancelled inbound request must still receive a
		// response. The transport aborts the handler and writes the
		// `-32800` error itself, so a client that cancels its elicit is
		// never left waiting on a handler that may never settle.
		const inbound = new TransformStream<AnyMessage, AnyMessage>();
		const outbound = new TransformStream<AnyMessage, AnyMessage>();
		const handlerAborted = Promise.withResolvers<void>();
		const connection = new RpcConnection(
			{ writable: outbound.writable, readable: inbound.readable },
			async (_method: string, _params: unknown, _notification: boolean, signal?: AbortSignal) => {
				// A handler that parks until its abort signal fires: only the
				// transport's own response can settle the exchange.
				signal?.addEventListener("abort", () => handlerAborted.resolve(), { once: true });
				await handlerAborted.promise;
				return {};
			},
			{ honorsInboundCancellation: true },
		);
		const writer = inbound.writable.getWriter();
		const reader = outbound.readable.getReader();
		await writer.write({ jsonrpc: "2.0", id: 41, method: "session/request_permission" });
		await writer.write({
			jsonrpc: "2.0",
			method: "$/cancel_request",
			params: { requestId: 41 },
		});
		const response = (await reader.read()).value as { id: number; error?: { code: number } };
		expect(response.id).toBe(41);
		expect(response.error?.code).toBe(-32800);
		// The handler was aborted by the cancellation, not just answered around.
		await handlerAborted.promise;
		await connection.close();
		writer.releaseLock();
		reader.releaseLock();
	});

	it("keeps an agent request running and answers with its real result after a peer $/cancel_request", async () => {
		// The agent side's handlers never observe a cancel signal (prompts
		// are cancelled through `session/cancel`). Answering `-32800` there
		// would tell the client its prompt was cancelled while the turn kept
		// streaming, and drop the real stop reason.
		const inbound = new TransformStream<AnyMessage, AnyMessage>();
		const outbound = new TransformStream<AnyMessage, AnyMessage>();
		const finishPrompt = Promise.withResolvers<void>();
		const promptStarted = Promise.withResolvers<void>();
		const _agentConnection = new AgentSideConnection(
			() => ({
				initialize: params => ({ protocolVersion: params.protocolVersion }),
				newSession: async () => ({ sessionId: "session-1" }),
				prompt: async () => {
					promptStarted.resolve();
					await finishPrompt.promise;
					return { stopReason: "end_turn" };
				},
				cancel: async () => {},
			}),
			{ writable: outbound.writable, readable: inbound.readable },
		);
		const writer = inbound.writable.getWriter();
		const reader = outbound.readable.getReader();
		await writer.write({
			jsonrpc: "2.0",
			id: 7,
			method: "session/prompt",
			params: { sessionId: "session-1", prompt: [{ type: "text", text: "hi" }] },
		});
		await promptStarted.promise;
		await writer.write({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: 7 } });
		finishPrompt.resolve();
		const response = (await reader.read()).value;
		expect(response).toEqual({ jsonrpc: "2.0", id: 7, result: { stopReason: "end_turn" } });
		writer.releaseLock();
		reader.releaseLock();
	});
});

describe("ACP runtime schemas", () => {
	it("accepts valid protocol vectors", () => {
		expect(schema.zNewSessionResponse.safeParse({ sessionId: "s" }).success).toBe(true);
		expect(schema.zPromptResponse.safeParse({ stopReason: "end_turn" }).success).toBe(true);
		expect(
			schema.zSessionNotification.safeParse({
				sessionId: "s",
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
			}).success,
		).toBe(true);
	});

	it("rejects malformed protocol vectors", () => {
		expect(schema.zNewSessionResponse.safeParse({ sessionId: 4 }).success).toBe(false);
		expect(schema.zPromptResponse.safeParse({ stopReason: "done" }).success).toBe(false);
		expect(
			schema.zSessionNotification.safeParse({
				sessionId: "s",
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text" } },
			}).success,
		).toBe(false);
	});
});
