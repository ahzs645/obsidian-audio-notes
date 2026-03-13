import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { Platform } from "obsidian";
import { promisify } from "util";
import { fileURLToPath, pathToFileURL } from "url";
import type { AudioNotesSettings } from "./AudioNotesSettings";

const execFileAsync = promisify(execFile);
const GOOGLE_DRIVE_ARCHIVE_KIND = "google-drive";

export interface GoogleDriveArchiveReference {
	recordingArchive: typeof GOOGLE_DRIVE_ARCHIVE_KIND;
	recordingDrivePath: string;
	recordingUrl?: string;
	localAudioPath?: string;
}

export function isDesktopEnvironment(): boolean {
	return Platform.isDesktop || Platform.isDesktopApp || Platform.isMacOS;
}

export function isGoogleDriveArchiveEnabled(
	settings: AudioNotesSettings
): boolean {
	return (
		isDesktopEnvironment() &&
		Boolean(settings.googleDriveAudioArchiveEnabled) &&
		Boolean(getGoogleDriveArchiveRoot(settings))
	);
}

export function getGoogleDriveArchiveRoot(
	settings: AudioNotesSettings
): string {
	return (settings.googleDriveAudioArchiveRoot || "").trim();
}

export function normalizeArchiveRelativePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

export function isAbsoluteFilesystemPath(value: string): boolean {
	if (!value) return false;
	return (
		value.startsWith("/") ||
		/^[A-Za-z]:[\\/]/.test(value) ||
		value.startsWith("file://")
	);
}

export function toAbsoluteFilesystemPath(value: string): string {
	if (value.startsWith("file://")) {
		return fileURLToPath(value);
	}
	return value;
}

export function toAudioSrcUrl(value: string): string {
	if (!value) return value;
	if (value.startsWith("file://")) {
		return value;
	}
	return pathToFileURL(toAbsoluteFilesystemPath(value)).toString();
}

export function resolveGoogleDriveRecordingLocalPath(
	settings: AudioNotesSettings,
	recordingDrivePath: string | null | undefined
): string | null {
	if (!recordingDrivePath) return null;
	const root = getGoogleDriveArchiveRoot(settings);
	if (!root) return null;
	const relative = normalizeArchiveRelativePath(recordingDrivePath);
	if (!relative) return null;
	return path.join(root, ...relative.split("/"));
}

export async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await fs.access(targetPath);
		return true;
	} catch {
		return false;
	}
}

export async function ensureFilesystemFolder(targetPath: string): Promise<void> {
	await fs.mkdir(targetPath, { recursive: true });
}

export async function getAvailableFilesystemPath(
	folder: string,
	filename: string
): Promise<string> {
	const dotIndex = filename.lastIndexOf(".");
	const base = dotIndex === -1 ? filename : filename.slice(0, dotIndex);
	const extension = dotIndex === -1 ? "" : filename.slice(dotIndex);
	let candidate = path.join(folder, filename);
	let counter = 1;
	while (await pathExists(candidate)) {
		candidate = path.join(folder, `${base}-${counter}${extension}`);
		counter += 1;
	}
	return candidate;
}

export async function writeFilesystemBinary(
	targetPath: string,
	data: ArrayBuffer | Uint8Array | Buffer
): Promise<void> {
	const buffer =
		data instanceof Buffer ? data : Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data));
	await ensureFilesystemFolder(path.dirname(targetPath));
	await fs.writeFile(targetPath, buffer);
}

export async function readFilesystemBinary(
	targetPath: string
): Promise<ArrayBuffer> {
	const buffer = await fs.readFile(targetPath);
	return buffer.buffer.slice(
		buffer.byteOffset,
		buffer.byteOffset + buffer.byteLength
	);
}

export async function deriveGoogleDriveFileId(
	localPath: string
): Promise<string | null> {
	const target = toAbsoluteFilesystemPath(localPath);
	for (const attr of ["com.google.drivefs.item-id#S", "com.google.drivefs.item-id"]) {
		try {
			const { stdout } = await execFileAsync("xattr", ["-p", attr, target]);
			const value = stdout.trim();
			if (value) {
				return value;
			}
		} catch {
			continue;
		}
	}
	return null;
}

export async function deriveGoogleDriveUrl(
	localPath: string
): Promise<string | undefined> {
	const itemId = await deriveGoogleDriveFileId(localPath);
	return itemId ? `https://drive.google.com/file/d/${itemId}/view` : undefined;
}

export async function deriveGoogleDriveUrlWithRetries(
	localPath: string,
	delaysMs: number[] = [0, 1500, 4000]
): Promise<string | undefined> {
	for (const delay of delaysMs) {
		if (delay > 0) {
			await new Promise((resolve) => window.setTimeout(resolve, delay));
		}
		const url = await deriveGoogleDriveUrl(localPath);
		if (url) {
			return url;
		}
	}
	return undefined;
}

export function getArchivedRecordingReference(
	settings: AudioNotesSettings,
	frontmatter: Record<string, unknown>
): GoogleDriveArchiveReference | null {
	const archiveKind =
		typeof frontmatter.recording_archive === "string"
			? frontmatter.recording_archive.trim().toLowerCase()
			: "";
	const recordingDrivePath =
		typeof frontmatter.recording_drive_path === "string"
			? normalizeArchiveRelativePath(frontmatter.recording_drive_path)
			: "";
	if (archiveKind !== GOOGLE_DRIVE_ARCHIVE_KIND || !recordingDrivePath) {
		return null;
	}
	const recordingUrl =
		typeof frontmatter.recording_url === "string"
			? frontmatter.recording_url.trim()
			: undefined;
	const localAudioPath = resolveGoogleDriveRecordingLocalPath(
		settings,
		recordingDrivePath
	);
	return {
		recordingArchive: GOOGLE_DRIVE_ARCHIVE_KIND,
		recordingDrivePath,
		recordingUrl,
		localAudioPath: localAudioPath || undefined,
	};
}
