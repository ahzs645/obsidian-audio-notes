import { App, MarkdownView, Notice, TFile } from "obsidian";
import type AutomaticAudioNotes from "../main";
import { ImportWhisperModal } from "../ImportWhisperModal";
import { getStartAndEndFromBracketString } from "../AudioNotes";
import {
	isGoogleDriveArchiveEnabled,
	getGoogleDriveArchiveRoot,
	deriveGoogleDriveUrlWithRetries,
	normalizeArchiveRelativePath,
} from "../googleDriveArchive";
import path from "path";
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
		id: "open-transcript-sidebar",
		name: "Open transcript sidebar",
		callback: async () => {
			await plugin.openTranscriptSidebar();
		},
	});

	plugin.addCommand({
		id: "export-audio-notes",
		name: "Export audio notes and transcripts",
		callback: () => {
			new ExportModal(app, plugin).open();
		},
	});

	plugin.addCommand({
		id: "migrate-notes-to-google-drive-archive",
		name: "Migrate meeting notes to Google Drive archive",
		callback: async () => {
			if (!isGoogleDriveArchiveEnabled(settings)) {
				new Notice(
					"Enable 'Store audio outside the vault' and set the Google Drive archive root in settings first.",
					8000
				);
				return;
			}
			const archiveRoot = getGoogleDriveArchiveRoot(settings);
			const files = app.vault.getMarkdownFiles();
			let migrated = 0;
			let skipped = 0;
			let failed = 0;

			for (const file of files) {
				const cache = app.metadataCache.getFileCache(file);
				const fm = cache?.frontmatter;
				if (!fm) continue;

				const mediaUri =
					typeof fm.media_uri === "string"
						? fm.media_uri.trim()
						: "";
				if (!mediaUri) continue;
				if (fm.recording_archive === "google-drive") {
					skipped++;
					continue;
				}

				try {
					const absolutePath = path.join(archiveRoot, mediaUri);
					const driveUrl =
						await deriveGoogleDriveUrlWithRetries(absolutePath);
					const drivePath =
						normalizeArchiveRelativePath(mediaUri);

					await app.fileManager.processFrontMatter(
						file,
						(frontmatter) => {
							frontmatter.recording_archive = "google-drive";
							frontmatter.recording_drive_path = drivePath;
							if (driveUrl) {
								frontmatter.recording_url = driveUrl;
							}
						}
					);
					migrated++;
				} catch (error) {
					console.error(
						`Audio Notes: Could not migrate ${file.path}`,
						error
					);
					failed++;
				}
			}

			new Notice(
				`Google Drive migration complete.\n${migrated} migrated, ${skipped} already done, ${failed} failed.`,
				8000
			);
		},
	});

	plugin.addCommand({
		id: "toggle-inline-player-visibility",
		name: "Remove inline player hiding from meeting notes",
		callback: async () => {
			const files = app.vault.getMarkdownFiles();
			let updated = 0;

			for (const file of files) {
				const cache = app.metadataCache.getFileCache(file);
				const fm = cache?.frontmatter;
				if (!fm) continue;

				const cssclasses: unknown =
					fm.cssclasses ?? fm.cssclass;
				if (!Array.isArray(cssclasses)) continue;
				if (
					!cssclasses.includes("aan-hide-inline-player")
				) {
					continue;
				}

				try {
					await app.fileManager.processFrontMatter(
						file,
						(frontmatter) => {
							const classes: string[] =
								frontmatter.cssclasses ??
								frontmatter.cssclass ??
								[];
							if (!Array.isArray(classes)) return;
							const filtered = classes.filter(
								(c: string) =>
									c !== "aan-hide-inline-player"
							);
							if (frontmatter.cssclasses !== undefined) {
								frontmatter.cssclasses = filtered;
							} else {
								frontmatter.cssclass = filtered;
							}
						}
					);
					updated++;
				} catch (error) {
					console.error(
						`Audio Notes: Could not update ${file.path}`,
						error
					);
				}
			}

			new Notice(
				`Removed inline player hiding from ${updated} notes.`,
				6000
			);
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
