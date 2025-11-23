import AdmZip from "adm-zip";
import { createHash } from "crypto";
import { Notice, normalizePath, Vault } from "obsidian";
import type AutomaticAudioNotes from "./main";
import {
	generateMeetingNoteContent,
} from "./MeetingNoteTemplate";

interface WhisperMetadata {
	dateCreated?: number | string;
	dateUpdated?: number | string;
	modelEngine?: string;
	modelQualityID?: string;
	originalMediaFilename?: string;
	originalMediaExtension?: string;
	startTimeOffset?: {
		hours?: number;
		minutes?: number;
		seconds?: number;
		milliseconds?: number;
	};
	speakers?: unknown[];
	transcripts?: WhisperSegment[];
}

interface WhisperSegment {
	id?: string;
	text?: string;
	start?: number;
	end?: number;
	speaker?: {
		id?: string;
		name?: string;
	};
	words?: {
		text?: string;
		startTime?: number;
		endTime?: number;
	}[];
}

interface ProcessedSegment {
	id: string | number;
	start: number;
	end: number;
	text: string;
	speakerId: string | null;
	speakerName: string | null;
	words: {
		text: string;
		start: number;
		end: number;
	}[];
}

export interface WhisperImportResult {
	audioPath: string;
	transcriptPath: string;
	segmentCount: number;
	notePath?: string;
	noteTitle?: string;
}

export class WhisperDuplicateError extends Error {
	public existingTranscriptPath?: string;
	constructor(message: string, existingTranscriptPath?: string) {
		super(message);
		this.name = "WhisperDuplicateError";
		this.existingTranscriptPath = existingTranscriptPath;
	}
}

interface ExistingImportMatch {
	transcriptPath: string;
	audioPath?: string;
	hasAudio: boolean;
}

export interface WhisperImportOptions {
	audioFolder: string;
	transcriptFolder: string;
	useDateFolders: boolean;
	createNote?: boolean;
	noteFolder?: string;
	noteTitle?: string;
}

const DEFAULT_OPTIONS = (plugin: AutomaticAudioNotes): WhisperImportOptions => ({
	audioFolder: plugin.settings.whisperAudioFolder,
	transcriptFolder: plugin.settings.whisperTranscriptFolder,
	useDateFolders: plugin.settings.whisperUseDateFolders,
	createNote: plugin.settings.whisperCreateNote,
	noteFolder: plugin.settings.whisperNoteFolder,
});

function slugify(input: string | undefined, fallback: string): string {
	if (!input || input.trim() === "") {
		return fallback;
	}
	return input
		.normalize("NFKD")
		.replace(/[^\w\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.toLowerCase();
}

function msFromOffset(offset: WhisperMetadata["startTimeOffset"]): number {
	if (!offset) return 0;
	const hours = offset.hours ?? 0;
	const minutes = offset.minutes ?? 0;
	const seconds = offset.seconds ?? 0;
	const ms = offset.milliseconds ?? 0;
	return ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms;
}

function msToSeconds(value: number | undefined): number | undefined {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return undefined;
	}
	return value / 1000;
}

function normalizeEpoch(
	value: number | string | undefined
): number | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	const numeric =
		typeof value === "string" ? Number(value) : value;
	if (typeof numeric !== "number" || Number.isNaN(numeric)) {
		return undefined;
	}
	const APPLE_EPOCH_OFFSET_SECONDS = 978307200;
	const APPLE_EPOCH_OFFSET_MILLISECONDS =
		APPLE_EPOCH_OFFSET_SECONDS * 1000;
	const candidates = [
		numeric, // already milliseconds
		numeric * 1000, // unix seconds
		(numeric + APPLE_EPOCH_OFFSET_SECONDS) * 1000, // CFAbsoluteTime seconds
		numeric + APPLE_EPOCH_OFFSET_MILLISECONDS, // CFAbsoluteTime milliseconds
	].filter((ms) => Number.isFinite(ms) && ms > 0);
	const now = Date.now();
	const inReasonableRange = candidates.filter((ms) => {
		const year = new Date(ms).getUTCFullYear();
		return year >= 2000 && year <= 2100;
	});
	const shortlisted = inReasonableRange.length ? inReasonableRange : candidates;
	shortlisted.sort((a, b) => Math.abs(now - a) - Math.abs(now - b));
	return shortlisted[0];
}

