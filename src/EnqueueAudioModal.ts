import { Modal, Setting, Notice, request } from "obsidian";
import queryString from "query-string";

import type AutomaticAudioNotes from "./main";
import type { ApiKeyInfo } from "./AudioNotesSettings";
import {
	createAudioNoteFilenameFromUrl,
	createAudioNoteTitleFromUrl,
	createDeepgramQueryParams,
	ensureFolderExists,
	normalizeFolderPath,
} from "./AudioNotesUtils";
import type { DeepgramTranscriptionResponse } from "./Deepgram";
import {
	getTranscriptFromDGResponse,
	getTranscriptFromScriberrResponse,
	Transcript,
} from "./Transcript";
import { WHISPER_LANGUAGE_CODES, DG_LANGUAGE_CODES } from "./utils";
import {
	ScriberrClient,
	downloadAudioToArrayBuffer,
	type ScriberrConfig,
} from "./ScriberrClient";

export class EnqueueAudioModal extends Modal {
	url = "";
	private audioNotesApiKey: string;
	private apiKeyInfo: Promise<ApiKeyInfo | undefined>;
	private DGApiKey: string;

	constructor(private plugin: AutomaticAudioNotes) {
		super(plugin.app);
		this.audioNotesApiKey = plugin.settings.audioNotesApiKey;
		this.apiKeyInfo = plugin.settings.getInfoByApiKey();
		this.DGApiKey = plugin.settings.DGApiKey;
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h1", { text: "Add an mp3 file to transcribe" });

		const apiKeyInfo = await this.apiKeyInfo;
		if (apiKeyInfo) {
			this.renderAudioNotesQueueSection(contentEl, apiKeyInfo);
			return;
		}

		const hasScriberr = ScriberrClient.isConfigured(this.scriberrConfig);
		const hasDeepgram = Boolean(this.DGApiKey);

		if (!hasScriberr && !hasDeepgram) {
			contentEl.createEl("p", {
				text: "Please set an Audio Notes API key, Scriberr credentials, or Deepgram API key in the settings.",
			});
			contentEl.createEl("p", {
				text: "If you do not have an API key, contact the maintainer of this plugin. See the README at https://github.com/jjmaldonis/obsidian-audio-notes for more information.",
			});
			return;
		}

		this.renderUrlInput(contentEl);
		if (hasScriberr) {
			this.renderScriberrSection(contentEl);
		}
		if (hasDeepgram) {
			this.renderDeepgramSection(contentEl);
		}
	}

	onClose() {
		this.contentEl.empty();
	}

	private renderAudioNotesQueueSection(
		container: HTMLElement,
		apiKeyInfo: ApiKeyInfo
	) {
		new Setting(container)
			.setName("URL to .mp3 file:")
			.setDesc(
				"The .mp3 must be publicly available, so it cannot require a login or other authentication to access. The .mp3 file cannot be on your computer, it must be online."
			)
			.addText((text) =>
				text.onChange((value) => {
					this.url = value;
				})
			);

		const select = container.createEl("select", {
			cls: "select-model-accuracy",
		});
		this.populateAudioNotesModelOptions(select, apiKeyInfo);

		const selectLanguage = container.createEl("select", {
			cls: "select-model-accuracy",
		});
		for (const langs of WHISPER_LANGUAGE_CODES) {
			const langCode = langs[0];
			const langName = langs[1];
			const option = selectLanguage.createEl("option");
			option.value = langCode;
			option.textContent = langName;
		}

		new Setting(container).addButton((btn) =>
			btn
				.setButtonText("Add to Queue")
				.setCta()
				.onClick(() => {
					if (!select.value || !selectLanguage.value || !this.url) {
						new Notice(
							"Please specify a .mp3 URL, an accuracy level, and a language."
						);
						return;
					}
					if (!this.validateAudioUrl()) {
						return;
					}
					request({
						url: "https://iszrj6j2vk.execute-api.us-east-1.amazonaws.com/prod/queue",
						method: "POST",
						headers: {
							"x-api-key": this.audioNotesApiKey,
						},
						contentType: "application/json",
						body: JSON.stringify({
							url: this.url,
							model: select.value.toUpperCase(),
							language: selectLanguage.value.toLowerCase(),
						}),
					})
						.then(() => {
							new Notice(
								"Successfully queued .mp3 file for transcription"
							);
						})
						.finally(() => {
							this.close();
						});
				})
		);
	}

