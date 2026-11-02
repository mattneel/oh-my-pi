import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { NativeBackend, type NativeHost } from "../../src/native/backend";
import { node } from "../../src/native/describe";
import { encodeTspJson, splitTspMessage, TspReader, type TspHello } from "../../src/native/encode";
import type { NativeNode, NativeUiEvent } from "../../src/native/node";
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
	backend = new NativeBackend(makeHost(shared), hello, { scheduler });
	backend.start();
	const event = (value: TspEvent) => backend!.handleInput(encodeTspJson("e", value));
	const frames = () => writes.filter(write => write.verb === "f").map(write => write.body as unknown as TspFrame);
	return { backend, shared, makeHost, writes, frames, event, left, scheduler, renderRequests };
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
});