function subfolderFromDate(
	dateValue: number | string | undefined,
	useDateFolders: boolean
): string | undefined {
	if (!useDateFolders) {
		return undefined;
	}
	const millis = normalizeEpoch(dateValue);
	if (!millis) return undefined;
	const d = new Date(millis);
	if (Number.isNaN(d.getTime())) return undefined;
	const year = d.getUTCFullYear();
	const month = String(d.getUTCMonth() + 1).padStart(2, "0");
	return `${year}/${month}`;
}

async function ensureFolderExists(vault: Vault, folderPath: string) {
	const normalized = normalizePath(folderPath);
	if (await vault.adapter.exists(normalized)) {
		return;
	}
	const parts = normalized.split("/").filter((part) => part.length > 0);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (await vault.adapter.exists(current)) {
			continue;
		}
		await vault.createFolder(current);
	}
}

async function getAvailablePath(vault: Vault, targetPath: string) {
	const normalized = normalizePath(targetPath);
	if (!(await vault.adapter.exists(normalized))) {
		return normalized;
	}
	const lastSlash = normalized.lastIndexOf("/");
	const dir = lastSlash === -1 ? "" : normalized.substring(0, lastSlash);
	const filename =
		lastSlash === -1 ? normalized : normalized.substring(lastSlash + 1);
	const dotIndex = filename.lastIndexOf(".");
	const baseName = dotIndex === -1 ? filename : filename.substring(0, dotIndex);
	const extension = dotIndex === -1 ? "" : filename.substring(dotIndex);
	let counter = 1;
	while (true) {
		const candidate =
			dir === ""
				? `${baseName}-${counter}${extension}`
				: `${dir}/${baseName}-${counter}${extension}`;
		if (!(await vault.adapter.exists(candidate))) {
			return candidate;
		}
		counter += 1;
	}
}

function detectAudioExtension(buffer: Buffer, fallback = "m4a") {
	if (!buffer || buffer.length < 12) {
		return fallback;
	}
	const riff = buffer.toString("ascii", 0, 4);
	const ftyp = buffer.toString("ascii", 4, 8);
	const id3 = buffer.toString("ascii", 0, 3);
	if (riff === "RIFF") return "wav";
	if (ftyp === "ftyp") return "m4a";
	if (id3 === "ID3") return "mp3";
	return fallback;
}

function normalizeName(value?: string): string {
	return (value || "").trim().toLowerCase();
}

function buildWhisperFingerprint(
	metadata: WhisperMetadata,
	originalName: string,
	meetingDurationMs: number,
	hashes?: { audio?: string; segments?: string }
): string {
	const baseName =
		normalizeName(metadata.originalMediaFilename) ||
		normalizeName(originalName);
	const created =
		normalizeEpoch(metadata.dateCreated) ??
		normalizeEpoch(metadata.dateUpdated) ??
		null;
	const duration = Number.isFinite(meetingDurationMs)
		? Math.round(meetingDurationMs)
		: null;
	return [
		"whisper",
		"v3",
		baseName || "unknown",
		created ?? "na",
		duration ?? "na",
		hashes?.audio ?? "nohash",
		hashes?.segments ?? "nohash",
	].join("|");
}

function inferDurationMsFromSegments(
	segments: { end?: number }[] | undefined
): number | undefined {
	if (!Array.isArray(segments) || !segments.length) return undefined;
	const maxEnd = Math.max(
		...segments
			.map((segment) => Number(segment?.end) || 0)
			.filter((value) => Number.isFinite(value))
	);
	return Number.isFinite(maxEnd) ? Math.round(maxEnd * 1000) : undefined;
}

function fingerprintFromStoredTranscript(
	data: any,
	defaultName: string
): string | null {
	const storedDuration =
		typeof data?.durationMs === "number"
			? data.durationMs
			: inferDurationMsFromSegments(data?.segments);
	const storedMetadata: WhisperMetadata = {
		dateCreated:
			data?.createdAt ??
			data?.dateCreated ??
			data?.updatedAt ??
			data?.dateUpdated,
		originalMediaFilename:
			data?.originalMediaFilename ?? data?.originalWhisperFile,
	};
	return buildWhisperFingerprint(
		storedMetadata,
		data?.originalWhisperFile ?? defaultName,
		storedDuration ?? 0,
		{
			audio: typeof data?.audioSha1 === "string" ? data.audioSha1 : undefined,
			segments: typeof data?.segmentsSha1 === "string" ? data.segmentsSha1 : undefined,
		}
	);
}

