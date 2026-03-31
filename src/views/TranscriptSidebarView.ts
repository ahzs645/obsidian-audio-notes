import {
	ItemView,
	Notice,
	TFile,
	TFolder,
	WorkspaceLeaf,
} from "obsidian";
import TranscriptDisplay from "../transcript-view/TranscriptDisplay.svelte";
import type {
	TranscriptSegmentWithSpeaker,
	SidebarAttachment,
} from "../transcript-view/types";
import type AutomaticAudioNotes from "../main";
import { AudioNote } from "../AudioNotes";
import type { Transcript } from "../Transcript";
import { AttachmentManager } from "./transcript-sidebar/AttachmentManager";
import {
	MeetingFileService,
	type MeetingDateParts,
	type MeetingFolderResult,
} from "./transcript-sidebar/MeetingFileService";
import { DashboardController } from "./transcript-sidebar/DashboardController";
import { TranscriptionService } from "./transcript-sidebar/TranscriptionService";
import {
	buildMeetingLabelInfo,
	getEffectiveMeetingLabelCategories,
	type MeetingLabelInfo,
} from "../meeting-labels";
import {
	getAttendeesFromFrontmatter,
	getMeetingLabelFromFrontmatter,
} from "../meeting-label-manager";
import { collectTags } from "../meeting-events";
import { pathExists } from "../googleDriveArchive";
import { MeetingHeader } from "./transcript-sidebar/MeetingHeader";
import type { MeetingScheduleInfo } from "./transcript-sidebar/MeetingScheduleInfo";
import { MeetingLabelManager } from "./transcript-sidebar/MeetingLabelManager";
import { MeetingScheduleManager } from "./transcript-sidebar/MeetingScheduleManager";
import { SpeakerLabelManager } from "./transcript-sidebar/SpeakerLabelManager";
import { MeetingDeletionManager } from "./transcript-sidebar/MeetingDeletionManager";
import { MeetingAttendeeManager } from "./transcript-sidebar/MeetingAttendeeManager";

export const AUDIO_NOTES_TRANSCRIPT_VIEW = "audio-notes-transcript-view";
interface TranscriptSidebarState {
	file?: string;
}

