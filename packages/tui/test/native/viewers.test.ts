import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { NativeBackend, type NativeHost } from "../../src/native/backend";
import { node } from "../../src/native/describe";
import { encodeTspJson, splitTspMessage, TspReader, type TspHello } from "../../src/native/encode";
import type { NativeCommandEvent, NativeNode, NativeUiEvent } from "../../src/native/node";
import { nativeComponentId } from "../../src/native/reconcile";
import { initTheme } from "../../src/theme/theme";
import type { Component } from "../../src/tui";
import { TSP_KINDS, type TspEvent, type TspFrame } from "@oh-my-pi/pi-wire";
import { ManualScheduler } from "./tsp-harness";

class ViewerProbe implements Component {
	text = "initial";
	keys: string[] = [];
	events: NativeUiEvent[] = [];
	render(): readonly string[] {
		return [];
	}
	describe(): NativeNode {
		return node("editor", { text: this.text, sendable: true });
	}
	handleInput(data: string): void {
		this.keys.push(data);
	}
	handleNativeEvent(event: NativeUiEvent): void {
		this.events.push(event);
	}
}

let backend: NativeBackend | undefined;
beforeAll(async () => {
	await initTheme(false);
});
afterEach(() => {
	backend?.stop(false);
	backend = undefined;
});

function fixture(features: string[] = ["viewers", "keys"], credits = 10) {
	const writes: { verb: string; body: Record<string, unknown> }[] = [];
	const scheduler = new ManualScheduler();
	const renderRequests: number[] = [];
	const terminal = {
		columns: 100,
		appearance: undefined,
		write(sequence: string) {
			const raw = splitTspMessage(sequence);
			if (raw) writes.push({ verb: raw.verb, body: JSON.parse(raw.body) });
		},
	};
	const left: string[] = [];
	const makeHost = (probe: ViewerProbe): NativeHost => ({
		terminal,
		describeSurface: () => ({ main: [probe], dock: [] }),
		overlays: () => [],
		focused: () => probe,
		focusFromPointer() {},
		requestRender() {
			renderRequests.push(scheduler.now());
		},
		appearanceChanged() {},
		motionChanged() {},
		invalidate() {},
		viewerLeft(viewer) {
			left.push(viewer);
		},
	});
	const shared = new ViewerProbe();
	const hello: TspHello = { r: "hello", v: 1, term: "test", kinds: TSP_KINDS, features, credits };
	const host = makeHost(shared);
	backend = new NativeBackend(host, hello, { scheduler });
	backend.start();
	const event = (value: TspEvent) => backend!.handleInput(encodeTspJson("e", value));
	const frames = () => writes.filter(write => write.verb === "f").map(write => write.body as unknown as TspFrame);
	return { backend, host, hello, shared, makeHost, writes, frames, event, left, scheduler, renderRequests };
}

