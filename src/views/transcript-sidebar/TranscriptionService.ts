import { Buffer } from "buffer";
import {
	createDeepgramQueryParams,
	ensureFolderExists,
	normalizeFolderPath,
} from "../../AudioNotesUtils";
import { deepgramPrerecorded } from "../../DeepgramPrerecorded";
import type AutomaticAudioNotes from "../../main";
import { ScriberrClient } from "../../ScriberrClient";
import {
	Transcript,
	getTranscriptFromDGResponse,
	getTranscriptFromScriberrResponse,
} from "../../Transcript";
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
		return ScriberrClient.isConfigured({
			baseUrl: this.plugin.settings.scriberrBaseUrl,
			apiKey: this.plugin.settings.scriberrApiKey,
			profileName: this.plugin.settings.scriberrProfileName,
		});
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
		const adapter = this.plugin.app.vault.adapter;
		const arrayBuffer = await adapter.readBinary(audioPath);
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
		const adapter = this.plugin.app.vault.adapter;
		const arrayBuffer = await adapter.readBinary(audioPath);
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
}
