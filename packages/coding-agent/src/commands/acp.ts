/**
 * Run omp as an ACP (Agent Client Protocol) server over stdio.
 *
 * Thin wrapper around the launch flow that forces `mode: "acp"` unless the
 * ACP terminal-auth flag asks the same command to open the interactive TUI.
 */

import { Command } from "@oh-my-pi/pi-utils/cli";
import { type Args as ParsedArgs, parseArgs, reportCliUsageError } from "../cli/args";
import { acpHelp as commandHelp } from "../cli/command-help";
import { runRootCommand } from "../main";
import { prepareAcpTerminalAuthArgs } from "../modes/acp/terminal-auth";

export default class Acp extends Command {
	static description = commandHelp.description;
	static flags = commandHelp.flags;
	static strict = false;

	async run(): Promise<void> {
		const { args, terminalAuth } = prepareAcpTerminalAuthArgs(this.argv);
		let parsed: ParsedArgs;
		try {
			parsed = parseArgs(args, undefined, { processMode: terminalAuth ? undefined : "acp" });
		} catch (error) {
			if (reportCliUsageError(error)) {
				process.exitCode = 2;
				return;
			}
			throw error;
		}
		if (!terminalAuth) {
			parsed.mode = "acp";
		}
		try {
			await runRootCommand(parsed, args);
		} catch (error) {
			if (reportCliUsageError(error)) process.exit(2);
			throw error;
		}
	}
}
