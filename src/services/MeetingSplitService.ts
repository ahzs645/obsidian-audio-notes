import { TFile, normalizePath, type App } from "obsidian";
import type AutomaticAudioNotes from "../main";
import { splitAudio } from "../audio/AudioSplitter";
import { splitSchedule, splitSegments, type SplitSegment } from "../MeetingSplit";
import { meetingStart } from "../MeetingMetadataRepair";
import {
	buildScheduleCallout,
	generateMeetingNoteContent,
	replaceScheduleCallout,
	resolveMeetingContext,
} from "../MeetingNoteTemplate";
import {
	buildSegmentsSha1,
	ensureFolderExists,
	getAvailablePath,
	hashBuffer,
	type ProcessedSegment,
} from "../WhisperImporter";
import { parseTranscript } from "../Transcript";
import { coerceFrontmatterTags } from "../meeting-label-manager";

export const AUDIO_FIELD_KEYS = ["media_uri", "audio", "media"] as const;
export const TRANSCRIPT_FIELD_KEYS = ["transcript_uri", "transcript"] as const;

export interface MeetingSplitRequest {
	file: TFile;
	audioPath: string | null;
	transcriptPath: string | null;
	splitSec: number;
	firstTitle: string;
	secondTitle: string;
	copyLabelAndAttendees: boolean;
	trashOriginals: boolean;
	/** Leave the recording whole on part one (when it can't be cut). */
	keepAudioWhole?: boolean;
}

export interface MeetingSplitOutcome {
	firstNote: TFile;
	secondNotePath: string;
	splitSec: number;
	reencoded: boolean;
	audioCut: boolean;
	trashed: string[];
}

type TranscriptPayload = Record<string, unknown> & { segments: SplitSegment[] };

/** Paths other notes link to through their media or transcript fields. */
export function collectLinkedPaths(app: App, excludeNotePath: string): Set<string> {
	const linked = new Set<string>();
	for (const note of app.vault.getMarkdownFiles()) {
		if (note.path === excludeNotePath) continue;
		const fm = app.metadataCache.getFileCache(note)?.frontmatter;
		if (!fm) continue;
		for (const key of [...AUDIO_FIELD_KEYS, ...TRANSCRIPT_FIELD_KEYS]) {
			const value = fm[key];
			if (typeof value === "string" && value.trim()) linked.add(normalizePath(value.trim()));
		}
	}
	return linked;
}

function firstStringField(fm: Record<string, unknown>, keys: readonly string[]): string | null {
	for (const key of keys) {
		if (typeof fm[key] === "string" && (fm[key] as string).trim()) return key;
	}
	return null;
}