export class TranscriptSidebarView extends ItemView {
	private transcriptComponent: TranscriptDisplay | null = null;
	private transcriptWrapper: HTMLDivElement | null = null;
	private header: MeetingHeader | null = null;
	private meetingContainer: HTMLDivElement | null = null;
	private dashboardContainer: HTMLDivElement | null = null;
	private dashboardPlaceholder: HTMLParagraphElement | null = null;
	private currentFilePath: string | null = null;
	private currentTranscriptPath: string | null = null;
	private currentMeetingFile: TFile | null = null;
	private currentMeetingDateParts: MeetingDateParts | null = null;
	private mode: "meeting" | "dashboard" = "dashboard";
	private isUploadingMeetingAudio = false;
	private isUploadingTranscript = false;
	private isTranscribingMeeting = false;
	private isDeletingMeeting = false;
	private currentAudioPath: string | null = null;
	private currentHasAudioReference = false;
	private readonly meetingFiles: MeetingFileService;
	private readonly attachments: AttachmentManager;
	private readonly dashboardController: DashboardController;
	private readonly transcriptionService: TranscriptionService;
	private readonly labelManager: MeetingLabelManager;
	private readonly scheduleManager: MeetingScheduleManager;
	private readonly speakerLabelManager: SpeakerLabelManager;
	private readonly deletionManager: MeetingDeletionManager;
	private readonly attendeeManager: MeetingAttendeeManager;
	private currentMeetingLabel: MeetingLabelInfo | undefined;
	private currentAttendees: string[] = [];
	private speakerLabelOverrides: Record<string, string> = {};
	private currentScheduleInfo: MeetingScheduleInfo | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: AutomaticAudioNotes
	) {
		super(leaf);
		this.meetingFiles = new MeetingFileService(this.plugin);
		this.attachments = new AttachmentManager(
			this.plugin,
			this.meetingFiles
		);
		this.transcriptionService = new TranscriptionService(
			this.plugin,
			this.meetingFiles
		);
		this.dashboardController = new DashboardController(
			this.plugin,
			this.registerEvent.bind(this),
			this.openFile.bind(this)
		);
		this.labelManager = new MeetingLabelManager(this.app, this.plugin, {
			getMode: () => this.mode,
			getCurrentMeetingFile: () => this.currentMeetingFile,
			getCurrentMeetingLabel: () => this.currentMeetingLabel,
			setCurrentMeetingLabel: (label) => {
				this.currentMeetingLabel = label;
			},
			refreshLabelHeader: () => this.updateLabelHeader(),
		});
		this.attendeeManager = new MeetingAttendeeManager(this.app, this.plugin, {
			getMode: () => this.mode,
			getCurrentMeetingFile: () => this.currentMeetingFile,
			getCurrentAttendees: () => this.currentAttendees,
			setCurrentAttendees: (attendees) => {
				this.currentAttendees = attendees;
			},
			refreshAttendeeDisplay: () => this.updateAttendeeDisplay(),
		});
		this.scheduleManager = new MeetingScheduleManager(this.app, this.plugin, {
			getMode: () => this.mode,
			getCurrentMeetingFile: () => this.currentMeetingFile,
			getCurrentMeetingDateParts: () => this.currentMeetingDateParts,
			setCurrentMeetingDateParts: (parts) => {
				this.currentMeetingDateParts = parts;
			},
			getCurrentAudioPath: () => this.currentAudioPath,
			getCurrentTranscriptPath: () => this.currentTranscriptPath,
			getMeetingTitle: () => this.currentMeetingFile?.basename ?? "Meeting",
			getCurrentScheduleInfo: () => this.currentScheduleInfo,
			setCurrentScheduleInfo: (info) => {
				this.currentScheduleInfo = info;
			},
			updateHeaderSchedule: (info, canEdit) => {
				this.header?.setSchedule(info, canEdit);
			},
			refreshDashboardSchedule: () => {
				this.dashboardController.scheduleRefresh();
			},
		});
		this.speakerLabelManager = new SpeakerLabelManager(this.app, {
			getCurrentMeetingFile: () => this.currentMeetingFile,
			getOverrides: () => this.speakerLabelOverrides,
			setOverrides: (overrides) => this.updateSpeakerLabelOverrides(overrides),
		});
		this.deletionManager = new MeetingDeletionManager(this.plugin, {
			getMode: () => this.mode,
			getCurrentMeetingFile: () => this.currentMeetingFile,
			getCurrentAudioPath: () => this.currentAudioPath,
			getCurrentTranscriptPath: () => this.currentTranscriptPath,
			setDeleting: (value) => {
				this.isDeletingMeeting = value;
				this.updateDeleteButtonState();
			},
			refreshAttachments: () => this.attachments.refresh(),
			clearTranscriptCache: (path) => {
				this.plugin.transcriptDatastore.cache.delete(path);
			},
			showDashboard: () => this.showDashboard(),
			scheduleDashboardRefresh: () => {
				this.dashboardController.scheduleRefresh();
			},
		});
	}

	private setMode(mode: "meeting" | "dashboard") {
		this.mode = mode;
	}

	getViewType(): string {
		return AUDIO_NOTES_TRANSCRIPT_VIEW;
	}

	getDisplayText(): string {
		return "Meeting transcript";
	}

	getIcon(): string {
		return "mic";
	}

	async onOpen(): Promise<void> {
		this.renderBase();
		if (this.currentFilePath) {
			await this.loadFileByPath(this.currentFilePath);
		} else {
			await this.showDashboard();
		}
	}

	onClose(): Promise<void> {
		if (this.transcriptComponent) {
			this.transcriptComponent.$destroy();
			this.transcriptComponent = null;
		}
		this.dashboardController.destroy();
		return Promise.resolve();
	}

	getState(): TranscriptSidebarState {
		return {
			file: this.currentFilePath ?? undefined,
		};
	}

	async setState(state: TranscriptSidebarState): Promise<void> {
		if (state?.file) {
			await this.loadFileByPath(state.file);
		}
	}

	async loadFileByPath(path: string): Promise<void> {
		const file =
			this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			this.renderEmpty("Open a meeting note to view its transcript.");
			return;
		}
		await this.showMeetingFile(file);
	}

	public async showMeetingFile(file: TFile): Promise<void> {
		let activeFile = file;
		this.setMode("meeting");
		this.resetAttachments();
		this.currentFilePath = activeFile.path;
		this.currentMeetingFile = activeFile;
		this.attachments.setMeetingFilePath(activeFile.path);
		this.currentAudioPath = null;
		if (!this.transcriptComponent) {
			this.renderBase();
		}
		this.dashboardContainer?.addClass("is-hidden");
		this.meetingContainer?.removeClass("is-hidden");
		this.renderHeader(activeFile);

		let cache =
			this.plugin.app.metadataCache.getFileCache(activeFile);
		let frontmatter = (cache?.frontmatter ??
			{}) as Record<string, unknown>;
		let noteFolderPath = activeFile.parent?.path ?? null;
		const noteTitle =
			(frontmatter["title"] as string | undefined) ||
			activeFile.basename;
		const audioFieldKeys = ["media_uri", "audio", "media"];
		let audioPath: string | undefined;
		let audioFieldKey: string | null = null;
			for (const key of audioFieldKeys) {
				const value = frontmatter[key];
				if (typeof value === "string") {
					audioPath = value;
					audioFieldKey = key;
					break;
				}
			}
			const transcriptPath = (frontmatter["transcript_uri"] ??
				frontmatter["transcript"]) as string | undefined;
			const archivedRecording =
				this.meetingFiles.resolveArchivedRecording(frontmatter);
			if (
				!audioPath &&
				archivedRecording?.localAudioPath &&
				(await pathExists(archivedRecording.localAudioPath))
			) {
				audioPath = archivedRecording.localAudioPath;
			}

			this.currentTranscriptPath =
				typeof transcriptPath === "string"
					? transcriptPath
					: null;

			const hasAudio =
				Boolean(audioPath && audioPath.trim().length) ||
				Boolean(
					archivedRecording?.recordingDrivePath ||
						archivedRecording?.recordingUrl
				);
			this.currentHasAudioReference = hasAudio;
		const categories = getEffectiveMeetingLabelCategories(
			this.plugin.settings.meetingLabelCategories
		);
		const explicitLabel = getMeetingLabelFromFrontmatter(frontmatter);
		let detectedLabel = explicitLabel;
		if (!detectedLabel) {
			const tags = collectTags(cache);
			detectedLabel =
				tags.find((tag) =>
					categories.some((category) =>
						tag.startsWith(category.tagPrefix)
					)
				) ?? undefined;
		}
		this.currentMeetingLabel = detectedLabel
			? buildMeetingLabelInfo(detectedLabel, categories)
			: undefined;
		this.updateLabelHeader();
		this.currentAttendees = getAttendeesFromFrontmatter(frontmatter);
		this.updateAttendeeDisplay();
		const preferredDateParts =
			this.meetingFiles.extractDatePartsFromFrontmatter(
				frontmatter
			) ??
			this.meetingFiles.deriveDatePartsFromNotePath(activeFile) ??
			this.currentMeetingDateParts;

			let meetingFolderResult: MeetingFolderResult | null = null;
			let attachmentFolder = noteFolderPath;
			if (audioPath) {
				meetingFolderResult = await this.meetingFiles.ensureMeetingFolderForAudio(
					activeFile,
					audioPath!,
				audioFieldKey,
				noteTitle,
				preferredDateParts ?? undefined
			);
			if (meetingFolderResult) {
				audioPath = meetingFolderResult.audioPath;
				if (meetingFolderResult.meetingFolder) {
					attachmentFolder = meetingFolderResult.meetingFolder;
				}
				if (meetingFolderResult.dateParts) {
					const relocated = await this.meetingFiles.ensureMeetingNoteFolder(
						activeFile,
						meetingFolderResult.dateParts,
						this.meetingFiles.getMeetingNoteRoot()
					);
					if (relocated) {
						activeFile = relocated;
						this.currentMeetingFile = relocated;
						this.currentFilePath = relocated.path;
						this.attachments.setMeetingFilePath(relocated.path);
						cache =
							this.plugin.app.metadataCache.getFileCache(
								relocated
							);
						frontmatter = (cache?.frontmatter ??
							{}) as Record<string, unknown>;
						noteFolderPath = relocated.parent?.path ?? null;
						if (!attachmentFolder) {
							attachmentFolder = noteFolderPath;
						}
					}
				}
			}
				this.currentAudioPath = audioPath!;
				this.attachments.setAudioPath(this.currentAudioPath);
				await this.attachments.setAttachmentFolder(attachmentFolder);
			} else {
				this.currentAudioPath = null;
			this.attachments.setAudioPath(null);
			await this.attachments.setAttachmentFolder(noteFolderPath);
		}

			this.updateSpeakerLabelOverrides(
				SpeakerLabelManager.extractOverrides(frontmatter)
			);

			this.currentMeetingFile = activeFile;
			if (archivedRecording && !archivedRecording.recordingUrl) {
				const recordingUrl =
					await this.meetingFiles.maybeBackfillArchivedRecordingUrl(
						activeFile,
						frontmatter
					);
				if (recordingUrl) {
					archivedRecording.recordingUrl = recordingUrl;
				}
			}
			this.currentMeetingDateParts =
				meetingFolderResult?.dateParts ??
			preferredDateParts ??
			this.meetingFiles.extractDatePartsFromFrontmatter(
				frontmatter
			) ??
			this.meetingFiles.deriveDatePartsFromNotePath(activeFile);
		this.scheduleManager.updateScheduleSummary(frontmatter);
		this.updateDeleteButtonState();

		const resolvedAudioFile = hasAudio && audioPath
			? this.plugin.app.vault.getAbstractFileByPath(audioPath)
			: null;
		if (!(resolvedAudioFile instanceof TFile)) {
			this.attachments.setAudioPath(null);
		}
		await this.syncAttachments();

		const setTranscriptProps = (props: Record<string, unknown>) => {
			this.transcriptComponent?.$set(props);
		};

		let playerEl: HTMLElement | undefined;
		if (hasAudio && audioPath) {
			const audioNote = new AudioNote(
				noteTitle,
				undefined,
				audioPath,
				0,
				Infinity,
				1,
				this.currentTranscriptPath || undefined,
				undefined,
				undefined,
				undefined,
				false,
				false
			);

			[, playerEl] = this.plugin.createAudioPlayerElements(
				audioNote,
				setTranscriptProps
			);
		}

		setTranscriptProps({
			title: "Live Transcript",
				playerContainer: playerEl ?? null,
				isTranscribing: this.isTranscribingMeeting,
				needsAudioUpload: !hasAudio,
				audioUploadInProgress: this.isUploadingMeetingAudio,
				transcriptUploadInProgress: this.isUploadingTranscript,
				canTranscribeDeepgram:
					this.transcriptionService.canUseDeepgram() &&
					Boolean(this.currentAudioPath),
				canTranscribeScriberr:
					this.transcriptionService.canUseScriberr() &&
					Boolean(this.currentAudioPath),
			hasTranscript: Boolean(this.currentTranscriptPath),
			onUploadMeetingAudio: (files: File[]) =>
				this.handleMeetingAudioUpload(files),
			onUploadTranscript: (files: File[]) =>
				this.handleTranscriptFileUpload(files),
			onTranscribeMeeting: (provider: "deepgram" | "scriberr") =>
				this.handleTranscriptionRequest(provider),
		});

		if (this.currentTranscriptPath) {
			await this.loadTranscript(this.currentTranscriptPath);
		} else {
			setTranscriptProps({
				segments: [],
				transcriptText: "",
				metadataDuration: null,
			});
		}
	}

	private async loadTranscript(path: string): Promise<void> {
		try {
			const transcript: Transcript | undefined =
				await this.plugin.transcriptDatastore.getTranscript(
					path
				);
			if (!transcript) {
			this.transcriptComponent?.$set({
				segments: [],
				transcriptText: "",
				metadataDuration: null,
				});
				return;
			}
			const segments =
				transcript.segments as TranscriptSegmentWithSpeaker[];
			const duration =
				segments.length > 0
					? Math.max(
							...segments.map((segment) =>
								Number(segment.end ?? segment.start ?? 0)
							)
					  )
					: null;
			this.transcriptComponent?.$set({
				segments,
				transcriptText: transcript.getEntireTranscript(),
				metadataDuration: duration,
			});
		} catch (error) {
			console.error(error);
			new Notice("Could not load transcript.", 4000);
		}
	}

	private renderBase() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("audio-notes-transcript-view");

		this.meetingContainer = containerEl.createDiv({
			cls: "aan-transcript-meeting",
		});
		this.header = new MeetingHeader(this.meetingContainer, {
			onLabelClick: () => this.labelManager.openLabelPicker(),
			onAttendeeClick: () => this.attendeeManager.openAttendeePicker(),
			onScheduleEdit: () => this.scheduleManager.openScheduleEditor(),
			onDelete: () => {
				void this.confirmDeleteCurrentMeeting();
			},
		});

		this.transcriptWrapper = this.meetingContainer.createDiv({
			cls: "audio-note-transcript-wrapper",
		});

		this.transcriptComponent = new TranscriptDisplay({
			target: this.transcriptWrapper,
			props: {
				segments: [],
				transcriptText: "",
				metadataDuration: null,
				isTranscribing: false,
				syncWithAudio: true,
				onSeekToTime: () => {},
				playerContainer: null,
				attachments: [],
				attachmentsEnabled: false,
				onUploadAttachments: (files: File[]) =>
					this.handleAttachmentUpload(files),
				onOpenAttachment: (path: string) =>
					this.openAttachment(path),
				onDeleteAttachment: (path: string) =>
					this.deleteAttachment(path),
				speakerLabelOverrides: this.speakerLabelOverrides,
					onRenameSpeaker: async (
						speakerKey: string,
						newLabel: string
					) => {
						await this.speakerLabelManager.renameSpeaker(
							speakerKey,
							newLabel
						);
					},
			},
		});

		this.dashboardContainer = containerEl.createDiv({
			cls: "aan-transcript-dashboard is-hidden",
		});
		this.dashboardPlaceholder = this.dashboardContainer.createEl("p", {
			text: "Open a meeting note or pick one from the calendar below.",
			cls: "aan-dashboard-placeholder",
		});
	}

	private renderHeader(file: TFile) {
		this.header?.setTitle(file.basename);
		this.updateLabelHeader();
		this.updateDeleteButtonState();
		this.scheduleManager.updateScheduleSummary();
	}

	private renderEmpty(message: string) {
		if (!this.transcriptWrapper) return;
		this.transcriptWrapper.empty();
		this.transcriptWrapper.createEl("p", {
			text: message,
			cls: "aan-transcript-empty-state",
		});
	}

	private updateLabelHeader() {
		if (!this.header) return;
		const canEdit =
			this.mode === "meeting" && Boolean(this.currentMeetingFile);
		this.updateDeleteButtonState();
		const text = this.currentMeetingLabel
			? this.currentMeetingLabel.displayName || this.currentMeetingLabel.tag
			: "";
		const placeholder = canEdit
			? "Select or create label"
			: "Open a meeting note to label it";
		this.header.setLabel({
			text,
			placeholder,
			canEdit,
			hasValue: Boolean(text),
		});
	}

	private updateAttendeeDisplay() {
		if (!this.header) return;
		const canEdit =
			this.mode === "meeting" && Boolean(this.currentMeetingFile);
		this.header.setAttendees(this.currentAttendees, canEdit);
	}

	private updateDeleteButtonState() {
		const enabled =
			this.mode === "meeting" &&
			Boolean(this.currentMeetingFile) &&
			!this.isDeletingMeeting;
		this.header?.setDeleteEnabled(enabled);
	}

	private async confirmDeleteCurrentMeeting() {
		await this.deletionManager.confirmDeleteCurrentMeeting();
	}

	public async showDashboard(): Promise<void> {
		this.currentFilePath = null;
		this.currentTranscriptPath = null;
		this.currentAudioPath = null;
		this.currentMeetingLabel = undefined;
		this.updateLabelHeader();
		this.resetAttachments();
		this.setMode("dashboard");
		this.updateDeleteButtonState();
			this.scheduleManager.updateScheduleSummary(null);
		this.meetingContainer?.addClass("is-hidden");
		this.dashboardContainer?.removeClass("is-hidden");
		this.dashboardController.ensure(this.dashboardContainer);
		this.dashboardController.scheduleRefresh();
	}

	private resetAttachments() {
		this.attachments.reset();
		this.attachments.setMeetingFilePath(null);
		this.currentHasAudioReference = false;
		this.transcriptComponent?.$set({
			attachments: [],
			attachmentsEnabled: false,
		});
		this.currentMeetingFile = null;
		this.currentMeetingDateParts = null;
		this.updateSpeakerLabelOverrides({});
	}

	private updateSpeakerLabelOverrides(
		overrides: Record<string, string>
	): void {
		this.speakerLabelOverrides = overrides;
		this.transcriptComponent?.$set({
			speakerLabelOverrides: { ...overrides },
		});
	}

	private async syncAttachments(): Promise<void> {
		const attachments = await this.attachments.refresh();
		this.transcriptComponent?.$set({
			attachments,
			attachmentsEnabled: this.attachments.hasAttachmentSupport(),
		});
	}
	private async handleAttachmentUpload(files: File[]): Promise<void> {
		await this.attachments.upload(files);
		await this.syncAttachments();
	}

	private async openAttachment(path: string): Promise<void> {
		const opened = await this.attachments.open(path);
		if (!opened) {
			await this.syncAttachments();
		}
	}

	private async deleteAttachment(path: string): Promise<void> {
		const changed = await this.attachments.delete(path);
		if (!changed) {
			await this.syncAttachments();
			return;
		}
		await this.syncAttachments();
	}

	private async openFile(path: string, newLeaf: boolean) {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			return;
		}
		if (newLeaf) {
			const workspace = this.plugin.app.workspace as any;
			let leaf: WorkspaceLeaf | null = null;
			if (typeof workspace.getLeaf === "function") {
				leaf = workspace.getLeaf("tab");
			}
			if (!leaf) {
				leaf = this.plugin.app.workspace.getLeaf(true);
			}
			if (!leaf) return;
			await leaf.openFile(file);
			this.plugin.app.workspace.setActiveLeaf(leaf, true, true);
			return;
		}
		const leaf = this.plugin.app.workspace.getLeaf(false);
		await leaf.openFile(file);
	}

	private async handleMeetingAudioUpload(files: File[]): Promise<void> {
		const meetingFile = this.currentMeetingFile;
		if (!meetingFile || !files?.length) {
			new Notice("Open a meeting note before uploading audio.", 4000);
			return;
		}
		const upload = files[0];
		if (!upload) return;
		this.isUploadingMeetingAudio = true;
		this.transcriptComponent?.$set({
			audioUploadInProgress: true,
		});
		try {
			const cache =
				this.plugin.app.metadataCache.getFileCache(meetingFile);
			const dateParts =
				this.currentMeetingDateParts ??
				this.meetingFiles.extractDatePartsFromFrontmatter(
					(cache?.frontmatter ?? {}) as Record<string, unknown>
				) ??
				this.meetingFiles.deriveDatePartsFromNotePath(
					meetingFile
				) ?? {
					year: new Date().getFullYear().toString(),
					month: (new Date().getMonth() + 1)
						.toString()
						.padStart(2, "0"),
					day: new Date()
						.getDate()
						.toString()
						.padStart(2, "0"),
				};
			this.currentMeetingDateParts = dateParts;
			const meetingTitle =
				(cache?.frontmatter?.["title"] as string) ??
				meetingFile.basename;
				const audioInfo = await this.meetingFiles.saveUploadedAudioFile(
					upload,
					dateParts,
					meetingTitle
				);
				await this.plugin.app.fileManager.processFrontMatter(
					meetingFile,
					(fm) => {
						delete fm["media_uri"];
						delete fm["audio"];
						delete fm["media"];
						if (audioInfo.audioPath) {
							fm["media_uri"] = audioInfo.audioPath;
							delete fm["recording_archive"];
							delete fm["recording_drive_path"];
							delete fm["recording_url"];
							return;
						}
						if (audioInfo.recordingDrivePath) {
							fm["recording_archive"] =
								audioInfo.recordingArchive || "google-drive";
							fm["recording_drive_path"] =
								audioInfo.recordingDrivePath;
							if (audioInfo.recordingUrl) {
								fm["recording_url"] = audioInfo.recordingUrl;
							} else {
								delete fm["recording_url"];
							}
						}
					}
				);
				new Notice("Meeting audio uploaded.", 4000);
				this.currentAudioPath =
					audioInfo.localAudioPath ?? audioInfo.audioPath ?? null;
				this.currentHasAudioReference = true;
				if (audioInfo.meetingFolder) {
					await this.attachments.setAttachmentFolder(
						audioInfo.meetingFolder
					);
				}
				this.attachments.setAudioPath(this.currentAudioPath);
				await this.showMeetingFile(meetingFile);
		} catch (error) {
			console.error("Audio Notes: Meeting audio upload failed.", error);
			new Notice("Could not upload meeting audio.", 6000);
		} finally {
			this.isUploadingMeetingAudio = false;
			this.transcriptComponent?.$set({
				audioUploadInProgress: false,
			});
		}
	}

	private async handleTranscriptFileUpload(files: File[]): Promise<void> {
		const meetingFile = this.currentMeetingFile;
		if (!meetingFile || !files?.length) {
			new Notice("Open a meeting note before uploading a transcript.", 4000);
			return;
		}
		const allText = files.every((file) => {
			const name = file.name.toLowerCase();
			const isTxt = name.endsWith(".txt");
			const isPlainText =
				typeof file.type === "string" &&
				(file.type === "text/plain" || file.type === "text/markdown");
			return isTxt || isPlainText;
		});
		const upload = files[0];
		if (!upload) return;
		const previousTranscript = this.currentTranscriptPath;
		this.isUploadingTranscript = true;
		this.transcriptComponent?.$set({
			transcriptUploadInProgress: true,
		});
		try {
			const transcriptPath = allText
				? await this.meetingFiles.saveMergedTextTranscripts(files)
				: await this.meetingFiles.saveUploadedTranscriptFile(upload);
			await this.plugin.app.fileManager.processFrontMatter(
				meetingFile,
				(fm) => {
					fm["transcript_uri"] = transcriptPath;
				}
			);
			this.currentTranscriptPath = transcriptPath;
			if (
				previousTranscript &&
				previousTranscript !== transcriptPath
			) {
				const oldFile =
					this.plugin.app.vault.getAbstractFileByPath(
						previousTranscript
					);
				if (oldFile instanceof TFile) {
					try {
						await this.plugin.app.vault.delete(oldFile);
					} catch (error) {
						console.error(
							"Audio Notes: Could not remove previous transcript file",
							error
						);
					}
				}
				this.plugin.transcriptDatastore.cache.delete(
					previousTranscript
				);
			}
				this.transcriptComponent?.$set({
					hasTranscript: true,
					needsAudioUpload: !this.currentHasAudioReference,
				});
			await this.loadTranscript(transcriptPath);
			new Notice("Transcript uploaded.", 4000);
		} catch (error) {
			console.error("Audio Notes: Transcript upload failed.", error);
			new Notice("Could not upload transcript.", 6000);
		} finally {
			this.isUploadingTranscript = false;
			this.transcriptComponent?.$set({
				transcriptUploadInProgress: false,
			});
		}
	}

	private async handleTranscriptionRequest(
		provider: "deepgram" | "scriberr"
	): Promise<void> {
		if (!this.currentMeetingFile || !this.currentAudioPath) {
			new Notice(
				this.currentHasAudioReference
					? "This recording is archived outside the vault and is not locally available for transcription on this device."
					: "Upload meeting audio before transcribing.",
				5000
			);
			return;
		}
		if (
			provider === "deepgram" &&
			!this.transcriptionService.canUseDeepgram()
		) {
			new Notice("Deepgram is not configured in settings.", 4000);
			return;
		}
		if (
			provider === "scriberr" &&
			!this.transcriptionService.canUseScriberr()
		) {
			new Notice("Scriberr is not configured in settings.", 4000);
			return;
		}
		this.isTranscribingMeeting = true;
		this.transcriptComponent?.$set({ isTranscribing: true });
		try {
			const transcriptPath =
				await this.transcriptionService.requestTranscription(
					provider,
					this.currentAudioPath
				);
			await this.plugin.app.fileManager.processFrontMatter(
				this.currentMeetingFile,
				(fm) => {
					fm["transcript_uri"] = transcriptPath;
				}
			);
			this.currentTranscriptPath = transcriptPath;
			await this.loadTranscript(transcriptPath);
			new Notice("Transcript saved.", 4000);
		} catch (error) {
			console.error("Audio Notes: Could not transcribe audio.", error);
			new Notice("Could not transcribe audio.", 6000);
		} finally {
			this.isTranscribingMeeting = false;
			this.transcriptComponent?.$set({ isTranscribing: false });
		}
}
}
