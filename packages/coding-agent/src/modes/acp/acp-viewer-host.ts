import { ImageBudget } from "@oh-my-pi/pi-tui/components/image";
import type { NativeBackend, NativeHost } from "@oh-my-pi/pi-tui/native/backend";
import { node } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeChild } from "@oh-my-pi/pi-tui/native/node";
import type { TspTransport } from "@oh-my-pi/pi-tui/native/transport";
import type { AgentHubHost } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import type { Component, OverlayHandle, OverlayOptions } from "@oh-my-pi/pi-tui/tui";

interface ViewerOverlay {
	component: Component;
	hidden: boolean;
}

/** One window's component tree and keyboard focus; it never adopts the shared transcript. */
export class AcpViewerHost implements NativeHost, AgentHubHost {
	readonly imageBudget: ImageBudget;
	lastFrameCostMs = 0;
	readonly surface: string;
	#root: Component | undefined;
	#focus: Component | null = null;
	#overlays: ViewerOverlay[] = [];
	#closed = false;
	#notice: string | undefined;

	constructor(
		readonly terminal: TspTransport,
		readonly backend: NativeBackend,
		readonly viewer: string,
		readonly renderRequest: () => void,
	) {
		this.imageBudget = new ImageBudget(0, () => this.requestRender());
		this.surface = backend.openViewer(viewer, this);
	}

	get closed(): boolean {
		return this.#closed;
	}

	mount(component: Component): void {
		this.#root = component;
		this.#focus = component;
		this.requestRender();
	}

	notice(message: string): void {
		if (this.#closed) return;
		this.#notice = message;
		this.requestRender();
	}

	describeSurface(): { main: readonly NativeChild[]; dock: readonly NativeChild[] } {
		const top = this.#overlays.findLast(entry => !entry.hidden)?.component ?? this.#root;
		return {
			main: top ? [top] : [],
			dock: this.#notice ? [node("text", { text: this.#notice, tone: "error", role: "omp.viewer.notice" })] : [],
		};
	}

	// The viewer's top page is inline, even when a terminal component requests fullscreen.
	overlays(): [] {
		return [];
	}
	focused(): Component | null {
		return this.#focus;
	}
	setFocus(component: Component | null): void {
		this.#focus = component;
		this.requestRender();
	}
	focusFromPointer(owners: readonly Component[], field: Component | null): void {
		this.#focus = field ?? owners[0] ?? this.#root ?? null;
	}

	showOverlay(component: Component, _options?: OverlayOptions): OverlayHandle {
		const entry: ViewerOverlay = { component, hidden: false };
		this.#overlays.push(entry);
		this.requestRender();
		return {
			hide: () => {
				const index = this.#overlays.indexOf(entry);
				if (index < 0) return;
				this.#overlays.splice(index, 1);
				this.#focus = this.#overlays.findLast(item => !item.hidden)?.component ?? this.#root ?? null;
				this.requestRender();
			},
			setHidden: hidden => {
				entry.hidden = hidden;
				this.requestRender();
			},
			isHidden: () => entry.hidden,
		};
	}

	requestRender(): void {
		if (!this.#closed) this.renderRequest();
	}
	requestComponentRender(_component: Component): void {
		this.requestRender();
	}
	resetDisplay(): void {
		this.invalidate();
		this.requestRender();
	}
	appearanceChanged(): void {
		this.resetDisplay();
	}
	motionChanged(): void {
		this.resetDisplay();
	}
	invalidate(): void {
		this.#root?.invalidate?.();
		for (const overlay of this.#overlays) overlay.component.invalidate?.();
	}

	dispose(): void {
		if (this.#closed) return;
		this.#closed = true;
		// The hub owns its nested transcript's timers and disposal.
		this.#root?.dispose?.();
		this.#root = undefined;
		this.#focus = null;
		this.#overlays = [];
		this.backend.closeViewerSurface(this.surface);
	}
}
