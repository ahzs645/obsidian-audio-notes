import {
	MarkdownView,
	Plugin,
	Notice,
	TFile,
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
import TranscriptDisplay from "./transcript-view/TranscriptDisplay.svelte";
import type { TranscriptSegmentWithSpeaker } from "./transcript-view/types";
import { createAudioPlayer } from "./audio/AudioPlayerFactory";
import type { AudioPlayerEnvironment } from "./audio/AudioPlayerFactory";
import { registerAudioNoteCommands } from "./commands/registerCommands";
import { secondsToTimeString, getUniqueId } from "./utils";
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
import { Transcript, parseTranscript, TranscriptsCache } from "./Transcript";
import {
	AUDIO_NOTES_CALENDAR_VIEW,
	MeetingCalendarView,
} from "./MeetingCalendarView";
import {
	AUDIO_NOTES_BASES_CALENDAR_VIEW,
	BasesCalendarView,
} from "./BasesCalendarView";

// Load Font-Awesome stuff
import { library } from "@fortawesome/fontawesome-svg-core";
import { faCopy, far } from "@fortawesome/free-regular-svg-icons";
import { fas } from "@fortawesome/free-solid-svg-icons";
import { fab } from "@fortawesome/free-brands-svg-icons";
// Load the actual library so the icons render.
library.add(fas, far, fab, faCopy);

class TranscriptViewRenderChild extends MarkdownRenderChild {
	private destroyed = false;

	constructor(
		containerEl: HTMLElement,
		private component: TranscriptDisplay
	) {
		super(containerEl);
	}

	get isDestroyed(): boolean {
		return this.destroyed;
	}

	public setProps(props: Record<string, unknown>) {
		if (!this.destroyed) {
			this.component.$set(props);
		}
	}

	onunload(): void {
		this.destroyed = true;
		this.component.$destroy();
	}
}

export default class AutomaticAudioNotes extends Plugin {
	settings: AudioNotesSettings;
	transcriptDatastore: TranscriptsCache;
	knownCurrentTimes: Map<string, number> = new Map();
	knownAudioPlayers: AudioElementCache = new AudioElementCache(30);
	currentlyPlayingAudioFakeUuid: string | null = null;
	atLeastOneNoteRendered: boolean = false;

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
		const newSettings = new AudioNotesSettings(
			_plusDuration,
			_minusDuration,
			_backwardStep,
			_forwardStep,
			loadedData["_audioNotesApiKey"],
			loadedData["_debugMode"],
			loadedData["_DGApiKey"],
			loadedData["_DGTranscriptFolder"],
			loadedData["_whisperAudioFolder"],
			loadedData["_whisperTranscriptFolder"],
			loadedData["_whisperUseDateFolders"],
			loadedData["_whisperCreateNote"],
			loadedData["_whisperNoteFolder"],
			loadedData["_calendarTagColors"],
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
					this.settings.DGApiKey === "" ||
					this.settings.DGApiKey === undefined
				) {
					new Notice(
						"No Deepgram API key found. Use Whisper import instead or set a key in settings."
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

		// Log to log.txt file if on mobile and debugging mode is enabled.
		if (!this.isDesktop && this.settings.debugMode) {
			monkeyPatchConsole(this);
		}

		registerAudioNoteCommands(this);

		// Register the HTML renderer.
		this.registerMarkdownCodeBlockProcessor(`audio-note`, (src, el, ctx) =>
			this.postprocessor(src, el, ctx)
		);

		this.registerMarkdownCodeBlockProcessor(
			`dg-audio-note`,
			(src, el, ctx) => {
				return QuickNotePostProcessor(src, el, ctx);
			}
		);
		// Done!
		console.info("Audio Notes: Obsidian Audio Notes loaded");
	}

	public async incrementUsageCount() {
		const data = await this.loadData();
		data.counts = (data.counts || 0) + 1;
		this.saveData(data);
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

	private _replaceElementWithError(el: HTMLElement, error: Error): void {
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

	private async loadFiles(filenames: string[]): Promise<Map<string, string>> {
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

	private async postprocessor(
		src: string,
		el: HTMLElement,
		ctx?: MarkdownPostProcessorContext
	) {
		try {
			// Need this for rendering.
			const currentMdFilename =
				typeof ctx == "string"
					? ctx
					: ctx?.sourcePath ??
					this.app.workspace.getActiveFile()?.path ??
					"";

			const audioNote = AudioNote.fromSrc(src);
			const theDiv = this._createAudioNoteDiv(
				audioNote,
				currentMdFilename,
				ctx
			);

			// Replace the <pre> tag with the new callout div.
			el.replaceWith(theDiv);

			const markdownView =
				this.app.workspace.getActiveViewOfType(MarkdownView);
			if (markdownView) {
				const playersInSource = this.getAudioHTMLMediaElementsInMode(
					(markdownView as any).modes.source.editorEl
				);
				const playersInReading = this.getAudioHTMLMediaElementsInMode(
					(markdownView as any).modes.preview.containerEl
				);
				const generatedAudioDiv =
					this.getAudioHTMLMediaElementsInMode(theDiv);
				const allPlayers = [
					...playersInSource,
					...playersInReading,
					...generatedAudioDiv,
				];
				for (const player of allPlayers) {
					this.knownAudioPlayers.add(player);
				}
			}

			if (!this.atLeastOneNoteRendered) {
				this.atLeastOneNoteRendered = true;
				this._onFirstRender();
			}
			return null;
		} catch (error) {
			console.error(`Audio Notes: ${error}`);
			this._replaceElementWithError(el, error);
		}
	}

	private _createAudioNoteDiv(
		audioNote: AudioNote,
		currentMdFilename: string,
		ctx?: MarkdownPostProcessorContext
	): HTMLElement {
		// Create the main div.
		const calloutDiv = createDiv({
			cls: `callout audio-note ${""}`,
			attr: {
				"data-callout": "quote",
				"data-callout-fold": "",
			},
		});

		// Add the quote to the div.
		const contentEl: HTMLDivElement =
			calloutDiv.createDiv("callout-content");
		if (audioNote.quote) {
			MarkdownRenderer.renderMarkdown(
				audioNote.quote,
				contentEl,
				currentMdFilename,
				this
			);
		}

		const transcriptWrapper = contentEl.createDiv({
			cls: "audio-note-transcript-wrapper",
		});

		const transcriptComponent = new TranscriptDisplay({
			target: transcriptWrapper,
			props: {
				segments: [],
				transcriptText: audioNote.quote ?? "",
				metadataDuration: null,
				isTranscribing: false,
				syncWithAudio: audioNote.liveUpdate,
				onSeekToTime: () => {},
			},
		});

		let transcriptChild: TranscriptViewRenderChild | undefined = undefined;
		if (ctx) {
			transcriptChild = new TranscriptViewRenderChild(
				transcriptWrapper,
				transcriptComponent
			);
			ctx.addChild(transcriptChild);
		}

		const setTranscriptProps = (props: Record<string, unknown>) => {
			if (transcriptChild) {
				transcriptChild.setProps(props);
			} else {
				transcriptComponent.$set(props);
			}
		};

		// Add the author to the div.
		if (audioNote.author) {
			const authorEl = calloutDiv.createDiv({ cls: "audio-note-author" });
			let authorStr = audioNote.author;
			if (authorStr.startsWith("-")) {
				authorStr = `\\${authorStr}`; // prepend a \ to escape the - so it does turn into a bullet point when the HTML renders
			}
			const authorInnerEl = authorEl.createDiv("audio-note-author");
			MarkdownRenderer.renderMarkdown(
				authorStr,
				authorInnerEl,
				currentMdFilename,
				this
			);
		}

		// Create the audio player div.
		if (!audioNote.audioFilename.includes("youtube.com")) {
			const [audio, audioDiv] = this._createAudioPlayerDiv(
				audioNote,
				setTranscriptProps
			);
			if (audioDiv === undefined || audio === undefined) {
				return calloutDiv;
			}
			calloutDiv.prepend(audioDiv);
			MarkdownRenderer.renderMarkdown(
				``,
				calloutDiv,
				currentMdFilename,
				this
			);

			this.transcriptDatastore
				.getTranscript(audioNote.transcriptFilename)
				.then((transcript: Transcript | undefined) => {
					if (transcript) {
						const transcriptSegments =
							transcript.segments as TranscriptSegmentWithSpeaker[];
						const duration =
							transcriptSegments.length > 0
								? Math.max(
										...transcriptSegments.map((segment) =>
											Number(
												segment.end ??
													segment.start ??
													0
											)
										)
								  )
								: null;
						setTranscriptProps({
							segments: transcriptSegments,
							transcriptText: transcript.getEntireTranscript(),
							metadataDuration: duration,
						});
					} else if (audioNote.quote) {
						setTranscriptProps({
							transcriptText: audioNote.quote,
						});
					}
				})
				.catch((error) => {
					console.error("Audio Notes: Failed to load transcript", error);
				});

		}

		return calloutDiv;
	}

	/**
	 * Figures out the true audio src's path, and appends the player's start/end time to it.
	 * The src can be an http(s) link, or a local file.
	 */
	public getFullAudioSrcPath(audioNote: AudioNote): string | undefined {
		let audioSrcPath: string | undefined = undefined;
		// If the filename is a link, don't look for it in the vault.
		if (
			audioNote.audioFilename.startsWith("https") ||
			audioNote.audioFilename.startsWith("http")
		) {
			audioSrcPath = audioNote.audioFilename;
		} else {
			// If the file isn't a link, look for it in the vault and get its full file path.
			const tfile = this.app.vault.getAbstractFileByPath(
				audioNote.audioFilename
			);
			if (!tfile) {
				console.error(
					`AudioNotes: Could not find audio file: ${audioNote.audioFilename}`
				);
				return undefined;
			}
			audioSrcPath = this.app.vault.getResourcePath(tfile as TFile);
		}
		if (audioSrcPath.includes("?")) {
			audioSrcPath = audioSrcPath.slice(0, audioSrcPath.indexOf("?"));
		}
		audioSrcPath += `#t=${secondsToTimeString(audioNote.start, false)}`;
		if (audioNote.end !== Infinity) {
			audioSrcPath += `,${secondsToTimeString(audioNote.end, false)}`;
		}
		return audioSrcPath;
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
	private _createAudioPlayerDiv(
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
			resolveAudioSrc: (note) => this.getFullAudioSrcPath(note),
			registerCleanup: (cleanup) => this.register(cleanup),
		};

		return createAudioPlayer(env, audioNote, updateTranscript);
	}

	/* Look through the .md file's contents and parse out any audio notes in it. */
	private getAudioNoteBlocks(
		fileContents: string,
		limit: number = Infinity
	): AudioNoteWithPositionInfo[] {
		const currentMdContentLines = fileContents.split(/\r?\n/);
		// [startLineNumber, endLineNumber, endChNumber, srcLines]
		const allAudioNoteCodeBlockStrings: [
			number,
			number,
			number,
			string[]
		][] = [];
		let inAudioCodeBlock = false;
		for (let i = 0; i < currentMdContentLines.length; i++) {
			const line = currentMdContentLines[i];
			if (inAudioCodeBlock) {
				if (line.trim() === "```") {
					inAudioCodeBlock = false;
					allAudioNoteCodeBlockStrings[
						allAudioNoteCodeBlockStrings.length - 1
					][1] = i; // endLineNumber
					allAudioNoteCodeBlockStrings[
						allAudioNoteCodeBlockStrings.length - 1
					][2] = currentMdContentLines[i - 1].length; // endChNumber
				} else {
					allAudioNoteCodeBlockStrings[
						allAudioNoteCodeBlockStrings.length - 1
					][3].push(line);
				}
			}
			if (line.trim() === "```audio-note") {
				allAudioNoteCodeBlockStrings.push([
					i,
					undefined as any,
					undefined as any,
					[],
				]);
				inAudioCodeBlock = true;
			}
			if (
				allAudioNoteCodeBlockStrings.length >= limit &&
				!inAudioCodeBlock
			) {
				break;
			}
		}

		const allAudioNotes: AudioNoteWithPositionInfo[] = [];
		for (const [
			startLineNumber,
			endLineNumber,
			endChNumber,
			lines,
		] of allAudioNoteCodeBlockStrings) {
			const audioNote = AudioNote.fromSrc(lines.join("\n"));
			const audioNoteWithPositionInfo =
				AudioNoteWithPositionInfo.fromAudioNote(
					audioNote,
					startLineNumber,
					endLineNumber,
					endChNumber
				);
			allAudioNotes.push(audioNoteWithPositionInfo);
		}

		return allAudioNotes;
	}

	public async getFirstAudioNoteInFile(file: TFile): Promise<AudioNote> {
		const fileContents = await this.app.vault.read(file);
		const audioNotes: AudioNote[] = this.getAudioNoteBlocks(
			fileContents,
			1
		);
		return audioNotes[0];
	}

	public async createNewAudioNoteAtEndOfFile(
		view: MarkdownView,
		audioNote: AudioNote
	): Promise<void> {
		let transcript: Transcript | undefined =
			await this.transcriptDatastore.getTranscript(
				audioNote.transcriptFilename
			);

		const newAudioNoteSrc = audioNote.toSrc(transcript);
		if (newAudioNoteSrc) {
			this.app.vault.append(
				view.file,
				"\n```audio-note\n" + newAudioNoteSrc + "\n```\n"
			);
			new Notice("Created new audio note", 3000);
		}
		return undefined;
	}

	private getAudioHTMLMediaElementsInMode(mode: HTMLElement): HTMLElement[] {
		const _players = mode.getElementsByClassName("audio-player-container");
		const players: HTMLElement[] = [];
		for (let i = 0; i < _players.length; i++) {
			players.push(_players[i] as HTMLElement);
		}
		return players;
	}

	public async regenerateAllAudioNotes(view: MarkdownView) {
		new Notice("Regenerating All Audio Notes...");

		// Get the file contents of the current markdown file.
		const currentMdFilename = view.file.path;
		const fileContents = await this.loadFiles([currentMdFilename]);
		const currentMdFileContents = fileContents.get(currentMdFilename);
		if (currentMdFileContents === undefined) {
			console.error(
				`Audio Notes: Could not find current .md: ${currentMdFilename}...? This should be impossible.`
			);
			return undefined;
		}
		const audioNotes: AudioNoteWithPositionInfo[] = this.getAudioNoteBlocks(
			currentMdFileContents
		);

		// Load the transcripts.
		const translationFilenames: string[] = [];
		for (const audioNote of audioNotes) {
			if (!audioNote.transcriptFilename) {
				continue;
			}
			if (
				audioNote.needsToBeUpdated &&
				!translationFilenames.includes(audioNote.transcriptFilename)
			) {
				translationFilenames.push(audioNote.transcriptFilename);
			}
		}
		const transcriptContents = await this.loadFiles(translationFilenames);
		const transcripts: Map<string, Transcript> = new Map();
		for (const [filename, contents] of transcriptContents.entries()) {
			transcripts.set(filename, parseTranscript(contents));
		}

		// Must go from bottom to top so the editor position doesn't change!
		audioNotes.reverse();
		for (const audioNote of audioNotes) {
			if (audioNote.needsToBeUpdated) {
				if (!audioNote.transcriptFilename) {
					new Notice(
						"No transcript file defined for audio note.",
						10000
					);
					continue;
				}
				let transcript = transcripts.get(audioNote.transcriptFilename);
				if (transcript === undefined) {
					transcript = await this.transcriptDatastore.getTranscript(
						audioNote.transcriptFilename
					);
				}

				const newAudioNoteSrc = audioNote.toSrc(transcript);
				if (newAudioNoteSrc) {
					const [srcStart, srcEnd] =
						this._getAudioNoteStartAndEndPositionInEditor(
							audioNote
						);
					// Perform the replacement.
					if (srcStart && srcEnd) {
						view.editor.replaceRange(
							newAudioNoteSrc,
							srcStart,
							srcEnd
						);
					}
				}
			}
		}

		// Tell the user the generation is complete.
		new Notice("Audio Note generation complete!");
	}

	// Identify the start and end position of the audio note in the .md file.
	private _getAudioNoteStartAndEndPositionInEditor(
		audioNote: AudioNoteWithPositionInfo
	):
		| [{ line: number; ch: number }, { line: number; ch: number }]
		| [undefined, undefined] {
		// Update the view.editor.
		if (
			audioNote.startLineNumber === undefined ||
			audioNote.endLineNumber === undefined ||
			audioNote.endChNumber === undefined
		) {
			console.error(
				`Audio Notes: Could not find line numbers of audio-note...? This should be impossible.`
			);
			return [undefined, undefined];
		}

		const startLine = audioNote.startLineNumber + 1;
		const startCh = 0;
		const endLine = audioNote.endLineNumber - 1;
		const endCh = audioNote.endChNumber;
		const srcStart = { line: startLine, ch: startCh };
		const srcEnd = { line: endLine, ch: endCh };
		return [srcStart, srcEnd];
	}

	public async regenerateCurrentAudioNote(view: MarkdownView) {
		new Notice("Regenerating Current Audio Note...");

		// Get the file contents of the current markdown file.
		const currentMdFilename = view.file.path;
		const fileContents = await this.loadFiles([currentMdFilename]);
		const currentMdFileContents = fileContents.get(currentMdFilename);
		if (currentMdFileContents === undefined) {
			console.error(
				`Audio Notes: Could not find current .md: ${currentMdFilename}...? This should be impossible.`
			);
			return undefined;
		}
		const audioNotes: AudioNoteWithPositionInfo[] = this.getAudioNoteBlocks(
			currentMdFileContents
		);

		// Get the editor's current position
		const from = view.editor.getCursor("from");
		const to = view.editor.getCursor("to");

		// Identify which audio note the user's cursor is in.
		let audioNote: AudioNoteWithPositionInfo | undefined = undefined;
		for (const note of audioNotes) {
			// There are two cases, one of which we will ignore. The one we are ignoring is when the user highlights the entirety of a note.
			// The other case, which we will cover, is when the user's cusor/selection is entirely within a note.
			if (
				from.line >= note.startLineNumber &&
				from.ch >= 0 &&
				to.line <= note.endLineNumber &&
				to.ch <= note.endChNumber
			) {
				audioNote = note;
				break;
			}
		}
		if (audioNote === undefined) {
			console.warn(
				"Audio Notes: The user's cursor is not inside an audio note"
			);
			new Notice(
				"Please place your cursor inside the Audio Note you want to generate",
				10000
			);
			return undefined;
		}
		if (audioNote.quote) {
			console.warn(
				"Audio Notes: The user tried to generate an audio note with an existing quote"
			);
			new Notice(
				"Please delete the quote for the audio note before regenerating it",
				10000
			);
			return undefined;
		}

		// Load the transcript.
		if (!audioNote.transcriptFilename) {
			return;
		}
		let transcript: Transcript | undefined =
			await this.transcriptDatastore.getTranscript(
				audioNote.transcriptFilename
			);

		const newAudioNoteSrc = audioNote.toSrc(transcript);
		if (newAudioNoteSrc) {
			const [srcStart, srcEnd] =
				this._getAudioNoteStartAndEndPositionInEditor(audioNote);
			// Perform the replacement.
			if (srcStart && srcEnd) {
				view.editor.replaceRange(newAudioNoteSrc, srcStart, srcEnd);
			}
			new Notice("Created new audio note", 3000);
		}

		// Tell the user the generation is complete.
		new Notice("Audio Note generation complete!");
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

	public onunload() {
		this.app.workspace.detachLeavesOfType(AUDIO_NOTES_CALENDAR_VIEW);
		this.knownCurrentTimes.clear();
		this.knownAudioPlayers.clear();
		this.currentlyPlayingAudioFakeUuid = null;
		this.transcriptDatastore.cache.clear();
	}
}
