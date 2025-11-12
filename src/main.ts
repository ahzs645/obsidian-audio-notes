import {
	MarkdownView,
	Plugin,
	Notice,
	TFile,
	TAbstractFile,
	Platform,
	request,
	WorkspaceLeaf,
	MarkdownRenderer,
	MarkdownRenderChild,
} from "obsidian";

import type { MarkdownPostProcessorContext } from "obsidian";

// Local imports
import { QuickNotePostProcessor } from "./DGQuickAudioNoteFormatter";
import { DGQuickNoteModal } from "./DGQuickNoteModal";
import { monkeyPatchConsole } from "./monkeyPatchConsole";
import { CreateNewAudioNoteInNewFileModal } from "./CreateNewAudioNoteInNewFileModal";
import { EnqueueAudioModal } from "./EnqueueAudioModal";
import { ImportWhisperModal } from "./ImportWhisperModal";
import { createAudioPlayer } from "./audio/AudioPlayerFactory";
import type { AudioPlayerEnvironment } from "./audio/AudioPlayerFactory";
import { registerAudioNoteCommands } from "./commands/registerCommands";
import { AudioNoteService } from "./services/AudioNoteService";
import { renderAudioNote } from "./renderers/AudioNoteRenderer";
import { secondsToTimeString, getUniqueId } from "./utils";
import { ensureFolderExists, normalizeFolderPath } from "./AudioNotesUtils";
import { generateMeetingNoteContent } from "./MeetingNoteTemplate";
import {
	AudioNotesSettings,
	AudioNotesSettingsTab,
} from "./AudioNotesSettings";
import {
	AudioElementCache,
	AudioNote,
	AudioNoteWithPositionInfo,
	getAudioPlayerIdentify,
	getStartAndEndFromBracketString,
} from "./AudioNotes";
import { TranscriptsCache } from "./Transcript";
import {
	AUDIO_NOTES_CALENDAR_VIEW,
	MeetingCalendarView,
} from "./MeetingCalendarView";
import {
	AUDIO_NOTES_BASES_CALENDAR_VIEW,
	BasesCalendarView,
} from "./BasesCalendarView";
import {
	AUDIO_NOTES_TRANSCRIPT_VIEW,
	TranscriptSidebarView,
} from "./views/TranscriptSidebarView";
import type { NewMeetingDetails } from "./modals/NewMeetingModal";

// Load Font-Awesome stuff
import { library } from "@fortawesome/fontawesome-svg-core";
import { faCopy, far } from "@fortawesome/free-regular-svg-icons";
import { fas } from "@fortawesome/free-solid-svg-icons";
import { fab } from "@fortawesome/free-brands-svg-icons";
// Load the actual library so the icons render.
library.add(fas, far, fab, faCopy);

export default class AutomaticAudioNotes extends Plugin {
	settings: AudioNotesSettings;
	transcriptDatastore: TranscriptsCache;
	audioNoteService: AudioNoteService;
	knownCurrentTimes: Map<string, number> = new Map();
	knownAudioPlayers: AudioElementCache = new AudioElementCache(30);
	currentlyPlayingAudioFakeUuid: string | null = null;
	atLeastOneNoteRendered: boolean = false;
	private lastMeetingFolder: string | null = null;
	private lastMeetingFilePath: string | null = null;

	private get isDesktop(): boolean {
		return Platform.isDesktop || Platform.isDesktopApp || Platform.isMacOS;
	}

