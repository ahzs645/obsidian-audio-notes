import AdmZip from "adm-zip";
import { createHash } from "crypto";
import path from "path";
import { Notice, normalizePath, Vault } from "obsidian";
import type AutomaticAudioNotes from "./main";
import {
	generateMeetingNoteContent,
} from "./MeetingNoteTemplate";
import {
	deriveGoogleDriveUrlWithRetries,
	getAvailableFilesystemPath,
	getGoogleDriveArchiveRoot,
	isGoogleDriveArchiveEnabled,
	normalizeArchiveRelativePath,
	pathExists,
	resolveGoogleDriveRecordingLocalPath,
	writeFilesystemBinary,
} from "./googleDriveArchive";

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

export interface ProcessedSegment {
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
	recordingArchive?: string;
	recordingDrivePath?: string;
	recordingUrl?: string;
	localAudioPath?: string;
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

interface WhisperImportIndexEntry {
	transcriptPath: string;
	audioPath?: string;
	recordingArchive?: string;
	recordingDrivePath?: string;
	recordingUrl?: string;
	audioSha1?: string;
	segmentsSha1?: string;
	fingerprint?: string | null;
	normalizedName: string;
	normalizedDate?: number;
	durationMs: number;
}

interface WhisperImportIndex {
	root: string;
	entriesByPath: Map<string, WhisperImportIndexEntry>;
	byAudioSha1: Map<string, Set<string>>;
	bySegmentsSha1: Map<string, Set<string>>;
	byFingerprint: Map<string, Set<string>>;
	byName: Map<string, Set<string>>;
}

export interface WhisperTrimOptions {
	startSec: number;
	endSec: number;
	trimmedAudioBuffer: Buffer;
}

export interface WhisperImportOptions {
	audioFolder: string;
	transcriptFolder: string;
	useDateFolders: boolean;
	createNote?: boolean;
	noteFolder?: string;
	noteTitle?: string;
	trimOptions?: WhisperTrimOptions;
}

interface MeetingAudioReferenceInput {
	audioPath?: string;
	recordingArchive?: string;
	recordingDrivePath?: string;
	recordingUrl?: string;
}

const DEFAULT_OPTIONS = (plugin: AutomaticAudioNotes): WhisperImportOptions => ({
	audioFolder: plugin.settings.whisperAudioFolder,
	transcriptFolder: plugin.settings.whisperTranscriptFolder,
	useDateFolders: plugin.settings.whisperUseDateFolders,
	createNote: plugin.settings.whisperCreateNote,
	noteFolder: plugin.settings.whisperNoteFolder,
});

const whisperImportIndexCache = new WeakMap<
	AutomaticAudioNotes,
	Map<string, Promise<WhisperImportIndex>>
>();

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

function normalizeIndexRoot(transcriptFolder: string | undefined): string {
	return transcriptFolder
		? normalizePath(transcriptFolder).replace(/\/+$/, "")
		: "";
}

function isPathInsideRoot(path: string, normalizedRoot: string): boolean {
	const normalizedPath = normalizePath(path);
	if (!normalizedRoot) {
		return true;
	}
	return (
		normalizedPath === normalizedRoot ||
		normalizedPath.startsWith(`${normalizedRoot}/`)
	);
}

function createEmptyWhisperImportIndex(root: string): WhisperImportIndex {
	return {
		root,
		entriesByPath: new Map(),
		byAudioSha1: new Map(),
		bySegmentsSha1: new Map(),
		byFingerprint: new Map(),
		byName: new Map(),
	};
}

function addIndexReference(
	map: Map<string, Set<string>>,
	key: string | undefined | null,
	transcriptPath: string
) {
	if (!key) {
		return;
	}
	const existing = map.get(key);
	if (existing) {
		existing.add(transcriptPath);
		return;
	}
	map.set(key, new Set([transcriptPath]));
}

function removeIndexReference(
	map: Map<string, Set<string>>,
	key: string | undefined | null,
	transcriptPath: string
) {
	if (!key) {
		return;
	}
	const existing = map.get(key);
	if (!existing) {
		return;
	}
	existing.delete(transcriptPath);
	if (!existing.size) {
		map.delete(key);
	}
}

function removeWhisperImportIndexEntry(
	index: WhisperImportIndex,
	transcriptPath: string
) {
	const normalizedPath = normalizePath(transcriptPath);
	const existing = index.entriesByPath.get(normalizedPath);
	if (!existing) {
		return;
	}
	index.entriesByPath.delete(normalizedPath);
	removeIndexReference(
		index.byAudioSha1,
		existing.audioSha1,
		normalizedPath
	);
	removeIndexReference(
		index.bySegmentsSha1,
		existing.segmentsSha1,
		normalizedPath
	);
	removeIndexReference(
		index.byFingerprint,
		existing.fingerprint ?? undefined,
		normalizedPath
	);
	removeIndexReference(
		index.byName,
		existing.normalizedName,
		normalizedPath
	);
}

function addWhisperImportIndexEntry(
	index: WhisperImportIndex,
	entry: WhisperImportIndexEntry
) {
	removeWhisperImportIndexEntry(index, entry.transcriptPath);
	index.entriesByPath.set(entry.transcriptPath, entry);
	addIndexReference(index.byAudioSha1, entry.audioSha1, entry.transcriptPath);
	addIndexReference(
		index.bySegmentsSha1,
		entry.segmentsSha1,
		entry.transcriptPath
	);
	addIndexReference(
		index.byFingerprint,
		entry.fingerprint ?? undefined,
		entry.transcriptPath
	);
	addIndexReference(index.byName, entry.normalizedName, entry.transcriptPath);
}

function buildWhisperImportIndexEntry(
	transcriptPath: string,
	data: any,
	defaultName: string
): WhisperImportIndexEntry | null {
	if (data?.source !== "whisper") {
		return null;
	}
	const normalizedPath = normalizePath(transcriptPath);
	const audioPath =
		typeof data?.audioPath === "string"
			? normalizePath(data.audioPath)
			: undefined;
	const recordingArchive =
		typeof data?.recordingArchive === "string"
			? data.recordingArchive
			: undefined;
	const recordingDrivePath =
		typeof data?.recordingDrivePath === "string"
			? normalizeArchiveRelativePath(data.recordingDrivePath)
			: undefined;
	const recordingUrl =
		typeof data?.recordingUrl === "string" ? data.recordingUrl : undefined;
	return {
		transcriptPath: normalizedPath,
		audioPath,
		recordingArchive,
		recordingDrivePath,
		recordingUrl,
		audioSha1:
			typeof data?.audioSha1 === "string" ? data.audioSha1 : undefined,
		segmentsSha1:
			typeof data?.segmentsSha1 === "string"
				? data.segmentsSha1
				: inferSegmentsSha1(data?.segments),
		fingerprint:
			typeof data?.whisperFingerprint === "string"
				? data.whisperFingerprint
				: fingerprintFromStoredTranscript(data, defaultName),
		normalizedName:
			normalizeName(data?.originalMediaFilename) ||
			normalizeName(data?.originalWhisperFile),
		normalizedDate:
			normalizeEpoch(data?.createdAt) ??
			normalizeEpoch(data?.dateCreated) ??
			normalizeEpoch(data?.updatedAt) ??
			normalizeEpoch(data?.dateUpdated),
		durationMs:
			typeof data?.durationMs === "number"
				? data.durationMs
				: inferDurationMsFromSegments(data?.segments) ?? 0,
	};
}

async function buildWhisperImportIndex(
	plugin: AutomaticAudioNotes,
	normalizedRoot: string,
	defaultName: string
): Promise<WhisperImportIndex> {
	const index = createEmptyWhisperImportIndex(normalizedRoot);
	const jsonFiles = plugin.app.vault.getFiles().filter(
		(file) =>
			file.extension === "json" &&
			isPathInsideRoot(file.path, normalizedRoot)
	);

	const BATCH_SIZE = 50;
	for (let i = 0; i < jsonFiles.length; i += BATCH_SIZE) {
		const batch = jsonFiles.slice(i, i + BATCH_SIZE);
		const results = await Promise.allSettled(
			batch.map(async (file) => {
				const contents = await plugin.app.vault.read(file);
				const parsed = JSON.parse(contents);
				return buildWhisperImportIndexEntry(
					file.path,
					parsed,
					defaultName
				);
			})
		);
		for (const result of results) {
			if (result.status === "fulfilled" && result.value) {
				addWhisperImportIndexEntry(index, result.value);
			}
		}
	}
	return index;
}

async function getWhisperImportIndex(
	plugin: AutomaticAudioNotes,
	transcriptFolder: string | undefined,
	defaultName: string
): Promise<WhisperImportIndex> {
	const normalizedRoot = normalizeIndexRoot(transcriptFolder);
	let pluginCache = whisperImportIndexCache.get(plugin);
	if (!pluginCache) {
		pluginCache = new Map();
		whisperImportIndexCache.set(plugin, pluginCache);
	}
	const existing = pluginCache.get(normalizedRoot);
	if (existing) {
		return existing;
	}
	const next = buildWhisperImportIndex(
		plugin,
		normalizedRoot,
		defaultName
	).catch((error) => {
		pluginCache?.delete(normalizedRoot);
		throw error;
	});
	pluginCache.set(normalizedRoot, next);
	return next;
}

async function resolveIndexedMatch(
	plugin: AutomaticAudioNotes,
	index: WhisperImportIndex,
	transcriptPath: string
): Promise<ExistingImportMatch | null> {
	const normalizedPath = normalizePath(transcriptPath);
	const entry = index.entriesByPath.get(normalizedPath);
	if (!entry) {
		return null;
	}
	const transcriptExists =
		await plugin.app.vault.adapter.exists(normalizedPath);
	if (!transcriptExists) {
		removeWhisperImportIndexEntry(index, normalizedPath);
		return null;
	}
	const audioExists = entry.audioPath
		? await plugin.app.vault.adapter.exists(entry.audioPath)
		: false;
	const archivedLocalPath =
		entry.recordingArchive === "google-drive" && entry.recordingDrivePath
			? resolveGoogleDriveRecordingLocalPath(
					plugin.settings,
					entry.recordingDrivePath
				)
			: null;
	const archivedAudioExists = archivedLocalPath
		? await pathExists(archivedLocalPath)
		: false;
	return {
		transcriptPath: normalizedPath,
		audioPath:
			entry.audioPath ||
			(archivedAudioExists ? archivedLocalPath || undefined : undefined),
		hasAudio: Boolean(audioExists || archivedAudioExists),
	};
}

async function findIndexedMatchForKey(
	plugin: AutomaticAudioNotes,
	index: WhisperImportIndex,
	candidates: Set<string> | undefined
): Promise<ExistingImportMatch | null> {
	if (!candidates?.size) {
		return null;
	}
	for (const transcriptPath of candidates) {
		const match = await resolveIndexedMatch(
			plugin,
			index,
			transcriptPath
		);
		if (match) {
			return match;
		}
	}
	return null;
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
	const index = await getWhisperImportIndex(
		plugin,
		transcriptFolder,
		originalName
	);
	const incomingName =
		normalizeName(metadata.originalMediaFilename) ||
		normalizeName(originalName);
	const incomingDate =
		normalizeEpoch(metadata.dateCreated) ??
		normalizeEpoch(metadata.dateUpdated);
	if (audioSha1) {
		const directAudioMatch = await findIndexedMatchForKey(
			plugin,
			index,
			index.byAudioSha1.get(audioSha1)
		);
		if (directAudioMatch) {
			return directAudioMatch;
		}
	}
	if (segmentsSha1) {
		const directSegmentsMatch = await findIndexedMatchForKey(
			plugin,
			index,
			index.bySegmentsSha1.get(segmentsSha1)
		);
		if (directSegmentsMatch) {
			return directSegmentsMatch;
		}
	}
	const directFingerprintMatch = await findIndexedMatchForKey(
		plugin,
		index,
		index.byFingerprint.get(fingerprint)
	);
	if (directFingerprintMatch) {
		return directFingerprintMatch;
	}

	const incomingDuration = Math.round(meetingDurationMs || 0);
	const namedMatches = index.byName.get(incomingName);
	if (!namedMatches?.size) {
		return null;
	}
	for (const transcriptPath of namedMatches) {
		const entry = index.entriesByPath.get(transcriptPath);
		if (!entry) {
			continue;
		}
		if (
			(!incomingDate ||
				!entry.normalizedDate ||
				incomingDate === entry.normalizedDate) &&
			(!incomingDuration ||
				!entry.durationMs ||
				Math.abs(incomingDuration - entry.durationMs) < 2000)
		) {
			const match = await resolveIndexedMatch(
				plugin,
				index,
				transcriptPath
			);
			if (match) {
				return match;
			}
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

async function recordWhisperImportIndexEntry(
	plugin: AutomaticAudioNotes,
	transcriptFolder: string | undefined,
	entry: WhisperImportIndexEntry
) {
	const index = await getWhisperImportIndex(
		plugin,
		transcriptFolder,
		entry.transcriptPath
	);
	addWhisperImportIndexEntry(index, entry);
}

function buildMeetingNoteFolder(baseFolder: string, meetingDate: Date): string {
	const year = meetingDate.getFullYear().toString();
	const month = String(meetingDate.getMonth() + 1).padStart(2, "0");
	const day = String(meetingDate.getDate()).padStart(2, "0");
	return normalizePath([baseFolder, year, month, day].join("/"));
}

export interface ExtractedWhisperArchive {
	metadata: WhisperMetadata;
	audioBuffer: Buffer;
	audioExtension: string;
	segments: ProcessedSegment[];
	durationSec: number;
}

export function extractWhisperArchive(
	data: ArrayBuffer
): ExtractedWhisperArchive {
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

	const audioBuffer = audioEntry.getData();
	const audioExt =
		metadata.originalMediaExtension?.replace(".", "") ||
		detectAudioExtension(audioBuffer);
	const durationSec = segments.reduce(
		(max, seg) => Math.max(max, seg.end),
		0
	);

	return { metadata, audioBuffer, audioExtension: audioExt, segments, durationSec };
}

function trimSegments(
	segments: ProcessedSegment[],
	startSec: number,
	endSec: number
): ProcessedSegment[] {
	return segments
		.filter((seg) => seg.end > startSec && seg.start < endSec)
		.map((seg) => {
			const clippedStart = Math.max(seg.start, startSec) - startSec;
			const clippedEnd = Math.min(seg.end, endSec) - startSec;
			const words = (seg.words ?? [])
				.filter(
					(w) =>
						typeof w.start === "number" &&
						typeof w.end === "number" &&
						w.end > startSec &&
						w.start < endSec
				)
				.map((w) => ({
					text: w.text,
					start: Math.max(w.start!, startSec) - startSec,
					end: Math.min(w.end!, endSec) - startSec,
				}));
			return {
				...seg,
				start: clippedStart,
				end: clippedEnd,
				words,
			};
		});
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
	const extracted = extractWhisperArchive(data);
	const { metadata } = extracted;

	let segments = extracted.segments;
	let audioBuffer = extracted.audioBuffer;
	let audioExt = extracted.audioExtension;

	if (!segments.length) {
		throw new Error("No transcript segments found in archive.");
	}

	// Apply trim if requested
	if (options.trimOptions) {
		segments = trimSegments(
			segments,
			options.trimOptions.startSec,
			options.trimOptions.endSec
		);
		if (!segments.length) {
			throw new Error("No transcript segments remain after trimming.");
		}
		audioBuffer = options.trimOptions.trimmedAudioBuffer;
		audioExt = "wav"; // trimmed audio is always WAV
	}

	const meetingDurationSeconds = segments.reduce(
		(max, segment) => Math.max(max, segment.end),
		0
	);
	const meetingDurationMs = meetingDurationSeconds * 1000;
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

	await ensureFolderExists(plugin.app.vault, transcriptFolder);

	let audioPath: string | undefined;
	let localAudioPath: string | undefined;
	let recordingArchive: string | undefined;
	let recordingDrivePath: string | undefined;
	let recordingUrl: string | undefined;
	if (isGoogleDriveArchiveEnabled(plugin.settings)) {
		const archiveFolderAbsolute = resolveGoogleDriveRecordingLocalPath(
			plugin.settings,
			audioFolder
		);
		if (!archiveFolderAbsolute) {
			throw new Error("Google Drive archive root is not configured.");
		}
		localAudioPath = await getAvailableFilesystemPath(
			archiveFolderAbsolute,
			`${baseName}.${audioExt}`
		);
		await writeFilesystemBinary(localAudioPath, audioBuffer);
		const archiveRoot = getGoogleDriveArchiveRoot(plugin.settings);
		recordingArchive = "google-drive";
		recordingDrivePath = normalizeArchiveRelativePath(
			path.relative(archiveRoot, localAudioPath)
		);
		recordingUrl = await deriveGoogleDriveUrlWithRetries(localAudioPath);
	} else {
		await ensureFolderExists(plugin.app.vault, audioFolder);
		audioPath = await getAvailablePath(
			plugin.app.vault,
			`${audioFolder}/${baseName}.${audioExt}`
		);
	}
	const transcriptPath = await getAvailablePath(
		plugin.app.vault,
		`${transcriptFolder}/${baseName}.json`
	);
	const transcriptPayload = {
		source: "whisper",
		whisperFingerprint,
		audioPath: audioPath ?? null,
		recordingArchive: recordingArchive ?? null,
		recordingDrivePath: recordingDrivePath ?? null,
		recordingUrl: recordingUrl ?? null,
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
	};

	if (audioPath) {
		await plugin.app.vault.adapter.writeBinary(audioPath, audioBuffer);
	}
	await plugin.app.vault.adapter.write(
		transcriptPath,
		JSON.stringify(transcriptPayload, null, 2)
	);
	const indexEntry = buildWhisperImportIndexEntry(
		transcriptPath,
		transcriptPayload,
		originalName
	);
	if (indexEntry) {
		await recordWhisperImportIndexEntry(
			plugin,
			options.transcriptFolder,
			indexEntry
		);
	}

	return {
		audioPath: audioPath ?? recordingDrivePath ?? localAudioPath ?? "",
		transcriptPath,
		segmentCount: segments.length,
		recordingArchive,
		recordingDrivePath,
		recordingUrl,
		localAudioPath,
		notePath: await maybeCreateNote(
			plugin,
			options,
			baseName,
			metadata,
			{
				audioPath,
				recordingArchive,
				recordingDrivePath,
				recordingUrl,
			},
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
	audioReference: MeetingAudioReferenceInput,
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
	const title =
		options.noteTitle?.trim() ||
		metadata.originalMediaFilename ||
		baseName.replace(/-/g, " ");

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
	const noteFolder = buildMeetingNoteFolder(folder, startDateObj);
	await ensureFolderExists(plugin.app.vault, noteFolder);
	const safeFileName =
		title
			.replace(/[\\/:*?"<>|#]+/g, "-")
			.replace(/\s+/g, " ")
			.trim() || baseName;
	const notePath = await getAvailablePath(
		plugin.app.vault,
		`${noteFolder}/${safeFileName}.md`
	);
	const content = generateMeetingNoteContent(plugin.settings, {
		title,
		audioPath: audioReference.audioPath,
		transcriptPath,
		start: startDateObj,
		end: endDateObj,
		extraFrontmatter: {
			whisper_schedule_normalized: true,
			whisper_import_version: 2,
			...(audioReference.recordingArchive
				? {
						recording_archive: audioReference.recordingArchive,
					}
				: {}),
			...(audioReference.recordingDrivePath
				? {
						recording_drive_path: audioReference.recordingDrivePath,
					}
				: {}),
			...(audioReference.recordingUrl
				? {
						recording_url: audioReference.recordingUrl,
					}
				: {}),
		},
	});
	await plugin.app.vault.adapter.write(notePath, content);
	return notePath;
}
