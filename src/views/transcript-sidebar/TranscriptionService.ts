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
		audioPath: string
	): Promise<string> {
		return provider === "deepgram"
			? this.transcribeWithDeepgram(audioPath)
			: this.transcribeWithScriberr(audioPath);
	}

	private async transcribeWithDeepgram(audioPath: string): Promise<string> {
		const { deepgramPrerecorded } = await import(
			"../../DeepgramPrerecorded"
		);
		const arrayBuffer = await this.readAudioBinary(audioPath);
		const buffer = Buffer.from(new Uint8Array(arrayBuffer));
		const params = createDeepgramQueryParams("en-US");
		const mimeType = this.guessMimeTypeFromName(audioPath);
		const response = await deepgramPrerecorded(
			this.plugin.settings.DGApiKey,
			buffer,
			params,
			mimeType
		);
		const transcript = getTranscriptFromDGResponse(response);
		return this.saveTranscriptFile(audioPath, transcript);
	}

	private async transcribeWithScriberr(audioPath: string): Promise<string> {
		const { ScriberrClient } = await import("../../ScriberrClient");
		const arrayBuffer = await this.readAudioBinary(audioPath);
		const client = new ScriberrClient({
			baseUrl: this.plugin.settings.scriberrBaseUrl,
			apiKey: this.plugin.settings.scriberrApiKey,
			profileName: this.plugin.settings.scriberrProfileName,
		});
		const job = await client.submitQuickJob({
			audio: arrayBuffer,
			filename: audioPath.split("/").pop() ?? "meeting.m4a",
			mimeType: this.guessMimeTypeFromName(audioPath),
		});
		const completed = await client.waitForQuickJob(job.id);
		const transcriptResponse = await client.fetchTranscript(completed.id);
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