	private populateAudioNotesModelOptions(
		select: HTMLSelectElement,
		apiKeyInfo: ApiKeyInfo
	) {
		const baseOrHigher = ["BASE", "SMALL", "MEDIUM", "LARGE"];
		const smallOrHigher = ["SMALL", "MEDIUM", "LARGE"];
		const mediumOrHigher = ["MEDIUM", "LARGE"];
		const largeOrHigher = ["LARGE"];
		const tiny = select.createEl("option");
		tiny.value = "Tiny";
		tiny.textContent = "Tiny";
		if (baseOrHigher.includes(apiKeyInfo.tier)) {
			const base = select.createEl("option");
			base.value = "Base";
			base.textContent = "Base";
			if (smallOrHigher.includes(apiKeyInfo.tier)) {
				const small = select.createEl("option");
				small.value = "Small";
				small.textContent = "Small";
				if (mediumOrHigher.includes(apiKeyInfo.tier)) {
					const medium = select.createEl("option");
					medium.value = "Medium";
					medium.textContent = "Medium";
					if (largeOrHigher.includes(apiKeyInfo.tier)) {
						const large = select.createEl("option");
						large.value = "Large";
						large.textContent = "Large";
					}
				}
			}
		}
	}

	private renderUrlInput(container: HTMLElement) {
		new Setting(container)
			.setName("URL to .mp3 file:")
			.setDesc(
				"The .mp3 must be publicly available, so it cannot require a login or other authentication to access. The .mp3 file cannot be on your computer, it must be online."
			)
			.addText((text) =>
				text.onChange((value) => {
					this.url = value.trim();
				})
			);
	}

	private renderScriberrSection(container: HTMLElement) {
		container.createEl("h3", { text: "Scriberr" });
		const selectLanguage = container.createEl("select", {
			cls: "select-model-accuracy",
		});
		for (const langs of WHISPER_LANGUAGE_CODES) {
			const option = selectLanguage.createEl("option");
			option.value = langs[0];
			option.textContent = langs[1];
		}
		new Setting(container).addButton((btn) =>
			btn
				.setButtonText("Transcribe using Scriberr")
				.setCta()
				.onClick(() => {
					if (!selectLanguage.value) {
						new Notice("Please specify a language.");
						return;
					}
					this.handleScriberrTranscription(selectLanguage.value);
				})
		);
	}

	private renderDeepgramSection(container: HTMLElement) {
		container.createEl("h3", { text: "Deepgram" });
		const selectLanguage = container.createEl("select", {
			cls: "select-model-accuracy",
		});
		for (const langs of DG_LANGUAGE_CODES) {
			const option = selectLanguage.createEl("option");
			option.value = langs[0];
			option.textContent = langs[1];
		}
		new Setting(container).addButton((btn) =>
			btn
				.setButtonText("Transcribe using Deepgram")
				.setCta()
				.onClick(() => {
					if (!selectLanguage.value) {
						new Notice("Please specify a language.");
						return;
					}
					this.handleDeepgramTranscription(selectLanguage.value);
				})
		);
	}

	private async handleScriberrTranscription(language: string) {
		if (!this.validateAudioUrl()) {
			return;
		}
		const config = this.scriberrConfig;
		if (!config) {
			new Notice("Please configure Scriberr in the settings.");
			return;
		}
		try {
			new Notice("Downloading audio before sending to Scriberr...");
			const audioBuffer = await downloadAudioToArrayBuffer(this.url);
			const client = new ScriberrClient(config);
			const job = await client.submitJob({
				audio: audioBuffer,
				filename: this.buildAudioFilename(),
				mimeType: this.guessMimeTypeFromUrl(),
				language,
				title: createAudioNoteTitleFromUrl(this.url),
				profileName: config.profileName,
			});
			new Notice("Transcribing audio using Scriberr...");
			const completedJob = await client.waitForJob(job.id);
			const transcriptResponse = await client.fetchTranscript(
				completedJob.id
			);
			const transcript = getTranscriptFromScriberrResponse(
				transcriptResponse
			);
			const transcriptPath = await this.saveTranscriptToVault(
				this.url,
				transcript
			);
			await navigator.clipboard.writeText(transcriptPath);
			new Notice("Transcript saved. Filename copied to clipboard.");
		} catch (error: any) {
			console.error("Could not transcribe audio:", error);
			new Notice(
				`Could not transcribe audio with Scriberr: ${
					error?.message || error
				}`
			);
		} finally {
			this.close();
		}
	}

