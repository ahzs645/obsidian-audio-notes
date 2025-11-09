import type AutomaticAudioNotes from "./main";
import {
	PluginSettingTab,
	Setting,
	Notice,
	ToggleComponent,
	request,
	App,
} from "obsidian";
import { secondsToTimeString } from "./utils";

export class ApiKeyInfo {
	constructor(
		public api_key: string,
		public paying: boolean,
		public tier: string,
		public queued: string[],
		public transcripts: string[]
	) {}
}

export class AudioNotesSettingsTab extends PluginSettingTab {
	plugin: AutomaticAudioNotes;

	constructor(app: App, plugin: AutomaticAudioNotes) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		let { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("+ duration (seconds) when generating new notes")
			.setDesc(
				"The amount of time to add from the current time when creating new audio notes"
			)
			.addText((text) =>
				text
					.setPlaceholder("30")
					.setValue(this.plugin.settings.plusDuration.toString())
					.onChange(async (value) => {
						try {
							parseFloat(value);
							this.plugin.settings.plusDuration = value;
							await this.plugin.saveSettings();
						} catch {
							new Notice("Must be a number");
						}
					})
			);

		new Setting(containerEl)
			.setName("- duration (seconds) when generating new notes")
			.setDesc(
				"The amount of time to subtract from the current time when creating new audio notes"
			)
			.addText((text) =>
				text
					.setPlaceholder("30")
					.setValue(this.plugin.settings.minusDuration.toString())
					.onChange(async (value) => {
						try {
							parseFloat(value);
							this.plugin.settings.minusDuration = value;
							await this.plugin.saveSettings();
						} catch {
							new Notice("Must be a number");
						}
					})
			);

		new Setting(containerEl)
			.setName("Skip backward (seconds)")
			.setDesc(
				"The amount of time to skip backward when pressing the backward button on the audio player"
			)
			.addText((text) =>
				text
					.setPlaceholder("5")
					.setValue(this.plugin.settings.forwardStep.toString())
					.onChange(async (value) => {
						try {
							parseFloat(value);
							this.plugin.settings.forwardStep = value;
							await this.plugin.saveSettings();
						} catch {
							new Notice("Must be a number");
						}
					})
			);

		new Setting(containerEl)
			.setName("Skip forward (seconds)")
			.setDesc(
				"The amount of time to skip forward when pressing the forward button on the audio player"
			)
			.addText((text) =>
				text
					.setPlaceholder("15")
					.setValue(this.plugin.settings.backwardStep.toString())
					.onChange(async (value) => {
						try {
							parseFloat(value);
							this.plugin.settings.backwardStep = value;
							await this.plugin.saveSettings();
						} catch {
							new Notice("Must be a number");
						}
					})
			);

		new Setting(containerEl)
			.setName("Audio Notes API Key")
			.setDesc(
				"Provided by the library maintainer to work with transcripts online. Go to github.com/jjmaldonis/obsidian-audio-notes for info about how to join the early beta."
			)
			.addText((text) =>
				text
					.setPlaceholder("<your api key>")
					.setValue(this.plugin.settings.audioNotesApiKey)
					.onChange(async (value) => {
						this.plugin.settings.audioNotesApiKey = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Debugging mode")
			.setDesc(
				"Turn on to log console messages to log.txt in the plugin folder (requires restart)."
			)
			.addToggle((toggle: ToggleComponent) => {
				toggle.onChange(async (value: boolean) => {
					this.plugin.settings.debugMode = value;
					await this.plugin.saveSettings();
				});
			});

		containerEl.createEl("h2", {
			text: "Deepgram Settings",
		});
		new Setting(containerEl)
			.setName("Deepgram API Key")
			.setDesc("Visit https://dpgr.am/obsidian to get your free API key.")
			.addText((text) =>
				text
					.setPlaceholder("Enter your API key here...")
					.setValue(this.plugin.settings.DGApiKey)
					.onChange(async (value) => {
						this.plugin.settings.DGApiKey = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Deepgram Transcript Folder")
			.setDesc("The folder your transcripts will be saved in when transcribing audio files.")
			.addText((text) =>
				text
					.setPlaceholder("transcripts/")
					.setValue(this.plugin.settings.DGTranscriptFolder)
					.onChange(async (value) => {
						this.plugin.settings.DGTranscriptFolder = value;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h2", {
			text: "Whisper archive imports",
		});
		new Setting(containerEl)
			.setName("Audio destination folder")
			.setDesc(
				"Relative path inside your vault where imported Whisper audio files will be stored."
			)
			.addText((text) =>
				text
					.setPlaceholder("MediaArchive/audio")
					.setValue(this.plugin.settings.whisperAudioFolder)
					.onChange(async (value) => {
						this.plugin.settings.whisperAudioFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Transcript destination folder")
			.setDesc(
				"Relative path inside your vault where imported Whisper transcript JSON files will be stored."
			)
			.addText((text) =>
				text
					.setPlaceholder("transcripts")
					.setValue(this.plugin.settings.whisperTranscriptFolder)
					.onChange(async (value) => {
						this.plugin.settings.whisperTranscriptFolder =
							value.trim();
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Use year/month subfolders")
			.setDesc(
				"Organize imported files into YYYY/MM folders based on the recording date."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.whisperUseDateFolders)
					.onChange(async (value) => {
						this.plugin.settings.whisperUseDateFolders = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auto-create note")
			.setDesc(
				"After importing, create a Markdown note with an audio-note block referencing the files."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.whisperCreateNote)
					.onChange(async (value) => {
						this.plugin.settings.whisperCreateNote = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Note destination folder")
			.setDesc("Relative path for the Markdown note created after import.")
			.addText((text) =>
				text
					.setPlaceholder("02-meetings")
					.setValue(this.plugin.settings.whisperNoteFolder)
					.onChange(async (value) => {
						this.plugin.settings.whisperNoteFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Calendar view" });
		new Setting(containerEl)
			.setName("Tag colors")
			.setDesc(
				"One entry per line using the format tag:#color. Tags are matched case-insensitively."
			)
			.addTextArea((text) => {
				text.inputEl.rows = 4;
				text.setPlaceholder("job/williams:#4f46e5")
					.setValue(formatColorMap(this.plugin.settings.calendarTagColors))
					.onChange(async (value) => {
						this.plugin.settings.calendarTagColors =
							parseColorMap(value);
						await this.plugin.saveSettings();
					});
			});

		containerEl.createEl("hr");
		containerEl.createDiv(
			"p"
		).textContent = `MP3 files added for transcription:`;
		if (this.plugin.settings.audioNotesApiKey) {
			request({
				url: "https://iszrj6j2vk.execute-api.us-east-1.amazonaws.com/prod/users/files",
				method: "GET",
				headers: {
					"x-api-key": this.plugin.settings.audioNotesApiKey,
				},
				contentType: "application/json",
			}).then((result: string) => {
				const urls: [string, string][] = JSON.parse(result);
				if (urls.length > 0) {
					const table = containerEl.createEl("table");
					const tr = table.createEl("tr");
					tr.createEl("th").textContent = "Status";
					tr.createEl("th").textContent = "Length";
					tr.createEl("th").textContent = "URL";
					for (let i = 0; i < urls.length; i++) {
						const [url, status] = urls[i];
						const tr = table.createEl("tr");
						tr.createEl("td").textContent = status;
						const lengthTd = tr.createEl("td");
						lengthTd.textContent = "???";
						tr.createEl("td").textContent = url;

						request({
							url: "https://iszrj6j2vk.execute-api.us-east-1.amazonaws.com/prod/transcriptions",
							method: "GET",
							headers: {
								"x-api-key":
									this.plugin.settings.audioNotesApiKey,
								url: url,
							},
							contentType: "application/json",
						}).then((result: string) => {
							const transcript = JSON.parse(result);
							const lastSegment =
								transcript.segments[
									transcript.segments.length - 1
								];
							lengthTd.textContent = secondsToTimeString(
								lastSegment.end,
								true
							);
						});
					}
				}
			});
		}
	}
}

function formatColorMap(map: Record<string, string> = {}): string {
	return Object.entries(map)
		.map(([tag, color]) => `${tag}:${color}`)
		.join("\n");
}

function parseColorMap(input: string): Record<string, string> {
	const result: Record<string, string> = {};
	if (!input) {
		return result;
	}
	for (const rawLine of input.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}
		const [tag, color] = line.split(":");
		if (!tag || !color) continue;
		const normalizedTag = tag.trim().toLowerCase();
		const normalizedColor = color.trim();
		if (!normalizedTag || !normalizedColor) continue;
		result[normalizedTag] = normalizedColor;
	}
	return result;
}

export interface StringifiedAudioNotesSettings {
	plusDuration: string;
	minusDuration: string;
	backwardStep: string;
	forwardStep: string;
	audioNotesApiKey: string;
	debugMode: boolean;
	DGApiKey: string;
	DGTranscriptFolder: string;
	whisperAudioFolder: string;
	whisperTranscriptFolder: string;
	whisperUseDateFolders: boolean;
	whisperCreateNote: boolean;
	whisperNoteFolder: string;
	calendarTagColors: Record<string, string>;
}

const DEFAULT_SETTINGS: StringifiedAudioNotesSettings = {
	plusDuration: "30",
	minusDuration: "30",
	backwardStep: "5",
	forwardStep: "15",
	audioNotesApiKey: "",
	debugMode: false,
	DGApiKey: "",
	DGTranscriptFolder: "transcripts/",
	whisperAudioFolder: "MediaArchive/audio",
	whisperTranscriptFolder: "transcripts",
	whisperUseDateFolders: true,
	whisperCreateNote: true,
	whisperNoteFolder: "02-meetings",
	calendarTagColors: {},
};

export class AudioNotesSettings {
	constructor(
		private _plusDuration: number,
		private _minusDuration: number,
		private _backwardStep: number,
		private _forwardStep: number,
		private _audioNotesApiKey: string,
		private _debugMode: boolean,
		private _DGApiKey: string,
		private _DGTranscriptFolder: string,
		private _whisperAudioFolder: string,
		private _whisperTranscriptFolder: string,
		private _whisperUseDateFolders: boolean,
		private _whisperCreateNote: boolean,
		private _whisperNoteFolder: string,
		private _calendarTagColors: Record<string, string>,
	) {}

	static fromDefaultSettings(): AudioNotesSettings {
		return new AudioNotesSettings(
			parseFloat(DEFAULT_SETTINGS.plusDuration),
			parseFloat(DEFAULT_SETTINGS.minusDuration),
			parseFloat(DEFAULT_SETTINGS.backwardStep),
			parseFloat(DEFAULT_SETTINGS.forwardStep),
			DEFAULT_SETTINGS.audioNotesApiKey,
			DEFAULT_SETTINGS.debugMode,
			DEFAULT_SETTINGS.DGApiKey,
			DEFAULT_SETTINGS.DGTranscriptFolder,
			DEFAULT_SETTINGS.whisperAudioFolder,
			DEFAULT_SETTINGS.whisperTranscriptFolder,
			DEFAULT_SETTINGS.whisperUseDateFolders,
			DEFAULT_SETTINGS.whisperCreateNote,
			DEFAULT_SETTINGS.whisperNoteFolder,
			DEFAULT_SETTINGS.calendarTagColors,
		);
	}

	static overrideDefaultSettings(
		data: AudioNotesSettings
	): AudioNotesSettings {
		const settings = AudioNotesSettings.fromDefaultSettings();
		if (!data) {
			return settings;
		}
		if (
			data.plusDuration !== null &&
			data.plusDuration !== undefined
		) {
			settings.plusDuration = data.plusDuration!;
		}
		if (
			data.minusDuration !== null &&
			data.minusDuration !== undefined
		) {
			settings.minusDuration = data.minusDuration!;
		}
		if (data.backwardStep !== null && data.backwardStep !== undefined) {
			settings.backwardStep = data.backwardStep!;
		}
		if (data.forwardStep !== null && data.forwardStep !== undefined) {
			settings.forwardStep = data.forwardStep!;
		}
		if (
			data.audioNotesApiKey !== null &&
			data.audioNotesApiKey !== undefined
		) {
			settings.audioNotesApiKey = data.audioNotesApiKey!;
		}
		if (data.debugMode !== null && data.debugMode !== undefined) {
			settings.debugMode = data.debugMode!;
		}
		if (data.DGApiKey !== null && data.DGApiKey !== undefined) {
			settings.DGApiKey = data.DGApiKey!;
		}
		if (
			data.DGTranscriptFolder !== null &&
			data.DGTranscriptFolder !== undefined
		) {
			settings.DGTranscriptFolder = data.DGTranscriptFolder!;
		}
		if (
			data.whisperAudioFolder !== null &&
			data.whisperAudioFolder !== undefined
		) {
			settings.whisperAudioFolder = data.whisperAudioFolder!;
		}
		if (
			data.whisperTranscriptFolder !== null &&
			data.whisperTranscriptFolder !== undefined
		) {
			settings.whisperTranscriptFolder = data.whisperTranscriptFolder!;
		}
		if (
			data.whisperUseDateFolders !== null &&
			data.whisperUseDateFolders !== undefined
		) {
			settings.whisperUseDateFolders = data.whisperUseDateFolders!;
		}
		if (
			data.whisperCreateNote !== null &&
			data.whisperCreateNote !== undefined
		) {
			settings.whisperCreateNote = data.whisperCreateNote!;
		}
		if (
			data.whisperNoteFolder !== null &&
			data.whisperNoteFolder !== undefined
		) {
			settings.whisperNoteFolder = data.whisperNoteFolder!;
		}
		if (
			data.calendarTagColors !== null &&
			data.calendarTagColors !== undefined
		) {
			settings.calendarTagColors = data.calendarTagColors!;
		}
		return settings;
	}

	get plusDuration(): number {
		return this._plusDuration;
	}

	set plusDuration(value: number | string) {
		if (typeof value === "string") {
			value = parseFloat(value);
		}
		this._plusDuration = value;
	}

	get minusDuration(): number {
		return this._minusDuration;
	}

	set minusDuration(value: number | string) {
		if (typeof value === "string") {
			value = parseFloat(value);
		}
		this._minusDuration = value;
	}

	get backwardStep(): number {
		return this._backwardStep;
	}

	set backwardStep(value: number | string) {
		if (typeof value === "string") {
			value = parseFloat(value);
		}
		this._backwardStep = value;
	}

	get forwardStep(): number {
		return this._forwardStep;
	}

	set forwardStep(value: number | string) {
		if (typeof value === "string") {
			value = parseFloat(value);
		}
		this._forwardStep = value;
	}

	get audioNotesApiKey(): string {
		return this._audioNotesApiKey;
	}

	set audioNotesApiKey(value: string) {
		this._audioNotesApiKey = value;
	}

	get debugMode(): boolean {
		return this._debugMode;
	}

	set debugMode(value: boolean) {
		this._debugMode = value;
	}

	get DGApiKey(): string {
		return this._DGApiKey;
	}

	set DGApiKey(value: string) {
		this._DGApiKey = value;
	}

	get DGTranscriptFolder(): string {
		return this._DGTranscriptFolder;
	}

	set DGTranscriptFolder(value: string) {
		this._DGTranscriptFolder = value;
	}

	get whisperAudioFolder(): string {
		return this._whisperAudioFolder;
	}

	set whisperAudioFolder(value: string) {
		this._whisperAudioFolder = value;
	}

	get whisperTranscriptFolder(): string {
		return this._whisperTranscriptFolder;
	}

	set whisperTranscriptFolder(value: string) {
		this._whisperTranscriptFolder = value;
	}

	get whisperUseDateFolders(): boolean {
		return this._whisperUseDateFolders;
	}

	set whisperUseDateFolders(value: boolean) {
		this._whisperUseDateFolders = value;
	}

	get whisperCreateNote(): boolean {
		return this._whisperCreateNote;
	}

	set whisperCreateNote(value: boolean) {
		this._whisperCreateNote = value;
	}

	get whisperNoteFolder(): string {
		return this._whisperNoteFolder;
	}

	set whisperNoteFolder(value: string) {
		this._whisperNoteFolder = value;
	}

	get calendarTagColors(): Record<string, string> {
		return this._calendarTagColors || {};
	}

	set calendarTagColors(value: Record<string, string>) {
		this._calendarTagColors = value || {};
	}

	async getInfoByApiKey(): Promise<ApiKeyInfo | undefined> {
		const apiKey = this.audioNotesApiKey;
		if (apiKey) {
			const infoString: string = await request({
				url: "https://iszrj6j2vk.execute-api.us-east-1.amazonaws.com/prod/users/byapikey",
				method: "GET",
				headers: {
					"x-api-key": this.audioNotesApiKey,
				},
				contentType: "application/json",
			});
			return JSON.parse(infoString) as ApiKeyInfo;
		} else {
			return undefined;
		}
	}
}