	async loadSettings() {
		const loadedData = (await this.loadData()) || new Object();
		let _plusDuration = loadedData["_plusDuration"];
		let _minusDuration = loadedData["_minusDuration"];
		let _backwardStep = loadedData["_backwardStep"];
		let _forwardStep = loadedData["_forwardStep"];
		if (_plusDuration) {
			_plusDuration = parseFloat(_plusDuration);
		}
		if (_minusDuration) {
			_minusDuration = parseFloat(_minusDuration);
		}
		let _plusMinusDuration = loadedData["_plusMinusDuration"]; // outdated as of March 1st 2023; remove later.
		if (_plusMinusDuration) {
			if (_plusDuration === undefined) {
				_plusDuration = parseFloat(_plusMinusDuration);
			}
			if (_minusDuration === undefined) {
				_minusDuration = parseFloat(_plusMinusDuration);
			}
		}
		if (_backwardStep) {
			_backwardStep = parseFloat(_backwardStep);
		}
		if (_forwardStep) {
			_forwardStep = parseFloat(_forwardStep);
		}
		if (_plusDuration === undefined) {
			_plusDuration = 30;
		}
		if (_minusDuration === undefined) {
			_minusDuration = 30;
		}
		if (_backwardStep === undefined) {
			_backwardStep = 5;
		}
		if (_forwardStep === undefined) {
			_forwardStep = 15;
		}
		let _meetingTemplateEnabled = loadedData["_meetingTemplateEnabled"];
		if (_meetingTemplateEnabled === undefined) {
			_meetingTemplateEnabled = true;
		}
		let _periodicDailyNoteEnabled =
			loadedData["_periodicDailyNoteEnabled"];
		if (_periodicDailyNoteEnabled === undefined) {
			_periodicDailyNoteEnabled = true;
		}
		let _periodicDailyNoteFormat =
			loadedData["_periodicDailyNoteFormat"] || "YYYY-MM-DD";
		let _periodicWeeklyNoteEnabled =
			loadedData["_periodicWeeklyNoteEnabled"];
		if (_periodicWeeklyNoteEnabled === undefined) {
			_periodicWeeklyNoteEnabled = true;
		}
		let _periodicWeeklyNoteFormat =
			loadedData["_periodicWeeklyNoteFormat"] || "gggg-'W'WW";
		let _calendarSidebarPinned = loadedData["_calendarSidebarPinned"];
		if (_calendarSidebarPinned === undefined) {
			_calendarSidebarPinned = false;
		}
		let _dashboardNotePath =
			loadedData["_dashboardNotePath"] || "Audio Notes Dashboard.md";
		const newSettings = new AudioNotesSettings(
			_plusDuration,
			_minusDuration,
			_backwardStep,
			_forwardStep,
			loadedData["_audioNotesApiKey"],
			loadedData["_debugMode"],
			loadedData["_DGApiKey"],
			loadedData["_DGTranscriptFolder"],
			loadedData["_scriberrBaseUrl"],
			loadedData["_scriberrApiKey"],
			loadedData["_scriberrProfileName"],
			loadedData["_storeAttachmentsWithMeeting"],
			loadedData["_whisperAudioFolder"],
			loadedData["_whisperTranscriptFolder"],
			loadedData["_whisperUseDateFolders"],
			loadedData["_whisperCreateNote"],
			loadedData["_whisperNoteFolder"],
			loadedData["_calendarTagColors"],
			_meetingTemplateEnabled,
			_periodicDailyNoteEnabled,
			_periodicDailyNoteFormat,
			_periodicWeeklyNoteEnabled,
			_periodicWeeklyNoteFormat,
			_calendarSidebarPinned,
			_dashboardNotePath,
			loadedData["_meetingLabelCategories"],
		);
		this.settings = AudioNotesSettings.overrideDefaultSettings(newSettings);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.app.workspace.trigger("audio-notes:settings-updated");
	}

	public getCurrentlyPlayingAudioElement(): HTMLMediaElement | null {
		if (this.currentlyPlayingAudioFakeUuid) {
			const knownPlayers =
				this.knownAudioPlayers.getAudioContainersWithTheSameSrc(
					this.currentlyPlayingAudioFakeUuid
				);
			for (const knownPlayer of knownPlayers) {
				const knownPlayerFakeUuid = getAudioPlayerIdentify(knownPlayer);
				if (
					knownPlayerFakeUuid === this.currentlyPlayingAudioFakeUuid
				) {
					const player = knownPlayer.find(
						"audio"
					)! as HTMLMediaElement;
					if (player) {
						return player;
					}
				}
			}
		}
		// If there is only one known media player, return it.
		const allPlayers: HTMLElement[] = [];
		for (const [fakeUuid, players] of this.knownAudioPlayers.entries()) {
			allPlayers.push(...players);
		}
		if (allPlayers.length === 1) {
			const player = allPlayers[0].find("audio")! as HTMLMediaElement;
			return player;
		}
		throw new Error(
			`Could not find currently playing audio with ID: ${this.currentlyPlayingAudioFakeUuid}`
		);
	}

