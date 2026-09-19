import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getGlobalDaemonRuntimeDir, isEnoent } from "@oh-my-pi/pi-utils";
import type { AttachStatusSnapshot } from "./protocol";

const REGISTRY_SERVICE = "attach-v1";

export interface LiveSessionMetadata {
	schemaVersion: 1;
	hostId: string;
	sessionId: string;
	project: string;
	hostMode: "interactive" | "rpc" | "rpc-ui";
	pid: number;
	endpoint: string;
	startedAt: number;
	updatedAt: number;
}

export interface LiveSessionRecord {
	metadata: LiveSessionMetadata;
	token: string;
	snapshot?: AttachStatusSnapshot;
}

export function attachRegistryRoot(): string {
	return getGlobalDaemonRuntimeDir(REGISTRY_SERVICE);
}

export function attachHostDir(hostId: string): string {
	return path.join(attachRegistryRoot(), "hosts", hostId);
}

export function attachEndpoint(hostId: string): string {
	if (process.platform === "win32") return `\\\\.\\pipe\\omp-attach-${hostId}`;
	return path.join(attachHostDir(hostId), "host.sock");
}

export async function publishLiveSession(metadata: LiveSessionMetadata, token: string): Promise<void> {
	const hostDir = attachHostDir(metadata.hostId);
	await fs.mkdir(hostDir, { recursive: true, mode: 0o700 });
	await fs.chmod(hostDir, 0o700);
	await Bun.write(path.join(hostDir, "auth.token"), token);
	await fs.chmod(path.join(hostDir, "auth.token"), 0o600);
	await Bun.write(path.join(hostDir, "metadata.json"), `${JSON.stringify(metadata)}\n`);
	await fs.chmod(path.join(hostDir, "metadata.json"), 0o600);
}

export async function removeLiveSession(hostId: string): Promise<void> {
	await fs.rm(attachHostDir(hostId), { recursive: true, force: true });
}

function isMetadata(value: unknown): value is LiveSessionMetadata {
	if (typeof value !== "object" || value === null) return false;
	return (
		"schemaVersion" in value &&
		value.schemaVersion === 1 &&
		"hostId" in value &&
		typeof value.hostId === "string" &&
		"sessionId" in value &&
		typeof value.sessionId === "string" &&
		"project" in value &&
		typeof value.project === "string" &&
		"hostMode" in value &&
		(value.hostMode === "interactive" || value.hostMode === "rpc" || value.hostMode === "rpc-ui") &&
		"pid" in value &&
		typeof value.pid === "number" &&
		"endpoint" in value &&
		typeof value.endpoint === "string" &&
		"startedAt" in value &&
		typeof value.startedAt === "number" &&
		"updatedAt" in value &&
		typeof value.updatedAt === "number"
	);
}

export async function readLiveSessionRecords(): Promise<LiveSessionRecord[]> {
	const hostsDir = path.join(attachRegistryRoot(), "hosts");
	let entries: Dirent[];
	try {
		entries = await fs.readdir(hostsDir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const uid = process.getuid?.();
	const records = await Promise.all(
		entries
			.filter(entry => entry.isDirectory())
			.map(async entry => {
				const hostDir = path.join(hostsDir, entry.name);
				try {
					const stat = await fs.stat(hostDir);
					if (uid !== undefined && stat.uid !== uid) return null;
					const metadataValue: unknown = await Bun.file(path.join(hostDir, "metadata.json")).json();
					if (!isMetadata(metadataValue) || metadataValue.hostId !== entry.name) return null;
					const token = (await Bun.file(path.join(hostDir, "auth.token")).text()).trim();
					if (!token) return null;
					return { metadata: metadataValue, token } satisfies LiveSessionRecord;
				} catch {
					return null;
				}
			}),
	);
	return records.filter((record): record is LiveSessionRecord => record !== null);
}
