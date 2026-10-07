import { Buffer } from "buffer";
import {
	createDeepgramQueryParams,
	ensureFolderExists,
	normalizeFolderPath,
} from "../../AudioNotesUtils";
import type AutomaticAudioNotes from "../../main";
import {
	Transcript,
	getTranscriptFromDGResponse,
	getTranscriptFromScriberrResponse,
} from "../../Transcript";
import {
	isAbsoluteFilesystemPath,
	readFilesystemBinary,
	toAbsoluteFilesystemPath,
} from "../../googleDriveArchive";
import type { MeetingFileService } from "./MeetingFileService";

export type TranscriptionProgress = (message: string) => void;

function formatBytes(bytes: number): string {
	return bytes >= 1024 * 1024
		? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
		: `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatElapsed(ms: number): string {
	const seconds = Math.round(ms / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Reports a message with the time waited, every second, until stopped. */
function startTicker(
	message: (elapsed: string) => string,
	onProgress: TranscriptionProgress
): () => void {
	const started = Date.now();
	onProgress(message(formatElapsed(0)));
	const timer = window.setInterval(
		() => onProgress(message(formatElapsed(Date.now() - started))),
		1000
	);
	return () => window.clearInterval(timer);
}

export class TranscriptionService {
	constructor(
		private readonly plugin: AutomaticAudioNotes,
		private readonly fileService: MeetingFileService
	) {}

	canUseDeepgram(): boolean {
		return Boolean(this.plugin.settings.DGApiKey);
	}

	canUseScriberr(): boolean {
		return Boolean(
			this.plugin.settings.scriberrBaseUrl &&
				this.plugin.settings.scriberrApiKey
		);
	}

	async requestTranscription(
		provider: "deepgram" | "scriberr",
		audioPath: string,
		onProgress: TranscriptionProgress = () => {}
	): Promise<string> {
		return provider === "deepgram"
			? this.transcribeWithDeepgram(audioPath, onProgress)
			: this.transcribeWithScriberr(audioPath, onProgress);
	}

	private async transcribeWithDeepgram(
		audioPath: string,
		onProgress: TranscriptionProgress
	): Promise<string> {
		const { deepgramPrerecorded } = await import(
			"../../DeepgramPrerecorded"
		);
		onProgress("Reading the recording…");
		const arrayBuffer = await this.readAudioBinary(audioPath);
		const buffer = Buffer.from(new Uint8Array(arrayBuffer));
		const params = createDeepgramQueryParams("en-US");
		const mimeType = this.guessMimeTypeFromName(audioPath);
		// One request covers upload and transcription, so time it instead.
		const stopTicker = startTicker(
			(elapsed) => `Deepgram is transcribing ${formatBytes(buffer.byteLength)}… ${elapsed}`,
			onProgress
		);
		const response = await deepgramPrerecorded(
			this.plugin.settings.DGApiKey,
			buffer,
			params,
			mimeType
		).finally(stopTicker);
		onProgress("Saving the transcript…");
		const transcript = getTranscriptFromDGResponse(response);
		return this.saveTranscriptFile(audioPath, transcript);
	}

	private async transcribeWithScriberr(
		audioPath: string,
		onProgress: TranscriptionProgress
	): Promise<string> {
		const { ScriberrClient } = await import("../../ScriberrClient");
		onProgress("Reading the recording…");
		const arrayBuffer = await this.readAudioBinary(audioPath);
		const client = new ScriberrClient({
			baseUrl: this.plugin.settings.scriberrBaseUrl,
			apiKey: this.plugin.settings.scriberrApiKey,
			profileName: this.plugin.settings.scriberrProfileName,
		});
		onProgress(`Uploading ${formatBytes(arrayBuffer.byteLength)} to Scriberr…`);
		const job = await client.submitQuickJob({
			audio: arrayBuffer,
			filename: audioPath.split("/").pop() ?? "meeting.m4a",
			mimeType: this.guessMimeTypeFromName(audioPath),
		});
		const completed = await client.waitForQuickJob(job.id, {
			onStatus: (current, elapsedMs) => {
				const state =
					current.status === "processing"
						? "transcribing"
						: current.status === "pending" || current.status === "uploaded"
							? "queued"
							: current.status;
				onProgress(`Scriberr: ${state} · ${formatElapsed(elapsedMs)}`);
			},
		});
		onProgress("Downloading the transcript…");
		const transcriptResponse = await client.fetchTranscript(completed.id);
		onProgress("Saving the transcript…");
		const transcript = getTranscriptFromScriberrResponse(
			transcriptResponse
		);
		return this.saveTranscriptFile(audioPath, transcript);
	}

	private async saveTranscriptFile(
		sourcePath: string,
		transcript: Transcript
	): Promise<string> {
		const folder =
			normalizeFolderPath(
				this.plugin.settings.DGTranscriptFolder,
				"transcripts"
			) || "transcripts";
		await ensureFolderExists(this.plugin.app, folder);
		const baseName = sourcePath.split("/").pop() ?? "transcript";
		const fileName = baseName.replace(/\.[^.]+$/, ".json");
		const targetPath = await this.fileService.getAvailableChildPath(
			folder,
			fileName
		);
		await this.plugin.app.vault.create(
			targetPath,
			`{"segments": ${transcript.toJSON()}}`
		);
		return targetPath;
	}

	private guessMimeTypeFromName(name: string): string {
		const extension = name.split(".").pop()?.toLowerCase();
		switch (extension) {
			case "mp3":
				return "audio/mpeg";
			case "wav":
				return "audio/wav";
			case "ogg":
				return "audio/ogg";
			case "webm":
				return "audio/webm";
			case "flac":
				return "audio/flac";
			case "m4a":
			default:
				return "audio/m4a";
			}
	}

	private async readAudioBinary(audioPath: string): Promise<ArrayBuffer> {
		if (isAbsoluteFilesystemPath(audioPath)) {
			return readFilesystemBinary(toAbsoluteFilesystemPath(audioPath));
		}
		return this.plugin.app.vault.adapter.readBinary(audioPath);
	}
}