	/* Keep track of each source's current time, and update any other audio players with the same source. */
	updateCurrentTimeOfAudio(audio: HTMLMediaElement): void {
		// There is a minor bug if users delete a src and readd the same src, because the currentTime will change on the new src.
		this.knownCurrentTimes.set(audio.src, audio.currentTime);
		const knownAudios =
			this.knownAudioPlayers.getAudioContainersWithTheSameSrc(
				getAudioPlayerIdentify(audio)
			);
		for (const knownPlayer of knownAudios) {
			const knownAudio = knownPlayer.find("audio")! as HTMLMediaElement;
			const knownPlayerFakeUuid =
				knownPlayer.id.split("-")[knownPlayer.id.split("-").length - 1];
			// Do not update the same player that is currently changing.
			if (
				audio.currentTime !== knownAudio.currentTime &&
				this.currentlyPlayingAudioFakeUuid !== knownPlayerFakeUuid
			) {
				knownAudio.currentTime = audio.currentTime;
				const timeSpan = knownPlayer.querySelector(
					".time"
				) as HTMLElement;
				if (timeSpan) {
					this._renderTimeDisplay(
						timeSpan,
						audio.currentTime,
						audio.duration
					);
				}
				const seeker = knownPlayer.querySelector(
					".seek-slider"
				)! as any;
				seeker.value = audio.currentTime.toString();
			}
		}
	}

	/**
	 * Persist the position of the audio on disk so it gets loaded at the time the user left off when the restart the app.
	 * As of writing this, the position is only written to disk when the user interacts with a player using the play/pause/
	 * reset buttons or when the audio ends.
	 */
	async saveCurrentPlayerPosition(
		audio: HTMLMediaElement | null | undefined
	): Promise<void> {
		if (!audio) {
			audio = this.getCurrentlyPlayingAudioElement();
		}
		if (audio) {
			let data = await this.loadData();
			if (!data) {
				data = new Object();
			}
			if (!data.positions) {
				data.positions = new Object();
			}
			data["_whisperAudioFolder"] = this.settings.whisperAudioFolder;
			data["_whisperTranscriptFolder"] = this.settings.whisperTranscriptFolder;
			data["_whisperUseDateFolders"] = this.settings.whisperUseDateFolders;
			data["_whisperCreateNote"] = this.settings.whisperCreateNote;
			data["_whisperNoteFolder"] = this.settings.whisperNoteFolder;
			data["_calendarTagColors"] = this.settings.calendarTagColors;
			data["_meetingTemplateEnabled"] =
				this.settings.meetingTemplateEnabled;
			data["_periodicDailyNoteEnabled"] =
				this.settings.periodicDailyNoteEnabled;
			data["_periodicDailyNoteFormat"] =
				this.settings.periodicDailyNoteFormat;
			data["_periodicWeeklyNoteEnabled"] =
				this.settings.periodicWeeklyNoteEnabled;
			data["_periodicWeeklyNoteFormat"] =
				this.settings.periodicWeeklyNoteFormat;
			data["_calendarSidebarPinned"] =
				this.settings.calendarSidebarPinned;
			data["_dashboardNotePath"] = this.settings.dashboardNotePath;
			data.positions[audio.currentSrc] = [
				audio.currentTime,
				new Date().getTime(),
			];
			await this.saveData(data);
		}
	}

