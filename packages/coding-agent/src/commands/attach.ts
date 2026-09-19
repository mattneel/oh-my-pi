import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runAttachCommand } from "../attach/client";
import { attachHelp as commandHelp } from "../cli/command-help";

export default class Attach extends Command {
	static description = commandHelp.description;
	static args = {
		session: Args.string({ description: "Live session id or unambiguous prefix", required: false }),
	};
	static flags = {
		list: Flags.boolean({ char: "l", description: "List live sessions without attaching" }),
		all: Flags.boolean({ char: "a", description: "Include live sessions from all projects" }),
		json: Flags.boolean({ description: "Emit the versioned machine-readable list" }),
		force: Flags.boolean({ char: "f", description: "Take over the current terminal controller" }),
		yes: Flags.boolean({ char: "y", description: "Confirm --force non-interactively" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Attach);
		try {
			process.exitCode = await runAttachCommand({ target: args.session, ...flags });
		} catch (error) {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 2;
		}
	}
}
