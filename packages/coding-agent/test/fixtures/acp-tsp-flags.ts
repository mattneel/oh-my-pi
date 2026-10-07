import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

export default function (pi: ExtensionAPI): void {
	pi.registerFlag("tsp", { type: "string", default: "extension-default" });
	pi.registerFlag("plan", { type: "boolean", default: false });
	pi.registerFlag("thinking", { type: "boolean", default: false });
	pi.registerCommand("flag-ownership", {
		description: "Report the extension's ACP CLI flag values",
		handler: async () => {
			pi.sendMessage(
				{
					customType: "flag-ownership",
					content: `Extension flags: tsp=${pi.getFlag("tsp")}; plan=${pi.getFlag("plan")}; thinking=${pi.getFlag("thinking")}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		},
	});
}