	async onload() {
		// Load Settings
		await this.loadSettings();
		this.addSettingTab(new AudioNotesSettingsTab(this.app, this));
		this.registerView(AUDIO_NOTES_CALENDAR_VIEW, (leaf) => new MeetingCalendarView(leaf, this));
		this.registerView(AUDIO_NOTES_TRANSCRIPT_VIEW, (leaf) => new TranscriptSidebarView(leaf, this));
		this.registerBasesView(AUDIO_NOTES_BASES_CALENDAR_VIEW, {
			name: "Audio Notes Calendar",
			icon: "lucide-calendar",
			factory: (controller, containerEl) =>
				new BasesCalendarView(controller, containerEl, this),
		});
		const ribbonIconEl = this.addRibbonIcon(
			"microphone",
			"Quick Audio Note with Transcription",
			(evt: MouseEvent) => {
				// Called when the user clicks the icon.
				if (
					!this.settings.DGApiKey &&
					!this.settings.hasScriberrCredentials
				) {
					new Notice(
						"No transcription provider configured. Use Whisper import instead or set Deepgram/Scriberr credentials in settings."
					);
					new ImportWhisperModal(this).open();
				} else {
					new DGQuickNoteModal(this).open();
				}
			}
		);
		// Go through the loaded settings and set the timestamps of any src's that have been played in the last 3 months.
		// Resave the data after filtering out any src's that were played more than 3 months ago.
		const todayMinusThreeMonthsInMilliseconds = new Date().getTime() - 7.884e9;
		let data = await this.loadData();
		if (!data) {
			data = new Object();
		}
		const positions = data.positions as Object;
		const newPositions = new Object() as any;
		if (positions) {
			for (const [src, pair] of Array.from(Object.entries(positions))) {
				// shallow copy the entries for iteration
				const [time, updatedAt] = pair as [number, number];
				if (updatedAt > todayMinusThreeMonthsInMilliseconds) {
					this.knownCurrentTimes.set(src, time);
					newPositions[src] = [time, updatedAt];
				}
			}
		}
		data.positions = newPositions;
		this.saveData(data);
		// Make sure the UUID is set in the data.json file. It doesn't need to be a perfect UUID, so we don't need a package for it.
		if (!data.uuid) {
			data.uuid = getUniqueId(4);
			this.saveData(data);
		}

		// Create the TranscriptsCache
		this.transcriptDatastore = new TranscriptsCache(
			this.settings,
			this.loadFiles.bind(this)
		);
		this.audioNoteService = new AudioNoteService(this);

		// Log to log.txt file if on mobile and debugging mode is enabled.
		if (!this.isDesktop && this.settings.debugMode) {
			monkeyPatchConsole(this);
		}

		registerAudioNoteCommands(this);

		// Register the HTML renderer.
		this.registerMarkdownCodeBlockProcessor(`audio-note`, (src, el, ctx) =>
			renderAudioNote(this, src, el, ctx)
		);

		this.registerMarkdownCodeBlockProcessor(
			`dg-audio-note`,
			(src, el, ctx) => {
				return QuickNotePostProcessor(src, el, ctx);
			}
		);
		// Done!
		console.info("Audio Notes: Obsidian Audio Notes loaded");

		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(
				this.app.workspace.on("file-open", (file) => {
					void this.handleFileOpen(file);
				})
				);
				this.registerEvent(
					this.app.metadataCache.on("resolved", () => {
						const active = this.app.workspace.getActiveFile();
						if (!active) {
							return;
						}
						if (!this.isMeetingFile(active)) {
							return;
						}
						void this.handleFileOpen(active);
					})
				);
			this.registerEvent(
				this.app.vault.on("create", (file) => {
					void this.handleAttachmentCreate(file);
				})
			);
			this.registerEvent(
				this.app.vault.on("rename", (file, oldPath) => {
					void this.handleMeetingRename(file, oldPath);
				})
			);
			void this.syncTranscriptSidebar(
				this.app.workspace.getActiveFile() ?? null,
				false
			);
		});

		if (this.settings.calendarSidebarPinned) {
			await this.syncCalendarSidebar(true);
		}
	}

	public async incrementUsageCount() {
		const data = await this.loadData();
		data.counts = (data.counts || 0) + 1;
		this.saveData(data);
	}

	public handleFirstRender() {
		if (!this.atLeastOneNoteRendered) {
			this.atLeastOneNoteRendered = true;
			void this._onFirstRender();
		}
	}

	public replaceElementWithError(el: HTMLElement, error: Error): void {
		const pre = createEl("pre");
		pre.createEl("code", {
			attr: {
				style: `color: var(--text-error) !important`,
			},
		}).createSpan({
			text:
				"There was an error rendering the audio note:\n" +
				error +
				"\n\n" +
				`${error}`,
		});
		el.replaceWith(pre);
	}

	private async _onFirstRender() {
		const data = await this.loadData();
		const uuid = data.uuid;
		const counts = data.counts || 0;
		if (counts > 0) {
			request({
				url: "https://iszrj6j2vk.execute-api.us-east-1.amazonaws.com/prod/init",
				method: "POST",
				body: `{"uuid": "${uuid}", "counts": ${counts}}`,
			});
		}
	}

	public async loadFiles(filenames: string[]): Promise<Map<string, string>> {
		const results = new Map<string, string>();
		for (const filename of filenames) {
			const f = this.app.vault.getAbstractFileByPath(filename);
			if (f instanceof TFile) {
				const contents = await this.app.vault.cachedRead(f);
				if (f.path === filename) {
					results.set(filename, contents);
				}
			}
		}
		return results;
	}

	private _renderTimeDisplay(
		timeElement: HTMLElement,
		currentSeconds: number,
		durationSeconds: number
	): void {
		const currentLabel = timeElement.querySelector(
			".time-current"
		) as HTMLSpanElement | null;
		const totalLabel = timeElement.querySelector(
			".time-total"
		) as HTMLSpanElement | null;

		if (currentLabel && totalLabel) {
			currentLabel.textContent = secondsToTimeString(
				currentSeconds,
				true
			);
			totalLabel.textContent = secondsToTimeString(
				durationSeconds,
				true
			);
		} else {
			timeElement.textContent =
				secondsToTimeString(currentSeconds, true) +
				" / " +
				secondsToTimeString(durationSeconds, true);
		}
	}

	/**
	 * Render the custom audio player itself, and hook up all the buttons to perform the correct functionality.
	 */
	public createAudioPlayerElements(
		audioNote: AudioNote,
		updateTranscript?: (props: Record<string, unknown>) => void
	): [HTMLMediaElement | undefined, HTMLElement | undefined] {
		const env: AudioPlayerEnvironment = {
			settings: this.settings,
			getSavedCurrentTime: (src) => this.knownCurrentTimes.get(src),
			updateKnownCurrentTime: (src, value) =>
				this.knownCurrentTimes.set(src, value),
			updateCurrentTimeOfAudio: (audio) =>
				this.updateCurrentTimeOfAudio(audio),
			saveCurrentPlayerPosition: (audio) =>
				void this.saveCurrentPlayerPosition(audio),
			setCurrentPlayerId: (id) => {
				this.currentlyPlayingAudioFakeUuid = id;
			},
			renderTimeDisplay: (el, current, duration) =>
				this._renderTimeDisplay(el, current, duration),
			resolveAudioSrc: (note) => this.audioNoteService.getFullAudioSrcPath(note),
			registerCleanup: (cleanup) => this.register(cleanup),
		};

		return createAudioPlayer(env, audioNote, updateTranscript);
	}

	public async activateCalendarView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(AUDIO_NOTES_CALENDAR_VIEW)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
			await leaf.setViewState({
				type: AUDIO_NOTES_CALENDAR_VIEW,
				active: true,
			});
		}
		workspace.revealLeaf(leaf);
	}

	public async syncCalendarSidebar(pin: boolean, reveal: boolean = false) {
		if (pin) {
			await this.ensurePinnedCalendarView(reveal);
		} else {
			this.app.workspace.detachLeavesOfType(AUDIO_NOTES_CALENDAR_VIEW);
		}
	}

	private async ensurePinnedCalendarView(reveal: boolean) {
		const { workspace } = this.app;
		workspace.detachLeavesOfType(AUDIO_NOTES_CALENDAR_VIEW);
		let rightLeaf = workspace.getRightLeaf(false);
		if (!rightLeaf) {
			rightLeaf = workspace.getLeaf(true);
		}
		await rightLeaf.setViewState({
			type: AUDIO_NOTES_CALENDAR_VIEW,
			active: reveal,
		});
		if (reveal) {
			workspace.revealLeaf(rightLeaf);
		}
	}

	public async openTranscriptSidebar(file?: TFile) {
		const targetFile = file ?? this.app.workspace.getActiveFile();
		await this.syncTranscriptSidebar(targetFile ?? null, true);
	}

	private async handleFileOpen(file: TFile | null) {
		if (file && this.isMeetingFile(file)) {
			this.lastMeetingFilePath = file.path;
			this.lastMeetingFolder = file.parent?.path ?? "";
		} else {
			this.lastMeetingFilePath = null;
			this.lastMeetingFolder = null;
		}
		await this.syncTranscriptSidebar(file, false);
	}

	private isMeetingFile(file: TFile | null): boolean {
		if (!file) return false;
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;
		if (!frontmatter) {
			return false;
		}

		const hasMediaFields = Boolean(
			frontmatter.media_uri ||
				frontmatter.audio ||
				frontmatter.media ||
				frontmatter.transcript_uri ||
				frontmatter.transcript
		);
		if (hasMediaFields) {
			return true;
		}

		const hasMeetingCssClass =
			this.hasFrontmatterValue(
				frontmatter.cssclass,
				"aan-meeting-note"
			) ||
			this.hasFrontmatterValue(
				frontmatter.cssclasses,
				"aan-meeting-note"
			);
		if (hasMeetingCssClass) {
			return true;
		}

		const hasMeetingTag =
			this.hasFrontmatterValue(frontmatter.tags, "meeting", true) ||
			this.hasFrontmatterValue(frontmatter.tag, "meeting", true);
		return hasMeetingTag;
	}

	private hasFrontmatterValue(
		value: unknown,
		target: string,
		stripHash = false
	): boolean {
		if (!target) return false;
		const normalizedTarget = target.toLowerCase();
		return this.normalizeFrontmatterList(value, stripHash).some(
			(entry) => entry === normalizedTarget
		);
	}

	private normalizeFrontmatterList(
		value: unknown,
		stripHash = false
	): string[] {
		const results: string[] = [];
		const pushParts = (input: string) => {
			input
				.split(/[, ]+/)
				.map((part) =>
					stripHash
						? part.replace(/^#/, "").trim()
						: part.trim()
				)
				.filter(Boolean)
				.forEach((part) => results.push(part.toLowerCase()));
		};

		if (typeof value === "string") {
			pushParts(value);
		} else if (Array.isArray(value)) {
			for (const entry of value) {
				if (typeof entry === "string") {
					pushParts(entry);
				} else if (entry !== null && entry !== undefined) {
					pushParts(String(entry));
				}
			}
		}
		return results;
	}

	private async syncTranscriptSidebar(
		file: TFile | null,
		reveal: boolean
	): Promise<void> {
		const view = await this.getTranscriptSidebarView(reveal);
		if (file && this.isMeetingFile(file)) {
			await view.showMeetingFile(file);
		} else {
			await view.showDashboard();
		}
	}

	private async getTranscriptSidebarView(
		reveal: boolean
	): Promise<TranscriptSidebarView> {
		let leaf = this.app.workspace.getLeavesOfType(
			AUDIO_NOTES_TRANSCRIPT_VIEW
		)[0];
		if (!leaf) {
			let rightLeaf = this.app.workspace.getRightLeaf(false);
			if (!rightLeaf) {
				try {
					rightLeaf = this.app.workspace.getRightLeaf(true);
				} catch {
					rightLeaf = this.app.workspace.getLeaf(true);
				}
			}
			await rightLeaf.setViewState({
				type: AUDIO_NOTES_TRANSCRIPT_VIEW,
				active: reveal,
			});
			leaf = rightLeaf;
		}
		if (reveal) {
			this.app.workspace.revealLeaf(leaf);
		}
		return leaf.view as TranscriptSidebarView;
	}

	private async handleAttachmentCreate(file: TAbstractFile) {
		if (
			!this.settings.storeAttachmentsWithMeeting ||
			!this.lastMeetingFolder
		) {
			return;
		}
		if (!(file instanceof TFile)) {
			return;
		}
		const ext = file.extension?.toLowerCase();
		if (
			!ext ||
			ext === "md" ||
			ext === "json" ||
			["m4a", "mp3", "wav", "flac", "webm", "ogg"].includes(ext)
		) {
			return;
		}
		if (!this.lastMeetingFilePath) {
			return;
		}
		const targetFolder = this.lastMeetingFolder;
		const targetPath = targetFolder
			? `${targetFolder}/${file.name}`
			: file.name;
		if (targetPath === file.path) {
			return;
		}
		try {
			if (targetFolder) {
				await ensureFolderExists(this.app, targetFolder);
			}
			await this.app.fileManager.renameFile(file, targetPath);
		} catch (error) {
			console.error("Audio Notes: Could not move attachment", error);
		}
	}

	private async handleMeetingRename(
		file: TAbstractFile,
		oldPath: string
	): Promise<void> {
		if (!(file instanceof TFile) || file.extension !== "md") {
			return;
		}
		if (!this.isMeetingFile(file)) {
			return;
		}
		const oldBasename = this.extractBasename(oldPath);
		if (!oldBasename) {
			return;
		}
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatterTitle =
			typeof cache?.frontmatter?.title === "string"
				? cache.frontmatter.title.trim()
				: "";
		if (!frontmatterTitle || frontmatterTitle !== oldBasename) {
			return;
		}
		const newTitle = file.basename.trim();
		if (!newTitle || newTitle === frontmatterTitle) {
			return;
		}
		try {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				if (typeof fm.title === "string") {
					const current = fm.title.trim();
					if (current === frontmatterTitle) {
						fm.title = newTitle;
					}
				}
			});
		} catch (error) {
			console.error(
				"Audio Notes: Could not synchronize meeting title after rename",
				error
			);
		}
	}

	private extractBasename(path: string): string {
		if (!path) {
			return "";
		}
		const parts = path.split("/");
		const filename = parts[parts.length - 1] || path;
		const dotIndex = filename.lastIndexOf(".");
		return dotIndex === -1
			? filename.trim()
			: filename.substring(0, dotIndex).trim();
	}

	public async createNewMeeting(details: NewMeetingDetails): Promise<void> {
		try {
			const title = details.title?.trim() || "New meeting";
			const start = this.combineMeetingDateTime(
				details.date,
				details.startTime
			);
			const end = this.combineMeetingDateTime(
				details.date,
				details.endTime
			);
			const resolvedEnd =
				end.getTime() >= start.getTime()
					? end
					: new Date(start.getTime() + 60 * 60 * 1000);
			const meetingFolder = await this.prepareMeetingNoteFolder(
				start
			);
			const notePath = await this.getAvailableNotePath(
				meetingFolder,
				`${this.slugifyTitle(title)}.md`
			);
			const content = generateMeetingNoteContent(this.settings, {
				title,
				audioPath: "",
				start,
				end: resolvedEnd,
			});
			const file = await this.app.vault.create(notePath, content);
			this.lastMeetingFilePath = file.path;
			this.lastMeetingFolder = file.parent?.path ?? null;
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(file);
			new Notice("Meeting note created.");
		} catch (error) {
			console.error("Audio Notes: Could not create meeting note.", error);
			new Notice("Could not create meeting note.", 6000);
		}
	}

	private async prepareMeetingNoteFolder(meetingDate: Date): Promise<string> {
		const baseFolder = normalizeFolderPath(
			this.settings.whisperNoteFolder,
			"02-meetings"
		) || "02-meetings";
		const year = meetingDate.getFullYear().toString();
		const month = (meetingDate.getMonth() + 1).toString().padStart(2, "0");
		const day = meetingDate.getDate().toString().padStart(2, "0");
		const folder = [baseFolder, year, month, day]
			.filter(Boolean)
			.join("/");
		await ensureFolderExists(this.app, folder);
		return folder;
	}

	private async getAvailableNotePath(
		folder: string,
		filename: string
	): Promise<string> {
		let candidate = `${folder}/${filename}`.replace(/\/+/g, "/");
		const dotIndex = filename.lastIndexOf(".");
		const base =
			dotIndex === -1 ? filename : filename.slice(0, dotIndex);
		const extension = dotIndex === -1 ? "" : filename.slice(dotIndex);
		let counter = 1;
		while (await this.app.vault.adapter.exists(candidate)) {
			candidate = `${folder}/${base}-${counter}${extension}`.replace(
				/\/+/g,
				"/"
			);
			counter += 1;
		}
		return candidate;
	}

	private combineMeetingDateTime(dateStr?: string, timeStr?: string): Date {
		const datePart = dateStr || new Date().toISOString().slice(0, 10);
		const timePart = timeStr || "00:00";
		const isoString = `${datePart}T${timePart}`;
		const result = new Date(isoString);
		return Number.isNaN(result.getTime()) ? new Date() : result;
	}

	private slugifyTitle(value: string): string {
		return value
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^\w\s-]/g, "")
			.trim()
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.slice(0, 60) || "meeting";
	}

	public onunload() {
		this.app.workspace.detachLeavesOfType(AUDIO_NOTES_CALENDAR_VIEW);
		this.app.workspace.detachLeavesOfType(AUDIO_NOTES_TRANSCRIPT_VIEW);
		this.knownCurrentTimes.clear();
		this.knownAudioPlayers.clear();
		this.currentlyPlayingAudioFakeUuid = null;
		this.transcriptDatastore.cache.clear();
	}
}
