import type { Terminal, TerminalAppearance, TerminalAppearanceRequestToken } from "@oh-my-pi/pi-tui/terminal";

type InputHandler = (data: string) => void;
type ResizeHandler = () => void;
type DisconnectHandler = () => void;

/** Terminal implementation backed by one authenticated attach socket. */
export class AttachedSocketTerminal implements Terminal {
	#columns: number;
	#rows: number;
	#active = false;
	#inputHandler: InputHandler | undefined;
	#resizeHandler: ResizeHandler | undefined;
	#disconnectHandler: DisconnectHandler | undefined;
	#appearance: TerminalAppearance | undefined;
	readonly #writeOutput: (data: string) => void;

	constructor(columns: number, rows: number, writeOutput: (data: string) => void) {
		this.#columns = columns;
		this.#rows = rows;
		this.#writeOutput = writeOutput;
	}

	get columns(): number {
		return this.#columns;
	}

	get rows(): number {
		return this.#rows;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	get kittyEnableSequence(): string | null {
		return null;
	}

	get keyboardEnhancementEnterSequence(): string | null {
		return null;
	}

	get keyboardEnhancementExitSequence(): string | null {
		return null;
	}

	get appearance(): TerminalAppearance | undefined {
		return this.#appearance;
	}

	start(onInput: InputHandler, onResize: ResizeHandler, onDisconnect?: DisconnectHandler): void {
		this.#active = true;
		this.#inputHandler = onInput;
		this.#resizeHandler = onResize;
		this.#disconnectHandler = onDisconnect;
	}

	stop(): void {
		this.#active = false;
		this.#inputHandler = undefined;
		this.#resizeHandler = undefined;
		this.#disconnectHandler = undefined;
	}

	drainInput(): Promise<void> {
		return Promise.resolve();
	}