	private async handleDeepgramTranscription(language: string) {
		if (!this.validateAudioUrl()) {
			return;
		}
		try {
			const queryParams = createDeepgramQueryParams(language);
			new Notice("Transcribing audio using Deepgram...");
			const req = {
				url: `https://api.deepgram.com/v1/listen?${queryString.stringify(
					queryParams
				)}`,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"User-Agent": "Deepgram Obsidian Audio Notes Plugin",
					Authorization: `token ${this.DGApiKey}`,
				},
				contentType: "application/json",
				body: JSON.stringify({
					url: this.url,
				}),
			};
			const dgResponseString = await request(req);
			const dgResponse: DeepgramTranscriptionResponse = JSON.parse(
				dgResponseString
			);
			const transcript = getTranscriptFromDGResponse(dgResponse);
			const transcriptPath = await this.saveTranscriptToVault(
				this.url,
				transcript
			);
			await navigator.clipboard.writeText(transcriptPath);
			new Notice("Transcript filename copied to clipboard.");
		} catch (error) {
			console.error("Could not transcribe audio:", error);
			new Notice("Could not transcribe audio. Check console for details.");
		} finally {
			this.close();
		}
	}

	private async saveTranscriptToVault(
		sourceUrl: string,
		transcript: Transcript
	): Promise<string> {
		const folder = this.transcriptFolder;
		await ensureFolderExists(this.app, folder);
		const newNoteFilename = createAudioNoteFilenameFromUrl(sourceUrl);
		const transcriptFilename = `${folder}/${newNoteFilename}`.replace(
			/.md$/,
			".json"
		);
		const transcriptFileExists = await this.app.vault.adapter.exists(
			transcriptFilename
		);
		if (transcriptFileExists) {
			new Notice(
				`${transcriptFilename} already exists! Did not overwrite the file.`
			);
			return transcriptFilename;
		}
		await this.app.vault.create(
			transcriptFilename,
			`{"segments": ${transcript.toJSON()}}`
		);
		return transcriptFilename;
	}

	private validateAudioUrl(): boolean {
		if (!this.url) {
			new Notice("Please specify a .mp3 URL.");
			return false;
		}
		const sanitized = this.stripQueryFromUrl(this.url).toLowerCase();
		const valid =
			sanitized.endsWith(".mp3") ||
			sanitized.endsWith(".m4b") ||
			sanitized.endsWith(".m4a");
		if (!valid) {
			new Notice(
				"Make sure your URL is an .mp3, .m4b, or .m4a file. It should end in one of those extensions (excluding everything after an optional question mark).",
				10000
			);
		}
		return valid;
	}

	private stripQueryFromUrl(url: string): string {
		return url.split("?")[0];
	}

	private buildAudioFilename(): string {
		const base = this.stripQueryFromUrl(this.url);
		const parts = base.split("/");
		const last = parts[parts.length - 1] || "audio.mp3";
		if (last.includes(".")) {
			return last;
		}
		return `${last}.mp3`;
	}

	private guessMimeTypeFromUrl(): string {
		const lower = this.stripQueryFromUrl(this.url).toLowerCase();
		if (lower.endsWith(".m4a") || lower.endsWith(".m4b")) {
			return "audio/mp4";
		}
		return "audio/mpeg";
	}

	private get transcriptFolder(): string {
		const folder = normalizeFolderPath(
			this.plugin.settings.DGTranscriptFolder,
			"transcripts"
		);
		return folder || "transcripts";
	}

	private get scriberrConfig(): ScriberrConfig | undefined {
		if (!this.plugin.settings.hasScriberrCredentials) {
			return undefined;
		}
		return {
			baseUrl: this.plugin.settings.scriberrBaseUrl,
			apiKey: this.plugin.settings.scriberrApiKey,
			profileName: this.plugin.settings.scriberrProfileName || undefined,
		};
	}
}
