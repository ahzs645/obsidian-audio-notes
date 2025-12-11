import { App, MarkdownView, Notice, WorkspaceLeaf, request } from "obsidian";
import type AutomaticAudioNotes from "../main";
import { ImportWhisperModal } from "../ImportWhisperModal";
import { CreateNewAudioNoteInNewFileModal } from "../CreateNewAudioNoteInNewFileModal";
import { EnqueueAudioModal } from "../EnqueueAudioModal";
import { DGQuickNoteModal } from "../DGQuickNoteModal";
import {
	AudioNote,
	getStartAndEndFromBracketString,
} from "../AudioNotes";
import { ensureDashboardNote } from "../dashboard";
import { NewMeetingModal } from "../modals/NewMeetingModal";
import { ExportModal } from "../modals/ExportModal";
import {
	MeetingLabelPickerModal,
	type MeetingLabelSelection,
} from "../MeetingLabelPickerModal";
import { applyMeetingLabelToFile } from "../meeting-label-manager";
import { MeetingLabelCategoryModal } from "../settings/MeetingLabelCategoryModal";
import { normalizeTagPrefix, slugifyTagSegment } from "../meeting-labels";

export function registerAudioNoteCommands(plugin: AutomaticAudioNotes) {
	const { app, settings } = plugin;

	plugin.addCommand({
		id: "open-audio-notes-calendar",
		name: "Open Audio Notes calendar",
		callback: () => {
			void plugin.activateCalendarView();
		},
	});

	plugin.addCommand({
		id: "create-audio-notes-dashboard",
		name: "Create or refresh Audio Notes dashboard",
		callback: async () => {
			try {
				const message = await ensureDashboardNote(plugin, true);
				new Notice(message);
			} catch (error) {
				console.error(error);
				new Notice("Could not update dashboard note.", 8000);
			}
		},
	});

	plugin.addCommand({
		id: "assign-meeting-label",
		name: "Assign meeting label…",
		checkCallback: (checking: boolean) => {
			const file = app.workspace.getActiveFile();
			if (!file || file.extension !== "md") {
				return false;
			}
			if (checking) {
				return true;
			}
				const picker = new MeetingLabelPickerModal(
					app,
					plugin,
					(selection) => {
						void applyMeetingLabelToFile(app, file, selection.tag)
							.then(() => {
								const labelName =
									selection.label.displayName ||
									selection.tag;
								new Notice(
									labelName
										? `Meeting labeled as ${labelName}.`
										: "Meeting label updated."
								);
							})
							.catch((error) => {
								console.error(error);
								new Notice(
									"Could not update meeting label.",
									6000
								);
							});
					},
					{
						onCreateCategory: (query) =>
							openCategoryModal(app, plugin, query),
					}
				);
				picker.open();
				return true;
			},
		});

	plugin.addCommand({
		id: "import-whisper-archive",
		name: "Import Whisper transcription archive",
		callback: () => {
			new ImportWhisperModal(plugin).open();
		},
	});

	plugin.addCommand({
		id: "create-new-meeting-note",
		name: "Create new meeting note",
		callback: () => {
			new NewMeetingModal(app, {
				plugin,
				onSubmit: (details) => {
					void plugin.createNewMeeting(details);
				},
			}).open();
		},
	});

	plugin.addCommand({
		id: "create-new-audio-note",
		name: `Create new Audio Note at current time (-/+ ${settings.minusDuration}/${settings.plusDuration} seconds)`,
		checkCallback: (checking: boolean) => {
			const markdownView = app.workspace.getActiveViewOfType(MarkdownView);
			if (!markdownView) {
				return false;
			}
			if (checking) {
				return true;
			}
			plugin.audioNoteService
				.getFirstAudioNoteInFile(markdownView.file)
				.then((audioNote) => {
					const audioSrcPath = plugin.audioNoteService.getFullAudioSrcPath(
						audioNote
					);
					if (!audioSrcPath) {
						return;
					}
					let currentTime = plugin.knownCurrentTimes.get(audioSrcPath);
					if (!currentTime) {
						currentTime = audioNote.start;
					}
					audioNote.start = currentTime - settings.minusDuration;
					audioNote.end = currentTime + settings.plusDuration;
					plugin.audioNoteService
						.createNewAudioNoteAtEndOfFile(markdownView, audioNote)
						.catch((error) => {
							console.error(`Audio Notes: ${error}`);
							new Notice(
								"Coud not create audio note at end of file.",
								10000
							);
						});
					void plugin.incrementUsageCount();
				})
				.catch((error: Error) => {
					console.error(`Audio Notes: ${error}`);
					new Notice("Could not find audio note.", 10000);
				});
			return true;
		},
	});

	plugin.addCommand({
		id: "create-audio-note-from-media-extended-plugin",
		name: `(Media Extended YouTube Video) Create new Audio Note at current time (-/+ ${settings.minusDuration}/${settings.plusDuration} seconds)`,
		checkCallback: (checking: boolean) => {
			// https://github.com/aidenlx/media-extended/blob/1e8f37756403423cd100e51f58d27ed961acf56b/src/mx-main.ts#L120
			type MediaView = any;
			const getMediaView = (group: string) =>
				app.workspace
					.getGroupLeaves(group)
					.find(
						(leaf) =>
							(leaf.view as MediaView).getTimeStamp !== undefined
					)?.view as MediaView | undefined;

			const markdownView = app.workspace.getActiveViewOfType(MarkdownView);
			let group: WorkspaceLeaf | undefined = undefined;
			if (markdownView) {
				group = (markdownView.leaf as any).group;
			}
			if (checking) {
				return Boolean(group);
			}
			if (!group) {
				new Notice(
					"Use the command `Media Extended: Open Media from Link` to open a YouTube video."
				);
				return false;
			}
			const mediaView = getMediaView(group.toString());
			if (!mediaView || !mediaView.getTimeStamp) {
				new Notice(
					"Use the command `Media Extended: Open Media from Link` to open a YouTube video."
				);
				return false;
			}
			const markdownViewInstance =
				app.workspace.getActiveViewOfType(MarkdownView);
			if (!markdownViewInstance) {
				new Notice("Please focus your cursor on a markdown window.");
				return false;
			}
			const notTimestamp = mediaView.getTimeStamp();
			let url: string = mediaView.info.src.href;
			if (!url.includes("youtube.com")) {
				new Notice("Currently, only YouTube videos are supported.");
				return false;
			}
			const urlParts = url.split("?");
			const urlParams: Map<string, string> = new Map();
			for (const param of urlParts[1].split("&")) {
				const [key, value] = param.split("=");
				urlParams.set(key, value);
			}
			url = `${urlParts[0]}?v=${urlParams.get("v")}`;
			request({
				url: `https://www.youtube.com/oembed?format=json&url=${url}`,
				method: "GET",
				contentType: "application/json",
			}).then((result: string) => {
				const videoInfo = JSON.parse(result);
				const title = videoInfo.title;
				const currentTime = parseFloat(
					notTimestamp.split("#t=")[1].slice(0, -1)
				);
				const audioNote = new AudioNote(
					title,
					notTimestamp,
					url,
					currentTime - settings.minusDuration,
					currentTime + settings.plusDuration,
					1.0,
					url,
					undefined,
					undefined,
					undefined,
					false,
					false
				);
				plugin.audioNoteService
					.createNewAudioNoteAtEndOfFile(markdownViewInstance, audioNote)
					.catch((error) => {
						console.error(`Audio Notes: ${error}`);
						new Notice(
							"Coud not create audio note at end of file.",
							10000
						);
					});
				void plugin.incrementUsageCount();
			});
			return true;
		},
	});

	plugin.addCommand({
		id: "regenerate-current-audio-note",
		name: "Regenerate Current Audio Note",
		checkCallback: (checking: boolean) => {
			const markdownView = app.workspace.getActiveViewOfType(MarkdownView);
			if (!markdownView) return false;
			if (!checking) {
				plugin.audioNoteService
					.regenerateCurrentAudioNote(markdownView)
					.catch(() =>
						new Notice("Could not generate audio notes.", 10000)
					);
				void plugin.incrementUsageCount();
			}
			return true;
		},
	});

	plugin.addCommand({
		id: "regenerate-audio-notes",
		name: "Regenerate All Audio Notes",
		checkCallback: (checking: boolean) => {
			const markdownView = app.workspace.getActiveViewOfType(MarkdownView);
			if (!markdownView) return false;
			if (!checking) {
				plugin.audioNoteService
					.regenerateAllAudioNotes(markdownView)
					.catch(() =>
						new Notice("Could not generate audio notes.", 10000)
					);
				void plugin.incrementUsageCount();
			}
			return true;
		},
	});

	plugin.addCommand({
		id: "create-new-audio-note-with-new-file",
		name: "Create new Audio Note in new file",
		callback: async () => {
			const allFiles = app.vault.getFiles();
			const mp3Files = allFiles.filter(
				(file) =>
					file.extension === "mp3" ||
					file.extension === "m4b" ||
					file.extension === "m4a"
			);
			new CreateNewAudioNoteInNewFileModal(plugin, mp3Files).open();
			void plugin.incrementUsageCount();
		},
	});

	plugin.addCommand({
		id: "toggle-play",
		name: "Toggle Play/Pause",
		callback: async () => {
			const audioPlayer = plugin.getCurrentlyPlayingAudioElement();
			if (audioPlayer) {
				if (audioPlayer.paused || audioPlayer.ended) {
					audioPlayer.play();
				} else {
					audioPlayer.pause();
				}
			}
		},
	});

	plugin.addCommand({
		id: "skip-backward",
		name: "Skip Backward",
		callback: async () => {
			const audioPlayer = plugin.getCurrentlyPlayingAudioElement();
			if (audioPlayer) {
				audioPlayer.currentTime -= settings.backwardStep;
			}
		},
	});

	plugin.addCommand({
		id: "skip-forward",
		name: "Skip Forward",
		callback: async () => {
			const audioPlayer = plugin.getCurrentlyPlayingAudioElement();
			if (audioPlayer) {
				audioPlayer.currentTime += settings.forwardStep;
			}
		},
	});

	plugin.addCommand({
		id: "slow-down-playback",
		name: "Slow Down Playback",
		callback: async () => {
			const audioPlayer = plugin.getCurrentlyPlayingAudioElement();
			if (audioPlayer) {
				audioPlayer.playbackRate -= 0.1;
				new Notice(
					`Set playback speed to ${Math.round(
						audioPlayer.playbackRate * 10
					) / 10}`,
					1000
				);
			}
		},
	});

	plugin.addCommand({
		id: "speed-up-playback",
		name: "Speed Up Playback",
		callback: async () => {
			const audioPlayer = plugin.getCurrentlyPlayingAudioElement();
			if (audioPlayer) {
				audioPlayer.playbackRate += 0.1;
				new Notice(
					`Set playback speed to ${Math.round(
						audioPlayer.playbackRate * 10
					) / 10}`,
					1000
				);
			}
		},
	});

	plugin.addCommand({
		id: "reset-player",
		name: "Reset Audio to Start",
		callback: async () => {
			const audioPlayer = plugin.getCurrentlyPlayingAudioElement();
			if (audioPlayer) {
				const audioLine = audioPlayer.src;
				let start = 0;
				if (audioLine.includes("#")) {
					const timeInfo = audioLine.split("#")[1];
					[start] = getStartAndEndFromBracketString(timeInfo);
				}
				audioPlayer.currentTime = start;
			}
		},
	});

	plugin.addCommand({
		id: "add-audio-file-to-queue",
		name: "Transcribe mp3 file online",
		callback: async () => {
			new EnqueueAudioModal(plugin).open();
		},
	});

	plugin.addCommand({
		id: "open-transcript-sidebar",
		name: "Open transcript sidebar",
		callback: async () => {
			await plugin.openTranscriptSidebar();
		},
	});

	plugin.addCommand({
		id: "quick-audio-note",
		name: "Generate quick audio recording with transcription",
		callback: async () => {
			if (
				!settings.DGApiKey &&
				!settings.hasScriberrCredentials
			) {
				new Notice(
					"Please set a Deepgram API key or Scriberr credentials in the settings tab."
				);
			} else {
				new DGQuickNoteModal(plugin).open();
			}
		},
	});

	plugin.addCommand({
		id: "export-audio-notes",
		name: "Export audio notes and transcripts",
		callback: () => {
			new ExportModal(app, plugin).open();
		},
	});
}

function openCategoryModal(
	app: App,
	plugin: AutomaticAudioNotes,
	query?: string
) {
	new MeetingLabelCategoryModal(
		app,
		plugin,
		{
			initialName: formatCategoryName(query),
			initialPrefix: formatCategoryPrefix(query),
		},
		() => {}
	).open();
}

function formatCategoryName(raw?: string): string {
	const value = raw?.trim();
	if (!value) return "";
	return value
		.split(/[\s/_-]+/)
		.filter(Boolean)
		.map(
			(part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
		)
		.join(" ");
}

function formatCategoryPrefix(raw?: string): string {
	if (!raw?.trim()) {
		return "";
	}
	return (
		normalizeTagPrefix(raw) ||
		`${slugifyTagSegment(raw) || "category"}/`
	);
}