	write(data: string): void {
		if (this.#active) this.#writeOutput(data);
	}

	input(data: string): void {
		if (this.#active) this.#inputHandler?.(data);
	}

	resize(columns: number, rows: number): void {
		this.#columns = columns;
		this.#rows = rows;
		if (this.#active) this.#resizeHandler?.();
	}

	disconnect(): void {
		if (this.#active) this.#disconnectHandler?.();
	}

	moveBy(lines: number): void {
		if (lines < 0) this.write(`\x1b[${-lines}A`);
		else if (lines > 0) this.write(`\x1b[${lines}B`);
	}

	hideCursor(): void {
		this.write("\x1b[?25l");
	}

	showCursor(): void {
		this.write("\x1b[?25h");
	}

	clearLine(): void {
		this.write("\x1b[2K\r");
	}

	clearFromCursor(): void {
		this.write("\x1b[J");
	}

	clearScreen(): void {
		this.write("\x1b[2J\x1b[H");
	}

	setTitle(title: string): void {
		this.write(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		this.write(active ? "\x1b]9;4;3\x07" : "\x1b]9;4;0;\x07");
	}

	onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void {
		if (this.#appearance) callback(this.#appearance);
	}

	onAppearanceReport(
		_callback: (appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void,
	): () => void {
		return () => {};
	}

	refreshAppearance(_requestToken?: TerminalAppearanceRequestToken): void {}

	onPrivateModeReport(_callback: (mode: number, supported: boolean, confirmed?: boolean) => void): void {}
}

/** Stable terminal object whose active frontend can change without rebuilding the TUI. */
export class SwitchableTerminal implements Terminal {
	readonly #local: Terminal | undefined;
	#active: Terminal | undefined;
	#started = false;
	#inputHandler: InputHandler = () => {};
	#resizeHandler: ResizeHandler = () => {};
	#disconnectHandler: DisconnectHandler | undefined;
	#localInputFenced = false;
	#requestRedraw: (() => void) | undefined;
	#appearanceCallbacks: Array<(appearance: TerminalAppearance, token?: TerminalAppearanceRequestToken) => void> = [];
	#appearanceReportCallbacks: Array<(appearance: TerminalAppearance, token?: TerminalAppearanceRequestToken) => void> =
		[];
	#privateModeCallbacks: Array<(mode: number, supported: boolean, confirmed?: boolean) => void> = [];

	constructor(local?: Terminal) {
		this.#local = local;
		this.#active = local;
	}

	get localAvailable(): boolean {
		return this.#local !== undefined;
	}

	get usingLocal(): boolean {
		return this.#active === this.#local && this.#local !== undefined;
	}

	get columns(): number {
		return this.#active?.columns ?? 80;
	}

	get rows(): number {
		return this.#active?.rows ?? 24;
	}

	get kittyProtocolActive(): boolean {
		return this.#active?.kittyProtocolActive ?? false;
	}

	get kittyEnableSequence(): string | null {
		return this.#active?.kittyEnableSequence ?? null;
	}

	get keyboardEnhancementEnterSequence(): string | null {
		return this.#active?.keyboardEnhancementEnterSequence ?? null;
	}

	get keyboardEnhancementExitSequence(): string | null {
		return this.#active?.keyboardEnhancementExitSequence ?? null;
	}

	get appearance(): TerminalAppearance | undefined {
		return this.#active?.appearance;
	}

	setRedrawRequester(requestRedraw: () => void): void {
		this.#requestRedraw = requestRedraw;
	}

	start(onInput: InputHandler, onResize: ResizeHandler, onDisconnect?: DisconnectHandler): void {
		this.#started = true;
		this.#inputHandler = onInput;
		this.#resizeHandler = onResize;
		this.#disconnectHandler = onDisconnect;
		this.#startActive();
	}

	stop(): void {
		this.#started = false;
		this.#active?.stop();
	}

	drainInput(maxMs?: number, idleMs?: number): Promise<void> {
		return this.#active?.drainInput(maxMs, idleMs) ?? Promise.resolve();
	}

	write(data: string): void {
		this.#active?.write(data);
	}

	parkLocal(message: string): void {
		if (this.#local && this.#active === this.#local) {
			this.#local.write(`\r\n${message}\r\n`);
			this.#local.stop();
			this.#active = undefined;
		}
	}

	fenceLocal(message: string): void {
		if (!this.#local || this.#active !== this.#local) return;
		this.#localInputFenced = true;
		this.#local.write(`\r\n${message}\r\n`);
	}

	unfenceLocal(): void {
		this.#localInputFenced = false;
	}

	activateAttached(terminal: AttachedSocketTerminal): void {
		this.#active?.stop();
		this.#active = terminal;
		this.#startActive();
		this.#resizeHandler();
		this.#requestRedraw?.();
	}

	clearAttached(terminal: AttachedSocketTerminal): void {
		if (this.#active !== terminal) return;
		terminal.stop();
		this.#active = undefined;
	}

	resumeLocal(message: string): void {
		if (!this.#local || this.#active === this.#local) return;
		this.#active?.stop();
		this.#active = this.#local;
		this.#localInputFenced = false;
		this.#startActive();
		this.#local.write(`\r\n${message}\r\n`);
		this.#resizeHandler();
		this.#requestRedraw?.();
	}

	#startActive(): void {
		if (!this.#started || !this.#active) return;
		this.#active.start(
			data => {
				if (this.#active !== this.#local || !this.#localInputFenced) this.#inputHandler(data);
			},
			this.#resizeHandler,
			this.#disconnectHandler,
		);
		for (const callback of this.#appearanceCallbacks) this.#active.onAppearanceChange(callback);
		for (const callback of this.#appearanceReportCallbacks) this.#active.onAppearanceReport?.(callback);
		for (const callback of this.#privateModeCallbacks) this.#active.onPrivateModeReport?.(callback);
	}

	moveBy(lines: number): void {
		this.#active?.moveBy(lines);
	}

	hideCursor(force?: boolean): void {
		this.#active?.hideCursor(force);
	}

	showCursor(force?: boolean): void {
		this.#active?.showCursor(force);
	}

	clearLine(): void {
		this.#active?.clearLine();
	}

	clearFromCursor(): void {
		this.#active?.clearFromCursor();
	}

	clearScreen(): void {
		this.#active?.clearScreen();
	}

	setTitle(title: string): void {
		this.#active?.setTitle(title);
	}

	setProgress(active: boolean): void {
		this.#active?.setProgress(active);
	}

	onAppearanceChange(
		callback: (appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void,
	): void {
		this.#appearanceCallbacks.push(callback);
		this.#active?.onAppearanceChange(callback);
	}

	onAppearanceReport(
		callback: (appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void,
	): () => void {
		this.#appearanceReportCallbacks.push(callback);
		const cleanup = this.#active?.onAppearanceReport?.(callback);
		return () => {
			cleanup?.();
			const index = this.#appearanceReportCallbacks.indexOf(callback);
			if (index >= 0) this.#appearanceReportCallbacks.splice(index, 1);
		};
	}

	refreshAppearance(requestToken?: TerminalAppearanceRequestToken): TerminalAppearanceRequestToken | void {
		return this.#active?.refreshAppearance?.(requestToken);
	}

	onPrivateModeReport(callback: (mode: number, supported: boolean, confirmed?: boolean) => void): void {
		this.#privateModeCallbacks.push(callback);
		this.#active?.onPrivateModeReport?.(callback);
	}
}