async function findExistingWhisperImport(
	plugin: AutomaticAudioNotes,
	fingerprint: string,
	metadata: WhisperMetadata,
	originalName: string,
	meetingDurationMs: number,
	transcriptFolder: string | undefined,
	audioSha1: string | undefined,
	segmentsSha1: string | undefined
): Promise<ExistingImportMatch | null> {
	const normalizedRoot = transcriptFolder
		? normalizePath(transcriptFolder).replace(/\/+$/, "")
		: "";
	const files = plugin.app.vault.getFiles();
	const incomingName =
		normalizeName(metadata.originalMediaFilename) ||
		normalizeName(originalName);
	const incomingDate =
		normalizeEpoch(metadata.dateCreated) ??
		normalizeEpoch(metadata.dateUpdated);
	for (const file of files) {
		if (file.extension !== "json") continue;
		if (normalizedRoot) {
			const normalizedPath = normalizePath(file.path);
			if (
				normalizedPath !== normalizedRoot &&
				!normalizedPath.startsWith(`${normalizedRoot}/`)
			) {
				continue;
			}
		}
		try {
			const contents = await plugin.app.vault.read(file);
			const parsed = JSON.parse(contents);
			if (parsed?.source !== "whisper") {
				continue;
			}
			const parsedAudioPath =
				typeof parsed.audioPath === "string"
					? normalizePath(parsed.audioPath)
					: undefined;
			const audioExists =
				parsedAudioPath &&
				(await plugin.app.vault.adapter.exists(parsedAudioPath));
			const storedAudioSha1 =
				typeof parsed.audioSha1 === "string" ? parsed.audioSha1 : undefined;
			const storedSegmentsSha1 =
				typeof parsed.segmentsSha1 === "string"
					? parsed.segmentsSha1
					: inferSegmentsSha1(parsed.segments);
			if (audioSha1 && storedAudioSha1 && audioSha1 === storedAudioSha1) {
				return {
					transcriptPath: file.path,
					audioPath: parsedAudioPath,
					hasAudio: Boolean(audioExists),
				};
			}
			if (
				segmentsSha1 &&
				storedSegmentsSha1 &&
				segmentsSha1 === storedSegmentsSha1
			) {
				return {
					transcriptPath: file.path,
					audioPath: parsedAudioPath,
					hasAudio: Boolean(audioExists),
				};
			}
			const storedFingerprint =
				typeof parsed.whisperFingerprint === "string"
					? parsed.whisperFingerprint
					: fingerprintFromStoredTranscript(parsed, originalName);
			if (storedFingerprint && storedFingerprint === fingerprint) {
				return {
					transcriptPath: file.path,
					audioPath: parsedAudioPath,
					hasAudio: Boolean(audioExists),
				};
			}

			const storedName =
				normalizeName(parsed.originalMediaFilename) ||
				normalizeName(parsed.originalWhisperFile);
			const storedDate =
				normalizeEpoch(parsed.createdAt) ??
				normalizeEpoch(parsed.dateCreated) ??
				normalizeEpoch(parsed.updatedAt) ??
				normalizeEpoch(parsed.dateUpdated);
			const storedDuration =
				typeof parsed.durationMs === "number"
					? parsed.durationMs
					: inferDurationMsFromSegments(parsed.segments) ?? 0;
			const incomingDuration = Math.round(meetingDurationMs || 0);
			if (
				storedName &&
				incomingName &&
				storedName === incomingName &&
				(!incomingDate ||
					!storedDate ||
					incomingDate === storedDate) &&
				(!incomingDuration ||
					!storedDuration ||
					Math.abs(incomingDuration - storedDuration) < 2000)
			) {
				return {
					transcriptPath: file.path,
					audioPath: parsedAudioPath,
					hasAudio: Boolean(audioExists),
				};
			}
		} catch {
			continue;
		}
	}
	return null;
}

function hashBuffer(buffer: Buffer): string {
	const hash = createHash("sha1");
	hash.update(buffer);
	return hash.digest("hex");
}

function buildSegmentsSha1(segments: ProcessedSegment[]): string {
	const normalized = segments
		.map((segment) => {
			const startMs = Math.round((segment.start ?? 0) * 1000);
			const endMs = Math.round((segment.end ?? 0) * 1000);
			return `${startMs}-${endMs}:${(segment.text ?? "").trim()}`;
		})
		.join("|");
	return hashBuffer(Buffer.from(normalized, "utf8"));
}

