import type { RpcCommand, RpcCommandType } from "./rpc-types";

const READ_ONLY_COMMANDS: ReadonlySet<RpcCommandType> = new Set([
	"negotiate_protocol",
	"get_state",
	"get_available_commands",
	"get_subagents",
	"get_subagent_messages",
	"get_available_models",
	"get_session_stats",
	"get_branch_messages",
	"get_last_assistant_text",
	"get_messages",
	"get_messages_page",
	"get_login_providers",
	"set_subagent_subscription",
]);

/**
 * Aborts are the one mutation a pending handoff must not fence. Control transfers at the next safe
 * boundary, so fencing the commands that *reach* that boundary would let a long-running turn strand
 * the handoff with no way for the RPC host to shorten it. `abort_and_prompt` is excluded because it
 * also queues new work.
 */
const HANDOFF_PERMITTED_COMMANDS: ReadonlySet<RpcCommandType> = new Set(["abort", "abort_bash", "abort_retry"]);

export function rpcCommandMutatesSession(command: RpcCommand): boolean {
	return !READ_ONLY_COMMANDS.has(command.type);
}

/** Fencing predicate while control is still held locally and a handoff is only pending. */
export function rpcCommandFencedDuringHandoff(command: RpcCommand): boolean {
	return rpcCommandMutatesSession(command) && !HANDOFF_PERMITTED_COMMANDS.has(command.type);
}
