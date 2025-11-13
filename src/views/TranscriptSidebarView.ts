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
import { getMeetingLabelFromFrontmatter } from "../meeting-label-manager";
import { collectTags } from "../meeting-events";
import { confirmWithModal } from "../modals/ConfirmModal";
import { MeetingHeader } from "./transcript-sidebar/MeetingHeader";
import type { MeetingScheduleInfo } from "./transcript-sidebar/MeetingScheduleInfo";
import { MeetingLabelManager } from "./transcript-sidebar/MeetingLabelManager";
import { MeetingScheduleManager } from "./transcript-sidebar/MeetingScheduleManager";
import { SpeakerLabelManager } from "./transcript-sidebar/SpeakerLabelManager";

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
	private isTranscribingMeeting = false;
	private isDeletingMeeting = false;
	private currentAudioPath: string | null = null;
	private readonly meetingFiles: MeetingFileService;
	private readonly attachments: AttachmentManager;
	private readonly dashboardController: DashboardController;
	private readonly transcriptionService: TranscriptionService;
	private readonly labelManager: MeetingLabelManager;
	private readonly scheduleManager: MeetingScheduleManager;
	private readonly speakerLabelManager: SpeakerLabelManager;
	private currentMeetingLabel: MeetingLabelInfo | undefined;
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

		this.currentTranscriptPath =
			typeof transcriptPath === "string"
				? transcriptPath
				: null;

		const hasAudio = Boolean(audioPath && audioPath.trim().length);
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
		const preferredDateParts =
			this.meetingFiles.extractDatePartsFromFrontmatter(
				frontmatter
			) ??
			this.meetingFiles.deriveDatePartsFromNotePath(activeFile) ??
			this.currentMeetingDateParts;

		let meetingFolderResult: MeetingFolderResult | null = null;
		let attachmentFolder = noteFolderPath;
		if (hasAudio) {
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
			canTranscribeDeepgram: this.transcriptionService.canUseDeepgram(),
			canTranscribeScriberr: this.transcriptionService.canUseScriberr(),
			hasTranscript: Boolean(this.currentTranscriptPath),
			onUploadMeetingAudio: (files: File[]) =>
				this.handleMeetingAudioUpload(files),
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

	private updateDeleteButtonState() {
		const enabled =
			this.mode === "meeting" &&
			Boolean(this.currentMeetingFile) &&
			!this.isDeletingMeeting;
		this.header?.setDeleteEnabled(enabled);
	}

	private async confirmDeleteCurrentMeeting() {
		if (this.mode !== "meeting" || !this.currentMeetingFile) {
			new Notice("Open a meeting note to delete it.", 4000);
			return;
		}
		const confirmed = await confirmWithModal(this.app, {
			title: "Delete meeting?",
			message:
				"This will permanently delete the note, linked transcript, audio file, and attachments.",
			confirmText: "Delete meeting",
			cancelText: "Cancel",
		});
		if (!confirmed) {
			return;
		}
		await this.deleteCurrentMeeting();
	}

	private async deleteCurrentMeeting(): Promise<void> {
		const meetingFile = this.currentMeetingFile;
		if (!meetingFile) {
			return;
		}
		this.isDeletingMeeting = true;
		this.updateDeleteButtonState();
		const failures: string[] = [];
		const deleteFileIfExists = async (
			path: string | null | undefined
		): Promise<void> => {
			if (!path || path === meetingFile.path) {
				return;
			}
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) {
				return;
			}
			try {
				await this.plugin.app.vault.delete(file);
			} catch (error) {
				console.error("Audio Notes: Failed to delete file", path, error);
				failures.push(path);
			}
		};
		try {
			const attachmentFolder = this.attachments.getAttachmentFolder();
			let attachmentEntries: SidebarAttachment[] = [];
			try {
				attachmentEntries = await this.attachments.refresh();
			} catch (error) {
				console.error(
					"Audio Notes: Failed to refresh attachments prior to delete",
					error
				);
			}
			for (const attachment of attachmentEntries) {
				await deleteFileIfExists(attachment.path);
			}
			await deleteFileIfExists(this.currentAudioPath);
			await deleteFileIfExists(this.currentTranscriptPath);
			if (this.currentTranscriptPath) {
				this.plugin.transcriptDatastore.cache.delete(
					this.currentTranscriptPath
				);
			}
			await this.plugin.app.vault.delete(meetingFile);
			if (attachmentFolder) {
				await this.deleteFolderIfEmpty(attachmentFolder);
			}
			const audioParent = this.getParentPath(this.currentAudioPath);
			if (audioParent && audioParent !== attachmentFolder) {
				await this.deleteFolderIfEmpty(audioParent);
			}
			await this.showDashboard();
			this.dashboardController.scheduleRefresh();
			if (failures.length) {
				new Notice(
					`Meeting deleted, but some linked files could not be removed: ${failures.join(
						", "
					)}`,
					6000
				);
			} else {
				new Notice("Meeting deleted.", 4000);
			}
		} catch (error) {
			console.error("Audio Notes: Could not delete meeting", error);
			new Notice("Could not delete meeting.", 6000);
		} finally {
			this.isDeletingMeeting = false;
			this.updateDeleteButtonState();
		}
	}

	private async deleteFolderIfEmpty(path: string | null | undefined) {
		if (!path) {
			return;
		}
		const folder = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(folder instanceof TFolder)) {
			return;
		}
		if (folder.children.length > 0 || !this.shouldDeleteFolder(folder)) {
			return;
		}
		try {
			await this.plugin.app.vault.delete(folder);
		} catch (error) {
			console.error("Audio Notes: Failed to delete folder", path, error);
			return;
		}
		const parent = folder.parent;
		if (parent instanceof TFolder) {
			await this.deleteFolderIfEmpty(parent.path);
		}
	}

	private shouldDeleteFolder(folder: TFolder): boolean {
		const name = folder.name;
		if (/^[a-z0-9]{4}-/i.test(name)) {
			return true;
		}
		if (/^\d{4}$/.test(name) || /^\d{2}$/.test(name)) {
			return true;
		}
		return false;
	}

	private getParentPath(path: string | null | undefined): string | null {
		if (!path) return null;
		const segments = path.split("/").filter(Boolean);
		if (segments.length <= 1) {
			return null;
		}
		return segments.slice(0, -1).join("/");
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
					fm["media_uri"] = audioInfo.audioPath;
				}
			);
			new Notice("Meeting audio uploaded.", 4000);
			this.currentAudioPath = audioInfo.audioPath;
			await this.attachments.setAttachmentFolder(
				audioInfo.meetingFolder
			);
			this.attachments.setAudioPath(audioInfo.audioPath);
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

	private async handleTranscriptionRequest(
		provider: "deepgram" | "scriberr"
	): Promise<void> {
		if (!this.currentMeetingFile || !this.currentAudioPath) {
			new Notice("Upload meeting audio before transcribing.", 4000);
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
