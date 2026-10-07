import { describe, expect, it } from "bun:test";
import { type Mode, parseArgs, validateTspLaunch } from "../src/cli/args";
import { applyExtensionFlags } from "../src/cli/extension-flags";
import { PROFILE_BOOTSTRAP_BOUNDARY_ARG } from "../src/cli/flag-tables";
import { extractProfileFlags } from "../src/cli/profile-bootstrap";
import { CliUsageError } from "../src/cli/usage-error";
import { prepareAcpTerminalAuthArgs } from "../src/modes/acp/terminal-auth";

describe("parseArgs — --tsp", () => {
	it("defaults the bare flag to inherited fd 3 without requiring a mode during parsing", () => {
		const args = parseArgs(["--tsp"]);
		expect(args.tsp).toBe(3);
		expect(args.mode).toBeUndefined();
		expect(args.messages).toEqual([]);
	});

	it("parses spaced and equals decimal descriptors", () => {
		for (const argv of [["--tsp", "4"], ["--tsp=4"], ["--tsp", "0004"], ["--tsp", "+4"]]) {
			expect(parseArgs(argv).tsp).toBe(4);
		}
		expect(parseArgs(["--tsp=2147483647"]).tsp).toBe(2147483647);
	});

	it("parses spaced and equals Unix socket paths including spaces and equals signs", () => {
		const socket = "/tmp/omp presentation=surface.sock";
		for (const argv of [["--tsp", socket], [`--tsp=${socket}`]]) {
			const args = parseArgs(argv);
			expect(args.tsp).toBe(socket);
			expect(args.messages).toEqual([]);
		}
	});

	it("treats non-decimal and noninteger targets as socket paths", () => {
		for (const target of ["3.5", "-tsp.sock"]) {
			expect(parseArgs([`--tsp=${target}`]).tsp).toBe(target);
			if (!target.startsWith("-")) expect(parseArgs(["--tsp", target]).tsp).toBe(target);
		}
	});

	it("rejects negative descriptors and descriptors reserved for ACP stdio and diagnostics", () => {
		for (const value of ["-1", "0", "1", "2"]) {
			const args = parseArgs([`--tsp=${value}`]);
			expect(() => validateTspLaunch(args, "acp")).toThrow("reserved");
		}
	});

	it("rejects oversized or nonrepresentable descriptors rather than reclassifying them as paths", () => {
		for (const value of ["2147483648", "9".repeat(400)]) {
			const args = parseArgs([`--tsp=${value}`]);
			expect(() => validateTspLaunch(args, "acp")).toThrow("file descriptor");
		}
	});

	it("rejects explicit empty spaced and equals targets", () => {
		for (const argv of [["--tsp", ""], ["--tsp="]]) {
			const args = parseArgs(argv);
			expect(() => validateTspLaunch(args, "acp")).toThrow("non-empty");
		}
	});

	it("does not swallow following flags or profile boundary markers", () => {
		const args = parseArgs(["--tsp", "--mode", "acp", "--no-tools"]);
		expect(args.tsp).toBe(3);
		expect(args.mode).toBe("acp");
		expect(args.noTools).toBe(true);
		const boundary = parseArgs(["--tsp", PROFILE_BOOTSTRAP_BOUNDARY_ARG, "prompt"]);
		expect(boundary.tsp).toBe(3);
		expect(boundary.messages).toEqual(["prompt"]);
	});

	it("shares value classification with profile extraction and subcommand routing", () => {
		for (const target of ["4", "/tmp/omp.sock"]) {
			const extracted = extractProfileFlags(["acp", "--tsp", target, "--profile", "work"]);
			expect(extracted.profile).toBe("work");
			expect(extracted.argv).toEqual(["acp", "--tsp", target]);
		}
		for (const profile of [["--profile", "work"], ["--profile=work"]]) {
			const extracted = extractProfileFlags(["--tsp", ...profile, "prompt"]);
			expect(extracted.profile).toBe("work");
			const args = parseArgs(extracted.argv);
			expect(args.tsp).toBe(3);
			expect(args.messages).toEqual(["prompt"]);
		}
	});

	it("preserves end-of-options and launches without the flag", () => {
		const plain = parseArgs(["--mode", "acp", "hello"]);
		expect(plain.tsp).toBeUndefined();
		expect(plain.messages).toEqual(["hello"]);
		const literal = parseArgs(["--", "--tsp", "4"]);
		expect(literal.tsp).toBeUndefined();
		expect(literal.messages).toEqual(["--tsp", "4"]);
		const bare = parseArgs(["--tsp", "--", "4"]);
		expect(bare.tsp).toBe(3);
		expect(bare.messages).toEqual(["4"]);
	});

	it("retains generic extension precedence outside ACP and does not mutate argv on reparsing", () => {
		const argv = ["--tsp=4"];
		expect(parseArgs(argv).tsp).toBe(4);
		expect(argv).toEqual(["--tsp=4"]);
		const extension = parseArgs(["--tsp", "prompt"], new Map([["tsp", { type: "boolean" }]]));
		expect(extension.tsp).toBeUndefined();
		expect(extension.unknownFlags.get("tsp")).toBe(true);
		expect(extension.messages).toEqual(["prompt"]);
	});

	it("lets a colliding extension own --tsp outside ACP, where it is not a transport flag", () => {
		const argv = ["--tsp=0", "prompt"];
		const preliminary = parseArgs(argv);
		expect(() => validateTspLaunch(preliminary, "json")).toThrow("requires ACP mode");
		let value: boolean | string | undefined;
		const resolved = applyExtensionFlags(
			{
				getFlags: () => new Map([["tsp", { type: "string" }]]),
				setFlagValue: (_name, next) => {
					value = next;
				},
			},
			argv,
		);
		expect(value).toBe("0");
		expect(resolved?.tsp).toBeUndefined();
		expect(resolved?.messages).toEqual(["prompt"]);
	});

	it("reserves ACP transport ownership before a preceding boolean extension flag is resolved", () => {
		const argv = ["--thinking", "--tsp=4", "--plan"];
		const initial = parseArgs(argv, undefined, { processMode: "acp" });
		expect(initial.tsp).toBe(4);
		const values = new Map<string, boolean | string>();
		const resolved = applyExtensionFlags(
			{
				getFlags: () =>
					new Map([
						["thinking", { type: "boolean" }],
						["plan", { type: "boolean" }],
						["tsp", { type: "string" }],
					]),
				setFlagValue: (name, value) => values.set(name, value),
			},
			argv,
			{ processMode: "acp" },
		);
		expect(resolved?.tsp).toBe(4);
		expect(resolved?.invalidFlagValues).toEqual([]);
		expect(values).toEqual(
			new Map([
				["thinking", true],
				["plan", true],
			]),
		);
		const generic = parseArgs(["--thinking", "--tsp=0", "--mode=acp"]);
		expect(() => validateTspLaunch(generic, "acp")).toThrow("reserved");
	});

	it("preserves explicit string literals and the positional separator in ACP", () => {
		const args = parseArgs(["--system-prompt=--tsp=4", "--", "--tsp=0"], undefined, { processMode: "acp" });
		expect(args.tsp).toBeUndefined();
		expect(args.systemPrompt).toBe("--tsp=4");
		expect(args.messages).toEqual(["--tsp=0"]);
	});
});

describe("validateTspLaunch", () => {
	it("rejects every non-ACP effective mode, even when parsed.mode says ACP", () => {
		const args = parseArgs(["--mode=acp", "--tsp"]);
		const modes: (Mode | undefined)[] = [undefined, "text", "json", "rpc", "rpc-ui"];
		for (const mode of modes) {
			expect(() => validateTspLaunch(args, mode)).toThrow(CliUsageError);
			expect(() => validateTspLaunch(args, mode)).toThrow("--tsp requires ACP mode");
		}
	});

	it("rejects TSP on the ACP terminal-auth interactive launch", () => {
		const prepared = prepareAcpTerminalAuthArgs(["--mode=acp", "--acp-terminal-auth", "--tsp"]);
		expect(prepared.terminalAuth).toBe(true);
		const args = parseArgs(prepared.args);
		expect(args.mode).toBeUndefined();
		expect(() => validateTspLaunch(args, args.mode)).toThrow(CliUsageError);
	});
});
