import { isRecord } from "@oh-my-pi/pi-utils";

export const ATTACH_PROTOCOL_VERSION = 1;
export const ATTACH_MAX_FRAME_BYTES = 1024 * 1024;
export const ATTACH_OUTPUT_CHUNK_BYTES = 64 * 1024;
export const ATTACH_OUTPUT_BACKLOG_BYTES = 64 * 1024 * 1024;
export const ATTACH_RECONNECT_GRACE_MS = 30_000;
export const ATTACH_FORCE_TIMEOUT_MS = 30_000;

export type AttachAction = "attach" | "force" | "reconnect" | "status";

export interface AttachHelloFrame {
	type: "hello";
	protocolVersion: 1;
	action: AttachAction;
	sessionId: string;
	token: string;
	rows?: number;
	columns?: number;
	attachmentId?: string;
	resumeToken?: string;
	expectedEpoch?: number;
}

export type AttachClientFrame =
	| AttachHelloFrame
	| { type: "input"; epoch: number; sequence: number; data: string }
	| { type: "resize"; epoch: number; sequence: number; rows: number; columns: number }
	| { type: "output_ack"; sequence: number }
	| { type: "heartbeat"; sequence: number }
	| { type: "detach"; sequence: number }
	| { type: "revocation_rendered"; attachmentId: string };

export interface AttachControllerSnapshot {
	label: string;
	state: "connected" | "reconnecting" | "revocation_pending";
	ageMs: number;
}

export interface AttachStatusSnapshot {
	sessionId: string;
	project: string;
	hostMode: "interactive" | "rpc" | "rpc-ui";
	activity: "idle" | "turn_running";
	controlState: "available" | "control_pending" | "controlled" | "reconnecting";
	controller: AttachControllerSnapshot | null;
	epoch: number;
	updatedAt: number;
}

export type AttachServerFrame =
	| { type: "status"; snapshot: AttachStatusSnapshot }
	| {
			type: "accepted";
			attachmentId: string;
			resumeToken: string;
			state: "watching" | "control_pending" | "control";
			epoch?: number;
			reconnectDeadlineMs: number;
	  }
	| { type: "control"; epoch: number }
	| { type: "output"; sequence: number; data: string }
	| { type: "revoked"; message: string }
	| { type: "detached"; message: string }
	| { type: "heartbeat"; reconnectDeadlineMs: number }
	| { type: "error"; reason: string; message: string; retryable: boolean };

export function encodeAttachFrame(frame: AttachClientFrame | AttachServerFrame): string {
	return `${JSON.stringify(frame)}\n`;
}

export function decodeAttachFrame(line: string): AttachClientFrame {
	if (Buffer.byteLength(line, "utf8") > ATTACH_MAX_FRAME_BYTES) {
		throw new Error("attach frame exceeds the 1 MiB limit");
	}
	const value: unknown = JSON.parse(line);
	if (!isRecord(value) || typeof value.type !== "string") throw new Error("invalid attach frame");
	return value as AttachClientFrame;
}
