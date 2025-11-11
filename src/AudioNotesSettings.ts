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
import { ensureDashboardNote } from "./dashboard";

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

		containerEl.createEl("h2", { text: "Meeting note template" });
		new Setting(containerEl)
			.setName("Enable structured template")
			.setDesc(
				"Adds Rainbell-style frontmatter, quick links, and agenda blocks whenever the plugin creates a meeting note. Disable to fall back to the classic single callout."
			)
			.addToggle((toggle: ToggleComponent) =>
				toggle
					.setValue(this.plugin.settings.meetingTemplateEnabled)
					.onChange(async (value) => {
						this.plugin.settings.meetingTemplateEnabled = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		const templateDisabled = !this.plugin.settings.meetingTemplateEnabled;

		new Setting(containerEl)
			.setName("Link to daily note")
			.setDesc(
				`Insert a [[${this.plugin.settings.periodicDailyNoteFormat}]] shortcut (matches Periodic Notes).`
			)
			.setDisabled(templateDisabled)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.periodicDailyNoteEnabled)
					.onChange(async (value) => {
						this.plugin.settings.periodicDailyNoteEnabled = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Daily note format")
			.setDesc("Tokens: YYYY, MM, DD, WW (ISO week), gggg (ISO week-year).")
			.setDisabled(
				templateDisabled || !this.plugin.settings.periodicDailyNoteEnabled
			)
			.addText((text) =>
				text
					.setPlaceholder("YYYY-MM-DD")
					.setValue(this.plugin.settings.periodicDailyNoteFormat)
					.setDisabled(
						templateDisabled ||
							!this.plugin.settings.periodicDailyNoteEnabled
					)
					.onChange(async (value) => {
						this.plugin.settings.periodicDailyNoteFormat =
							value || "YYYY-MM-DD";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Link to weekly note")
			.setDesc(
				`Insert a weekly [[${this.plugin.settings.periodicWeeklyNoteFormat}]] reference so recordings land inside your periodic review.`
			)
			.setDisabled(templateDisabled)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.periodicWeeklyNoteEnabled)
					.onChange(async (value) => {
						this.plugin.settings.periodicWeeklyNoteEnabled = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Weekly note format")
			.setDesc("Tokens: YYYY, MM, DD, WW, gggg. Example: gggg-'W'WW")
			.setDisabled(
				templateDisabled || !this.plugin.settings.periodicWeeklyNoteEnabled
			)
			.addText((text) =>
				text
					.setPlaceholder("gggg-'W'WW")
					.setValue(this.plugin.settings.periodicWeeklyNoteFormat)
					.setDisabled(
						templateDisabled ||
							!this.plugin.settings.periodicWeeklyNoteEnabled
					)
					.onChange(async (value) => {
						this.plugin.settings.periodicWeeklyNoteFormat =
							value || "gggg-'W'WW";
						await this.plugin.saveSettings();
					})
			);

		const templateHint = containerEl.createEl("p");
		templateHint.createSpan({
			text: `Need different formats? Match them to your Periodic Notes plugin names (e.g. "YYYY年WW周记录").`,
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
			.setName("Transcript Folder (Deepgram / Scriberr)")
			.setDesc(
				"The folder your transcripts will be saved in when using Deepgram or Scriberr."
			)
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
			text: "Scriberr Settings",
		});
		new Setting(containerEl)
			.setName("Scriberr Base URL")
			.setDesc(
				"Defaults to https://localhost:8080/api/v1 when running Scriberr locally."
			)
			.addText((text) =>
				text
					.setPlaceholder("https://localhost:8080/api/v1")
					.setValue(this.plugin.settings.scriberrBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.scriberrBaseUrl =
							value || DEFAULT_SETTINGS.scriberrBaseUrl;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Scriberr API Key")
			.setDesc(
				"Create an API key inside Scriberr and paste it here to authenticate via X-API-Key."
			)
			.addText((text) =>
				text
					.setPlaceholder("Enter your API key…")
					.setValue(this.plugin.settings.scriberrApiKey)
					.onChange(async (value) => {
						this.plugin.settings.scriberrApiKey = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Default Scriberr Profile")
			.setDesc(
				"Optional profile name to apply when submitting jobs (matches Scriberr transcription profiles)."
			)
			.addText((text) =>
				text
					.setPlaceholder("leave blank to use server defaults")
					.setValue(this.plugin.settings.scriberrProfileName)
					.onChange(async (value) => {
						this.plugin.settings.scriberrProfileName = value;
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
			.setName("Pin calendar in right sidebar")
			.setDesc(
				"Keep the Audio Notes calendar docked next to your working notes. Disable if you prefer to open it manually."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.calendarSidebarPinned)
					.onChange(async (value) => {
						this.plugin.settings.calendarSidebarPinned = value;
						await this.plugin.saveSettings();
						await this.plugin.syncCalendarSidebar(value);
					})
			);
		new Setting(containerEl)
			.setName("Store meeting attachments with the note")
			.setDesc(
				"When enabled, new attachments dropped into a meeting note are automatically moved into the same folder as that note."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.storeAttachmentsWithMeeting)
					.onChange(async (value) => {
						this.plugin.settings.storeAttachmentsWithMeeting = value;
						await this.plugin.saveSettings();
					})
			);
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

		containerEl.createEl("h3", { text: "Dashboard" });
		new Setting(containerEl)
			.setName("Dashboard note path")
			.setDesc(
				"Path to the Dataview dashboard that lists upcoming meetings and open tasks."
			)
			.addText((text) =>
				text
					.setPlaceholder("Audio Notes Dashboard.md")
					.setValue(this.plugin.settings.dashboardNotePath)
					.onChange(async (value) => {
						this.plugin.settings.dashboardNotePath =
							value?.trim() || "Audio Notes Dashboard.md";
						await this.plugin.saveSettings();
					})
			)
			.addExtraButton((button) =>
				button
					.setIcon("refresh-ccw")
					.setTooltip("Create or refresh the dashboard note now")
					.onClick(async () => {
						try {
							const result = await ensureDashboardNote(this.plugin, true);
							new Notice(result);
						} catch (error) {
							console.error(error);
							new Notice("Could not update dashboard note");
						}
					})
			);

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
	scriberrBaseUrl: string;
	scriberrApiKey: string;
	scriberrProfileName: string;
	storeAttachmentsWithMeeting: boolean;
	whisperAudioFolder: string;
	whisperTranscriptFolder: string;
	whisperUseDateFolders: boolean;
	whisperCreateNote: boolean;
	whisperNoteFolder: string;
	calendarTagColors: Record<string, string>;
	meetingTemplateEnabled: boolean;
	periodicDailyNoteEnabled: boolean;
	periodicDailyNoteFormat: string;
	periodicWeeklyNoteEnabled: boolean;
	periodicWeeklyNoteFormat: string;
	calendarSidebarPinned: boolean;
	dashboardNotePath: string;
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
	scriberrBaseUrl: "https://localhost:8080/api/v1",
	scriberrApiKey: "",
	scriberrProfileName: "",
	storeAttachmentsWithMeeting: false,
	whisperAudioFolder: "MediaArchive/audio",
	whisperTranscriptFolder: "transcripts",
	whisperUseDateFolders: true,
	whisperCreateNote: true,
	whisperNoteFolder: "02-meetings",
	calendarTagColors: {},
	meetingTemplateEnabled: true,
	periodicDailyNoteEnabled: true,
	periodicDailyNoteFormat: "YYYY-MM-DD",
	periodicWeeklyNoteEnabled: true,
	periodicWeeklyNoteFormat: "gggg-'W'WW",
	calendarSidebarPinned: false,
	dashboardNotePath: "Audio Notes Dashboard.md",
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
		private _scriberrBaseUrl: string,
		private _scriberrApiKey: string,
		private _scriberrProfileName: string,
		private _storeAttachmentsWithMeeting: boolean,
		private _whisperAudioFolder: string,
		private _whisperTranscriptFolder: string,
		private _whisperUseDateFolders: boolean,
		private _whisperCreateNote: boolean,
		private _whisperNoteFolder: string,
		private _calendarTagColors: Record<string, string>,
		private _meetingTemplateEnabled: boolean,
		private _periodicDailyNoteEnabled: boolean,
		private _periodicDailyNoteFormat: string,
		private _periodicWeeklyNoteEnabled: boolean,
		private _periodicWeeklyNoteFormat: string,
		private _calendarSidebarPinned: boolean,
		private _dashboardNotePath: string,
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
			DEFAULT_SETTINGS.scriberrBaseUrl,
			DEFAULT_SETTINGS.scriberrApiKey,
			DEFAULT_SETTINGS.scriberrProfileName,
			DEFAULT_SETTINGS.storeAttachmentsWithMeeting,
			DEFAULT_SETTINGS.whisperAudioFolder,
			DEFAULT_SETTINGS.whisperTranscriptFolder,
			DEFAULT_SETTINGS.whisperUseDateFolders,
			DEFAULT_SETTINGS.whisperCreateNote,
			DEFAULT_SETTINGS.whisperNoteFolder,
			DEFAULT_SETTINGS.calendarTagColors,
			DEFAULT_SETTINGS.meetingTemplateEnabled,
			DEFAULT_SETTINGS.periodicDailyNoteEnabled,
			DEFAULT_SETTINGS.periodicDailyNoteFormat,
			DEFAULT_SETTINGS.periodicWeeklyNoteEnabled,
			DEFAULT_SETTINGS.periodicWeeklyNoteFormat,
			DEFAULT_SETTINGS.calendarSidebarPinned,
			DEFAULT_SETTINGS.dashboardNotePath,
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
			data.scriberrBaseUrl !== null &&
			data.scriberrBaseUrl !== undefined
		) {
			settings.scriberrBaseUrl = data.scriberrBaseUrl!;
		}
		if (
			data.scriberrApiKey !== null &&
			data.scriberrApiKey !== undefined
		) {
			settings.scriberrApiKey = data.scriberrApiKey!;
		}
		if (
			data.scriberrProfileName !== null &&
			data.scriberrProfileName !== undefined
		) {
			settings.scriberrProfileName = data.scriberrProfileName!;
		}
		if (
			data.storeAttachmentsWithMeeting !== null &&
			data.storeAttachmentsWithMeeting !== undefined
		) {
			settings.storeAttachmentsWithMeeting =
				data.storeAttachmentsWithMeeting!;
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
		if (
			data.meetingTemplateEnabled !== null &&
			data.meetingTemplateEnabled !== undefined
		) {
			settings.meetingTemplateEnabled = data.meetingTemplateEnabled!;
		}
		if (
			data.periodicDailyNoteEnabled !== null &&
			data.periodicDailyNoteEnabled !== undefined
		) {
			settings.periodicDailyNoteEnabled = data.periodicDailyNoteEnabled!;
		}
		if (
			data.periodicDailyNoteFormat !== null &&
			data.periodicDailyNoteFormat !== undefined
		) {
			settings.periodicDailyNoteFormat = data.periodicDailyNoteFormat!;
		}
		if (
			data.periodicWeeklyNoteEnabled !== null &&
			data.periodicWeeklyNoteEnabled !== undefined
		) {
			settings.periodicWeeklyNoteEnabled = data.periodicWeeklyNoteEnabled!;
		}
		if (
			data.periodicWeeklyNoteFormat !== null &&
			data.periodicWeeklyNoteFormat !== undefined
		) {
			settings.periodicWeeklyNoteFormat = data.periodicWeeklyNoteFormat!;
		}
		if (
			data.calendarSidebarPinned !== null &&
			data.calendarSidebarPinned !== undefined
		) {
			settings.calendarSidebarPinned = data.calendarSidebarPinned!;
		}
		if (
			data.dashboardNotePath !== null &&
			data.dashboardNotePath !== undefined
		) {
			settings.dashboardNotePath = data.dashboardNotePath!;
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

	get scriberrBaseUrl(): string {
		return this._scriberrBaseUrl || DEFAULT_SETTINGS.scriberrBaseUrl;
	}

	set scriberrBaseUrl(value: string) {
		this._scriberrBaseUrl = (value || "").trim();
	}

	get scriberrApiKey(): string {
		return this._scriberrApiKey || "";
	}

	set scriberrApiKey(value: string) {
		this._scriberrApiKey = value?.trim() || "";
	}

	get scriberrProfileName(): string {
		return this._scriberrProfileName || "";
	}

	set scriberrProfileName(value: string) {
		this._scriberrProfileName = value?.trim() || "";
	}

	get storeAttachmentsWithMeeting(): boolean {
		return this._storeAttachmentsWithMeeting;
	}

	set storeAttachmentsWithMeeting(value: boolean) {
		this._storeAttachmentsWithMeeting = Boolean(value);
	}

	get hasScriberrCredentials(): boolean {
		return Boolean(this.scriberrBaseUrl && this.scriberrApiKey);
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

	get meetingTemplateEnabled(): boolean {
		return this._meetingTemplateEnabled;
	}

	set meetingTemplateEnabled(value: boolean) {
		this._meetingTemplateEnabled = value;
	}

	get periodicDailyNoteEnabled(): boolean {
		return this._periodicDailyNoteEnabled;
	}

	set periodicDailyNoteEnabled(value: boolean) {
		this._periodicDailyNoteEnabled = value;
	}

	get periodicDailyNoteFormat(): string {
		return this._periodicDailyNoteFormat;
	}

	set periodicDailyNoteFormat(value: string) {
		this._periodicDailyNoteFormat = value || "YYYY-MM-DD";
	}

	get periodicWeeklyNoteEnabled(): boolean {
		return this._periodicWeeklyNoteEnabled;
	}

	set periodicWeeklyNoteEnabled(value: boolean) {
		this._periodicWeeklyNoteEnabled = value;
	}

	get periodicWeeklyNoteFormat(): string {
		return this._periodicWeeklyNoteFormat;
	}

	set periodicWeeklyNoteFormat(value: string) {
		this._periodicWeeklyNoteFormat = value || "gggg-'W'WW";
	}

	get calendarSidebarPinned(): boolean {
		return this._calendarSidebarPinned;
	}

	set calendarSidebarPinned(value: boolean) {
		this._calendarSidebarPinned = value;
	}

	get dashboardNotePath(): string {
		return this._dashboardNotePath;
	}

	set dashboardNotePath(value: string) {
		this._dashboardNotePath = value || "Audio Notes Dashboard.md";
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