function inferSegmentsSha1(rawSegments: any): string | undefined {
	if (!Array.isArray(rawSegments) || !rawSegments.length) return undefined;
	try {
		const normalized = rawSegments
			.map((segment) => {
				const startMs = Math.round(
					Number(segment?.start) * 1000 || 0
				);
				const endMs = Math.round(Number(segment?.end) * 1000 || 0);
				const text =
					typeof segment?.text === "string"
						? segment.text.trim()
						: "";
				return `${startMs}-${endMs}:${text}`;
			})
			.join("|");
		return hashBuffer(Buffer.from(normalized, "utf8"));
	} catch {
		return undefined;
	}
}

export async function importWhisperArchive(
	plugin: AutomaticAudioNotes,
	data: ArrayBuffer,
	originalName: string,
	overrideOptions?: Partial<WhisperImportOptions>
): Promise<WhisperImportResult> {
	const options = {
		...DEFAULT_OPTIONS(plugin),
		...overrideOptions,
	};
	const zip = new AdmZip(Buffer.from(data));
	const metadataEntry = zip.getEntry("metadata.json");
	const audioEntry = zip.getEntry("originalAudio");
	if (!metadataEntry || !audioEntry) {
		throw new Error("Archive must contain metadata.json and originalAudio.");
	}
	const metadata = JSON.parse(
		metadataEntry.getData().toString("utf8")
	) as WhisperMetadata;
	const offsetMs = msFromOffset(metadata.startTimeOffset);
	const transcripts = Array.isArray(metadata.transcripts)
		? metadata.transcripts
		: [];
	const segments = transcripts
		.map((segment, index) => {
			const startMs =
				typeof segment.start === "number"
					? segment.start + offsetMs
					: undefined;
			const endMs =
				typeof segment.end === "number" ? segment.end + offsetMs : undefined;
			if (startMs === undefined || endMs === undefined) {
				return undefined;
			}
			const words = Array.isArray(segment.words)
				? segment.words
						.map((word) => {
							if (
								typeof word.startTime !== "number" ||
								typeof word.endTime !== "number"
							) {
								return undefined;
							}
							return {
								text: word.text ?? "",
								start: msToSeconds(word.startTime + offsetMs),
								end: msToSeconds(word.endTime + offsetMs),
							};
						})
						.filter(Boolean)
				: [];
			return {
				id: segment.id ?? index,
				start: msToSeconds(startMs),
				end: msToSeconds(endMs),
				text: (segment.text ?? "").trim(),
				speakerId: segment.speaker?.id ?? null,
				speakerName: segment.speaker?.name ?? null,
				words,
			};
		})
		.filter((segment): segment is ProcessedSegment => Boolean(segment));

	if (!segments.length) {
		throw new Error("No transcript segments found in archive.");
	}

	const meetingDurationSeconds = segments.reduce(
		(max, segment) => Math.max(max, segment.end),
		0
	);
	const meetingDurationMs = meetingDurationSeconds * 1000;
	const audioBuffer = audioEntry.getData();
	const audioSha1 = hashBuffer(audioBuffer);
	const segmentsSha1 = buildSegmentsSha1(segments);
	const whisperFingerprint = buildWhisperFingerprint(
		metadata,
		originalName,
		meetingDurationMs,
		{
			audio: audioSha1,
			segments: segmentsSha1,
		}
	);

	const existingImport = await findExistingWhisperImport(
		plugin,
		whisperFingerprint,
		metadata,
		originalName,
		meetingDurationMs,
		options.transcriptFolder,
		audioSha1,
		segmentsSha1
	);
	if (existingImport) {
		throw new WhisperDuplicateError(
			`This Whisper archive appears to be already imported: ${existingImport.transcriptPath}`,
			existingImport.transcriptPath
		);
	}

	const baseName = slugify(
		metadata.originalMediaFilename,
		slugify(originalName.replace(/\.whisper$/i, ""), `whisper-${Date.now()}`)
	);
	const subfolder = subfolderFromDate(
		metadata.dateCreated,
		options.useDateFolders
	);
	const audioFolder = subfolder
		? `${options.audioFolder}/${subfolder}`
		: options.audioFolder;
	const transcriptFolder = subfolder
		? `${options.transcriptFolder}/${subfolder}`
		: options.transcriptFolder;

	await ensureFolderExists(plugin.app.vault, audioFolder);
	await ensureFolderExists(plugin.app.vault, transcriptFolder);

	const audioExt =
		metadata.originalMediaExtension?.replace(".", "") ||
		detectAudioExtension(audioBuffer);
	const audioPath = await getAvailablePath(
		plugin.app.vault,
		`${audioFolder}/${baseName}.${audioExt}`
	);
	const transcriptPath = await getAvailablePath(
		plugin.app.vault,
		`${transcriptFolder}/${baseName}.json`
	);

	await plugin.app.vault.adapter.writeBinary(audioPath, audioBuffer);
	await plugin.app.vault.adapter.write(
		transcriptPath,
		JSON.stringify(
			{
				source: "whisper",
				whisperFingerprint,
				audioPath,
				audioSha1,
				segmentsSha1,
				originalMediaFilename: metadata.originalMediaFilename ?? null,
				originalWhisperFile: originalName,
				model: metadata.modelQualityID ?? metadata.modelEngine ?? "unknown",
				createdAt: metadata.dateCreated ?? null,
				updatedAt: metadata.dateUpdated ?? null,
				speakers: metadata.speakers ?? [],
				segments,
				durationMs: meetingDurationMs,
			},
			null,
			2
		)
	);

	return {
		audioPath,
		transcriptPath,
		segmentCount: segments.length,
		notePath: await maybeCreateNote(
			plugin,
			options,
			baseName,
			metadata,
			audioPath,
			transcriptPath,
			meetingDurationMs
		),
		noteTitle:
			options.noteTitle ||
			metadata.originalMediaFilename ||
			baseName.replace(/-/g, " "),
	};
}