describe("viewer-scoped native surfaces", () => {
	it("negotiates viewer surfaces and separately gates key transport", () => {
		const f = fixture([]);
		expect(() => f.backend.openViewer("a", f.makeHost(new ViewerProbe()))).toThrow("viewer-capable");
		f.backend.stop(false);
		const g = fixture(["viewers"]);
		const probe = new ViewerProbe();
		const sf = g.backend.openViewer("a", g.makeHost(probe));
		g.backend.render();
		g.event({ ev: "key", sf, viewer: "a", data: "query" });
		expect(probe.keys).toEqual([]);
	});

	it("isolates events, keys, state and departure, rejecting stale and foreign surfaces", () => {
		const f = fixture();
		const a = new ViewerProbe();
		const b = new ViewerProbe();
		const sa = f.backend.openViewer("a", f.makeHost(a));
		const sb = f.backend.openViewer("b", f.makeHost(b));
		f.backend.render();
		expect(f.writes.filter(write => write.verb === "o").map(write => write.body)).toContainEqual({
			id: sa,
			mode: "inline",
			title: "omp",
			role: "omp.viewer",
			viewer: "a",
		});
		f.event({ ev: "key", sf: sa, viewer: "b", data: "foreign" });
		f.event({ ev: "key", sf: sa, viewer: "a", data: "🙂".repeat(1025) });
		f.event({ ev: "key", sf: sa, viewer: "a", data: "search" });
		f.event({ ev: "key", sf: sb, viewer: "b", data: "other" });
		f.event({ ev: "key", sf: "s:1", viewer: "a", data: "not a viewer" });
		const id = nativeComponentId(a);
		f.event({ ev: "send", sf: sa, viewer: "b", id, text: "foreign" });
		f.event({ ev: "send", sf: sa, viewer: "a", id, text: "valid" });
		f.event({
			ev: "action",
			sf: sa,
			viewer: "a",
			id,
			act: "submit",
			item: "q0",
			value: { q0: ["one", "two"] },
			values: { custom: "text" },
		});
		expect(a.keys).toEqual(["search"]);
		expect(b.keys).toEqual(["other"]);
		expect(f.shared.keys).toEqual([]);
		expect(a.events).toEqual([
			{ type: "send", key: "", text: "valid", viewer: "a" },
			{
				type: "action",
				key: "",
				viewer: "a",
				act: "submit",
				item: "q0",
				value: { q0: ["one", "two"] },
				values: { custom: "text" },
				mods: [],
			},
		]);
		f.event({ ev: "viewer", viewer: "a", present: false });
		f.event({ ev: "key", sf: sa, viewer: "a", data: "stale" });
		expect(a.keys).toEqual(["search"]);
		expect(f.left).toEqual(["a"]);
		expect(f.writes).toContainEqual({ verb: "x", body: { id: sa, keep: false } });
		expect(f.writes).not.toContainEqual({ verb: "x", body: { id: sb, keep: false } });
	});

	it("keeps each document's credits independent while shared streaming continues", () => {
		const f = fixture(["viewers", "keys"], 1);
		const a = new ViewerProbe();
		const b = new ViewerProbe();
		const sa = f.backend.openViewer("a", f.makeHost(a));
		const sb = f.backend.openViewer("b", f.makeHost(b));
		f.backend.render();
		a.text = "blocked a";
		b.text = "ready b";
		f.shared.text = "shared stream";
		f.event({ ev: "ack", sf: "s:1", s: 1 });
		f.event({ ev: "ack", sf: sb, s: 1 });
		const count = f.frames().length;
		f.backend.render();
		const changed = f.frames().slice(count);
		expect(changed.map(frame => frame.sf)).toEqual(["s:1", sb]);
		f.event({ ev: "ack", sf: sa, s: 1 });
		f.backend.render();
		expect(f.frames().at(-1)?.sf).toBe(sa);
	});

	it("does not let another surface's ACK cancel a stalled viewer's render timer", () => {
		const f = fixture(["viewers", "keys"], 1);
		const a = new ViewerProbe();
		const b = new ViewerProbe();
		const sa = f.backend.openViewer("a", f.makeHost(a));
		const sb = f.backend.openViewer("b", f.makeHost(b));
		f.backend.render();
		a.text = "waiting for credits";
		f.backend.render();
		f.event({ ev: "ack", sf: sa, s: 1, viewer: "b" });
		f.event({ ev: "ack", sf: sb, s: 1 });
		const requests = f.renderRequests.length;
		f.scheduler.flush(5000);
		expect(f.renderRequests.length).toBeGreaterThan(requests);
		f.backend.render();
		expect(
			f
				.frames()
				.filter(frame => frame.sf === sa)
				.at(-1)?.s,
		).toBe(2);
	});

	it("preserves viewer and structured fields in send and action decoding", () => {
		const reader = new TspReader();
		const value = { ev: "send" as const, sf: "v.a.1", id: "input", viewer: "a", text: "hello", extra: 1 };
		expect(reader.feed(encodeTspJson("e", value))).toEqual({ verb: "e", event: value });
		expect(reader.feed(encodeTspJson("e", { ev: "key", sf: "v.a.1", viewer: 7, data: "bad" }))).toBeNull();
	});

	it("opens command screens for the requesting viewer without replacing the shared transcript", async () => {
		const f = fixture();
		const received: NativeCommandEvent[] = [];
		f.host.handleCommand = event => {
			received.push(event);
			return f.backend.openViewer(event.viewer, f.makeHost(new ViewerProbe()));
		};
		const original = f.writes.find(write => write.verb === "o")!.body.id;
		if (typeof original !== "string") throw new Error("Shared surface did not open");
		for (const sf of [undefined, "", original]) {
			f.event({ ev: "command", name: "models", args: "role", viewer: "a", sf, id: "" });
		}
		await Promise.resolve();
		expect(received.map(event => event.sf)).toEqual([original, original, original]);
		const replies = f.writes.filter(write => write.verb === "r");
		expect(replies.map(write => write.body)).toEqual(
			f.writes
				.filter(write => write.verb === "o" && write.body.viewer === "a")
				.map(write => ({
					r: "command",
					name: "models",
					viewer: "a",
					id: "",
					ok: true,
					sf: write.body.id,
				})),
		);
		expect(replies).toHaveLength(3);
		expect(f.writes.filter(write => write.verb === "x")).toEqual([]);
		expect(f.shared.events).toEqual([]);
	});

	it("resolves an empty command surface to the active shared fullscreen document", async () => {
		const f = fixture();
		const page = new ViewerProbe();
		f.host.overlays = () => [{ component: page, options: { fullscreen: true }, focused: true }];
		f.backend.render();
		const active = f.writes.find(write => write.verb === "o" && write.body.mode === "screen")!.body.id;
		if (typeof active !== "string") throw new Error("Shared fullscreen surface did not open");
		const received: NativeCommandEvent[] = [];
		f.host.handleCommand = event => {
			received.push(event);
			return f.backend.openViewer(event.viewer, f.makeHost(new ViewerProbe()));
		};
		f.event({ ev: "command", name: "status", args: "", viewer: "a", sf: "" });
		await Promise.resolve();
		expect(received).toEqual([{ ev: "command", name: "status", args: "", viewer: "a", sf: active }]);
		expect(f.writes.filter(write => write.verb === "r").map(write => write.body.ok)).toEqual([true]);
	});

	it("allows an owned command context and refuses foreign or stale surfaces with correlated errors", async () => {
		const f = fixture();
		const owned = f.backend.openViewer("a", f.makeHost(new ViewerProbe()));
		const received: NativeCommandEvent[] = [];
		f.host.handleCommand = async event => {
			received.push(event);
			return f.backend.openViewer(event.viewer, f.makeHost(new ViewerProbe()));
		};
		f.event({ ev: "command", name: "status", args: "", viewer: "a", sf: owned, id: "owned" });
		f.event({ ev: "command", name: "models", args: "", viewer: "b", sf: owned, id: "foreign" });
		f.event({ ev: "command", name: "jobs", args: "", viewer: "a", sf: "missing", id: "stale" });
		await Promise.resolve();
		expect(received).toEqual([{ ev: "command", name: "status", args: "", viewer: "a", sf: owned, id: "owned" }]);
		const replies = f.writes.filter(write => write.verb === "r").map(write => write.body);
		const opened = f.writes.filter(write => write.verb === "o").at(-1)!.body.id;
		expect(replies).toContainEqual({
			r: "command",
			name: "status",
			viewer: "a",
			id: "owned",
			ok: true,
			sf: opened,
		});
		expect(replies).toContainEqual({
			r: "command",
			name: "models",
			viewer: "b",
			id: "foreign",
			ok: false,
			error: expect.stringContaining("models"),
		});
		expect(replies).toContainEqual({
			r: "command",
			name: "jobs",
			viewer: "a",
			id: "stale",
			ok: false,
			error: expect.stringContaining("jobs"),
		});
	});

	it("reports absent handlers, synchronous refusals, rejected handlers and invalid output surfaces", async () => {
		const f = fixture();
		f.event({ ev: "command", name: "missing", args: "", viewer: "a" });
		f.host.handleCommand = () => {
			throw new Error("not available");
		};
		f.event({ ev: "command", name: "refused", args: "", viewer: "a" });
		f.host.handleCommand = async () => {
			throw new Error("blocked");
		};
		f.event({ ev: "command", name: "rejected", args: "", viewer: "a" });
		const foreign = f.backend.openViewer("b", f.makeHost(new ViewerProbe()));
		f.host.handleCommand = () => foreign;
		f.event({ ev: "command", name: "foreign-result", args: "", viewer: "a" });
		await Promise.resolve();
		const replies = f.writes.filter(write => write.verb === "r").map(write => write.body);
		expect(replies).toHaveLength(4);
		for (const name of ["missing", "refused", "rejected", "foreign-result"]) {
			expect(replies).toContainEqual({
				r: "command",
				name,
				viewer: "a",
				ok: false,
				error: expect.stringContaining(name),
			});
		}
		expect(replies.find(reply => reply.name === "rejected")!.error).toContain("blocked");
	});

	it("does not dispatch or reply to commands from ordinary Tern peers", async () => {
		const f = fixture([]);
		const received: NativeCommandEvent[] = [];
		f.host.handleCommand = event => {
			received.push(event);
			return "unused";
		};
		f.event({ ev: "command", name: "models", args: "", viewer: "a" });
		await Promise.resolve();
		expect(received).toEqual([]);
		expect(f.writes.filter(write => write.verb === "r")).toEqual([]);
	});

	it("drops both successful and rejected pending commands after stop, including a later resume", async () => {
		const f = fixture();
		const success = Promise.withResolvers<string>();
		const failure = Promise.withResolvers<string>();
		f.host.handleCommand = event => (event.name === "models" ? success.promise : failure.promise);
		f.event({ ev: "command", name: "models", args: "", viewer: "a", id: "late-success" });
		f.event({ ev: "command", name: "status", args: "", viewer: "a", id: "late-error" });
		f.backend.stop(false);
		f.backend.resume(f.hello);
		success.resolve("stale-surface");
		failure.reject(new Error("closed"));
		await Promise.resolve();
		await Promise.resolve();
		expect(f.writes.filter(write => write.verb === "r")).toEqual([]);
	});
});
