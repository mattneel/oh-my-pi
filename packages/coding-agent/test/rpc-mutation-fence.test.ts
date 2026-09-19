import { describe, expect, test } from "bun:test";
import { rpcCommandFencedDuringHandoff, rpcCommandMutatesSession } from "../src/modes/rpc/mutation-fence";
import type { RpcCommand } from "../src/modes/rpc/rpc-types";

describe("RPC mutation fencing", () => {
	test("keeps observation commands available while rejecting session mutations", () => {
		expect(rpcCommandMutatesSession({ type: "get_state" })).toBe(false);
		expect(rpcCommandMutatesSession({ type: "get_messages" })).toBe(false);
		expect(rpcCommandMutatesSession({ type: "prompt", message: "mutate" })).toBe(true);
		expect(rpcCommandMutatesSession({ type: "abort" })).toBe(true);
	});

	test("defaults newly added commands to mutation-fenced", () => {
		const futureCommand = { type: "future_command" } as unknown as RpcCommand;
		expect(rpcCommandMutatesSession(futureCommand)).toBe(true);
	});

	test("lets a pending handoff abort the work it is waiting on", () => {
		// Control transfers at the next safe boundary, so fencing aborts would let a long turn
		// strand the handoff with no way for the RPC host to reach that boundary.
		expect(rpcCommandFencedDuringHandoff({ type: "abort" })).toBe(false);
		expect(rpcCommandFencedDuringHandoff({ type: "abort_bash" })).toBe(false);
		expect(rpcCommandFencedDuringHandoff({ type: "abort_retry" })).toBe(false);
	});

	test("still fences new work and observation stays free while a handoff is pending", () => {
		expect(rpcCommandFencedDuringHandoff({ type: "prompt", message: "mutate" })).toBe(true);
		expect(rpcCommandFencedDuringHandoff({ type: "abort_and_prompt", message: "mutate" })).toBe(true);
		expect(rpcCommandFencedDuringHandoff({ type: "get_state" })).toBe(false);
	});
});