export function notifyWhisperImportSuccess(result: WhisperImportResult) {
	new Notice(
		`Whisper archive imported.\nAudio: ${result.audioPath}\nTranscript: ${result.transcriptPath}${
			result.notePath ? `\nNote: ${result.notePath}` : ""
		}`
	);
}

async function maybeCreateNote(
	plugin: AutomaticAudioNotes,
	options: WhisperImportOptions,
	baseName: string,
	metadata: WhisperMetadata,
	audioPath: string,
	transcriptPath: string,
	meetingDurationMs: number
): Promise<string | undefined> {
	if (!options.createNote) {
		return undefined;
	}
	const folder = options.noteFolder?.trim();
	if (!folder) {
		return undefined;
	}

	await ensureFolderExists(plugin.app.vault, folder);
	const title =
		options.noteTitle?.trim() ||
		metadata.originalMediaFilename ||
		baseName.replace(/-/g, " ");
	const safeFileName = title.replace(/[\\/]/g, "-").trim() || baseName;
	const notePath = await getAvailablePath(
		plugin.app.vault,
		`${folder}/${safeFileName}.md`
	);

	const createdAt = normalizeEpoch(metadata.dateCreated);
	const updatedAt = normalizeEpoch(metadata.dateUpdated);
	const normalizedDuration =
		Number.isFinite(meetingDurationMs) && meetingDurationMs > 0
			? meetingDurationMs
			: 0;
	let endTimestamp =
		createdAt ??
		updatedAt ??
		Date.now();
	if (!Number.isFinite(endTimestamp)) {
		endTimestamp = Date.now();
	}
	let startTimestamp =
		normalizedDuration > 0
			? endTimestamp - normalizedDuration
			: updatedAt ?? endTimestamp;
	if (!Number.isFinite(startTimestamp)) {
		startTimestamp = endTimestamp;
	}
	if (startTimestamp > endTimestamp) {
		const swap = startTimestamp;
		startTimestamp = endTimestamp;
		endTimestamp = swap;
	}
	const startDateObj = new Date(startTimestamp);
	const endDateObj = new Date(endTimestamp);
	const startIso = startDateObj.toISOString();
	const endIso = endDateObj.toISOString();
	const content = generateMeetingNoteContent(plugin.settings, {
		title,
		audioPath,
		transcriptPath,
		start: startDateObj,
		end: endDateObj,
		extraFrontmatter: {
			whisper_schedule_normalized: true,
			whisper_import_version: 2,
		},
	});
	await plugin.app.vault.adapter.write(notePath, content);
	return notePath;
}