function safeFileName(title: string, fallback: string): string {
	return (
		title
			.replace(/[\\/:*?"<>|#^[\]]+/g, "-")
			.replace(/\s+/g, " ")
			.trim() || fallback
	);
}

function splitPath(path: string): { dir: string; stem: string; ext: string } {
	const slash = path.lastIndexOf("/");
	const dir = slash === -1 ? "" : path.slice(0, slash);
	const name = slash === -1 ? path : path.slice(slash + 1);
	const dot = name.lastIndexOf(".");
	return {
		dir,
		stem: (dot === -1 ? name : name.slice(0, dot)).replace(/-part-\d+$/, ""),
		ext: dot === -1 ? "" : name.slice(dot + 1),
	};
}

function joinPath(dir: string, name: string): string {
	return normalizePath(dir ? `${dir}/${name}` : name);
}

export class MeetingSplitService {
	constructor(private readonly plugin: AutomaticAudioNotes) {}

	private get app(): App {
		return this.plugin.app;
	}

	/** The transcript as an object with a `segments` array, whatever its format. */
	async readTranscript(path: string): Promise<TranscriptPayload | null> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return null;
		const raw = await this.app.vault.read(file);
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed?.segments)) return parsed as TranscriptPayload;
			if (Array.isArray(parsed)) return { segments: parsed };
		} catch {
			// SRT / WebVTT below.
		}
		const transcript = parseTranscript(raw);
		return {
			segments: transcript.segments.map((segment) => ({ ...segment })),
		};
	}

	async split(
		request: MeetingSplitRequest,
		onProgress: (message: string) => void = () => {}
	): Promise<MeetingSplitOutcome> {
		const { app } = this;
		const { file } = request;
		const fm = (app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;

		onProgress("Reading transcript…");
		const transcript = request.transcriptPath
			? await this.readTranscript(request.transcriptPath)
			: null;

		const audioFile =
			request.audioPath && !request.keepAudioWhole
				? app.vault.getAbstractFileByPath(request.audioPath)
				: null;
		let splitSec = request.splitSec;
		let audioParts: { first: string; second: string; firstSha1: string; secondSha1: string } | null = null;
		let reencoded = false;
		const created: string[] = [];
		let noteTouched = false;

		try {
			if (audioFile instanceof TFile) {
				onProgress("Cutting the recording…");
				const data = new Uint8Array(await app.vault.readBinary(audioFile));
				const cut = await splitAudio(data, audioFile.extension, splitSec);
				splitSec = cut.splitSec;
				reencoded = cut.reencoded;
				const { dir, stem } = splitPath(audioFile.path);
				const paths: string[] = [];
				for (const [n, bytes] of [[1, cut.first], [2, cut.second]] as const) {
					const target = await getAvailablePath(app.vault, joinPath(dir, `${stem}-part-${n}.${cut.extension}`));
					await app.vault.createBinary(
						target,
						bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
					);
					created.push(target);
					paths.push(target);
				}
				audioParts = {
					first: paths[0],
					second: paths[1],
					firstSha1: hashBuffer(Buffer.from(cut.first)),
					secondSha1: hashBuffer(Buffer.from(cut.second)),
				};
			}

			const segments = transcript?.segments ?? [];
			const parts = splitSegments(segments, splitSec);
			const transcriptTotal = segments.reduce((max, s) => Math.max(max, Number(s.end) || 0), 0);
			const start = meetingStart(fm) ?? new Date(file.stat.ctime);
			const endIso = typeof fm.end === "string" ? new Date(fm.end) : null;
			const end = endIso && !Number.isNaN(endIso.getTime()) ? endIso : new Date(start.getTime() + transcriptTotal * 1000);
			const schedule = splitSchedule(start, end, splitSec, Math.max(transcriptTotal, (end.getTime() - start.getTime()) / 1000));

			let transcriptPaths: { first: string; second: string } | null = null;
			if (transcript && request.transcriptPath) {
				onProgress("Writing transcripts…");
				const { dir, stem } = splitPath(request.transcriptPath);
				const write = async (n: 1 | 2, partSegments: SplitSegment[]) => {
					const durationSec = partSegments.reduce((max, s) => Math.max(max, Number(s.end) || 0), 0);
					const payload: Record<string, unknown> = {
						...transcript,
						segments: partSegments,
						durationMs: Math.round(durationSec * 1000),
						segmentsSha1: buildSegmentsSha1(partSegments as unknown as ProcessedSegment[]),
						splitFrom: {
							transcriptPath: request.transcriptPath,
							audioSha1: transcript.audioSha1 ?? null,
							part: n,
							offsetSec: n === 1 ? 0 : splitSec,
						},
					};
					if (audioParts) {
						payload.audioPath = n === 1 ? audioParts.first : audioParts.second;
						payload.audioSha1 = n === 1 ? audioParts.firstSha1 : audioParts.secondSha1;
					} else if (n === 2) {
						// The uncut recording stays with part one.
						payload.audioPath = null;
						delete payload.audioSha1;
					}
					// Part one keeps the import fingerprint so re-importing the
					// original archive is still caught as a duplicate.
					if (n === 2 && typeof transcript.whisperFingerprint === "string") {
						payload.whisperFingerprint = `${transcript.whisperFingerprint}#part-2`;
					}
					const target = await getAvailablePath(app.vault, joinPath(dir, `${stem}-part-${n}.json`));
					await ensureFolderExists(app.vault, dir);
					await app.vault.create(target, JSON.stringify(payload, null, 2));
					created.push(target);
					return target;
				};
				transcriptPaths = {
					first: await write(1, parts.first),
					second: await write(2, parts.second),
				};
			}

			onProgress("Creating the second meeting note…");
			const folder = file.parent?.path ?? "";
			const secondNotePath = await getAvailablePath(
				app.vault,
				joinPath(folder, `${safeFileName(request.secondTitle, `${file.basename} (part 2)`)}.md`)
			);
			const keepSecondAudio = audioParts?.second;
			const content = generateMeetingNoteContent(this.plugin.settings, {
				title: request.secondTitle,
				audioPath: keepSecondAudio,
				transcriptPath: transcriptPaths?.second,
				start: schedule.second.start,
				end: schedule.second.end,
				extraFrontmatter: {
					...(fm.whisper_schedule_normalized ? { whisper_schedule_normalized: true } : {}),
					split_from: file.basename,
				},
			});
			const secondNote = await app.vault.create(secondNotePath, content);
			created.push(secondNotePath);
			if (request.copyLabelAndAttendees) {
				await app.fileManager.processFrontMatter(secondNote, (next) => {
					const tags = new Set(coerceFrontmatterTags(next.tags));
					for (const tag of coerceFrontmatterTags(fm.tags)) tags.add(tag);
					next.tags = Array.from(tags);
					if (typeof fm.meeting_label === "string") next.meeting_label = fm.meeting_label;
					if (Array.isArray(fm.attendees) && fm.attendees.length) next.attendees = [...fm.attendees];
				});
			}

			// Everything new exists; only now touch the original note.
			onProgress("Updating this note…");
			const audioKey = firstStringField(fm, AUDIO_FIELD_KEYS) ?? "media_uri";
			const transcriptKey = firstStringField(fm, TRANSCRIPT_FIELD_KEYS) ?? "transcript_uri";
			const firstContext = resolveMeetingContext(this.plugin.settings, {
				title: request.firstTitle,
				start: schedule.first.start,
				end: schedule.first.end,
			});
			noteTouched = true;
			await app.fileManager.processFrontMatter(file, (next) => {
				if (audioParts) next[audioKey] = audioParts.first;
				if (transcriptPaths) next[transcriptKey] = transcriptPaths.first;
				next.title = request.firstTitle;
				next.end = firstContext.endIso;
				next.end_date = firstContext.endDate;
				next.end_time = firstContext.endTime;
				next.split_into = secondNote.basename;
			});
			await app.vault.process(file, (body) =>
				replaceScheduleCallout(body, buildScheduleCallout(firstContext))
			);

			let firstNote = file;
			const wantedName = safeFileName(request.firstTitle, file.basename);
			if (wantedName !== file.basename) {
				const target = await getAvailablePath(app.vault, joinPath(folder, `${wantedName}.md`));
				await app.fileManager.renameFile(file, target);
				firstNote = file;
			}

			const trashed: string[] = [];
			if (request.trashOriginals) {
				onProgress("Moving the originals to the trash…");
				const stillLinked = collectLinkedPaths(app, firstNote.path);
				const originals = [
					audioParts ? request.audioPath : null,
					transcriptPaths ? request.transcriptPath : null,
				];
				for (const path of originals) {
					if (!path || stillLinked.has(normalizePath(path))) continue;
					const original = app.vault.getAbstractFileByPath(path);
					if (original instanceof TFile) {
						await app.vault.trash(original, true);
						trashed.push(path);
					}
				}
			}

			return {
				firstNote,
				secondNotePath,
				splitSec,
				reencoded,
				audioCut: Boolean(audioParts),
				trashed,
			};
		} catch (error) {
			// Until the original note is updated nothing points at the new
			// files, so a failure before then removes them again.
			if (!noteTouched) {
				for (const path of created.reverse()) {
					const made = app.vault.getAbstractFileByPath(path);
					if (made instanceof TFile) await app.vault.delete(made).catch(() => undefined);
				}
			}
			throw error;
		}
	}
}
