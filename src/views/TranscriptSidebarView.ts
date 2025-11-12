import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import TranscriptDisplay from "../transcript-view/TranscriptDisplay.svelte";
import type { TranscriptSegmentWithSpeaker } from "../transcript-view/types";
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
	MeetingLabelPickerModal,
	type MeetingLabelSelection,
} from "../MeetingLabelPickerModal";
import { MeetingLabelCategoryModal } from "../settings/MeetingLabelCategoryModal";
import {
	buildMeetingLabelInfo,
	getEffectiveMeetingLabelCategories,
	type MeetingLabelInfo,
	normalizeTagPrefix,
	slugifyTagSegment,
} from "../meeting-labels";
import {
	applyMeetingLabelToFile,
	getMeetingLabelFromFrontmatter,
} from "../meeting-label-manager";
import { collectTags } from "../meeting-events";

export const AUDIO_NOTES_TRANSCRIPT_VIEW = "audio-notes-transcript-view";

interface TranscriptSidebarState {
	file?: string;
}

export class TranscriptSidebarView extends ItemView {
	private transcriptComponent: TranscriptDisplay | null = null;
	private transcriptWrapper: HTMLDivElement | null = null;
	private headerEl: HTMLDivElement | null = null;
	private labelActionsEl: HTMLDivElement | null = null;
	private labelInputEl: HTMLInputElement | null = null;
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
	private currentAudioPath: string | null = null;
	private readonly meetingFiles: MeetingFileService;
	private readonly attachments: AttachmentManager;
	private readonly dashboardController: DashboardController;
	private readonly transcriptionService: TranscriptionService;
	private currentMeetingLabel: MeetingLabelInfo | undefined;

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
		let meetingFolderResult: MeetingFolderResult | null = null;
		let attachmentFolder = noteFolderPath;
		if (hasAudio) {
			meetingFolderResult = await this.meetingFiles.ensureMeetingFolderForAudio(
				activeFile,
				audioPath!,
				audioFieldKey,
				noteTitle
			);
			if (meetingFolderResult) {
				audioPath = meetingFolderResult.audioPath;
				if (meetingFolderResult.meetingFolder) {
					attachmentFolder = meetingFolderResult.meetingFolder;
				}
				if (meetingFolderResult.dateParts) {
					const relocated = await this.meetingFiles.ensureMeetingNoteFolder(
						activeFile,
						meetingFolderResult.dateParts
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

		this.currentMeetingFile = activeFile;
		this.currentMeetingDateParts =
			meetingFolderResult?.dateParts ??
			this.meetingFiles.extractDatePartsFromFrontmatter(
				frontmatter
			) ??
			this.meetingFiles.deriveDatePartsFromNotePath(activeFile);

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
		this.headerEl = this.meetingContainer.createDiv({
			cls: "aan-transcript-sidebar-header",
		});
		const titleEl = this.headerEl.createEl("h2", {
			text: "Transcript",
		});
		titleEl.classList.add("aan-transcript-title");
		this.buildHeaderActions();

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

	private buildHeaderActions() {
		if (!this.headerEl) return;
		this.labelActionsEl = this.headerEl.createDiv({
			cls: "aan-transcript-sidebar-actions",
		});
		const field = this.labelActionsEl.createDiv({
			cls: "aan-transcript-label-field",
		});
		this.labelInputEl = field.createEl("input", {
			type: "text",
			attr: { readonly: "readonly" },
		}) as HTMLInputElement;
		this.labelInputEl.classList.add("aan-transcript-label-input");
		this.labelInputEl.placeholder = "Select or create label";
		this.labelInputEl.title = "Click to assign a meeting label";
		this.labelInputEl.addEventListener("click", (event) => {
			event.preventDefault();
			this.openLabelPicker();
		});
		this.labelInputEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				this.openLabelPicker();
			}
		});
	}

	private renderHeader(file: TFile) {
		if (!this.headerEl) return;
		this.headerEl
			.querySelector(".aan-transcript-title")
			?.setText(file.basename);
		this.updateLabelHeader();
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
		if (!this.labelInputEl) {
			return;
		}
		const canEdit =
			this.mode === "meeting" && Boolean(this.currentMeetingFile);
		this.labelInputEl.toggleAttribute("disabled", !canEdit);
		if (!canEdit) {
			this.labelInputEl.value = "";
			this.labelInputEl.classList.add("is-placeholder");
			this.labelInputEl.placeholder = "Open a meeting note to label it";
			return;
		}
		this.labelInputEl.placeholder = "Select or create label";
		if (this.currentMeetingLabel) {
			this.labelInputEl.value =
				this.currentMeetingLabel.displayName || this.currentMeetingLabel.tag;
			this.labelInputEl.classList.remove("is-placeholder");
		} else {
			this.labelInputEl.value = "";
			this.labelInputEl.classList.add("is-placeholder");
		}
	}

	private openLabelPicker(initialQuery = "") {
		if (this.mode !== "meeting" || !this.currentMeetingFile) {
			new Notice("Open a meeting note to assign a label.", 4000);
			return;
		}

		// Get current tags from the file
		const cache = this.app.metadataCache.getFileCache(this.currentMeetingFile);
		const currentTags = collectTags(cache).filter((tag) => {
			const categories = getEffectiveMeetingLabelCategories(
				this.plugin.settings.meetingLabelCategories
			);
			return categories.some((cat) => tag.startsWith(cat.tagPrefix));
		});

		const picker = new MeetingLabelPickerModal(
			this.app,
			this.plugin,
			(selection) => {
				void this.applyMeetingLabelSelection(selection);
			},
			{
				onCreateCategory: (query) =>
					this.openCategoryModal(query, true),
				currentTags,
				onRemoveTag: (tag) => {
					void this.removeMeetingTag(tag);
				},
			}
		);
		if (initialQuery) {
			picker.setInitialQuery(initialQuery);
		}
		picker.open();
	}

	private async applyMeetingLabelSelection(
		selection: MeetingLabelSelection
	) {
		if (!this.currentMeetingFile) {
			return;
		}
		try {
			await applyMeetingLabelToFile(
				this.app,
				this.currentMeetingFile,
				selection.tag
			);
			this.currentMeetingLabel = selection.label;
			this.updateLabelHeader();
			new Notice(
				selection.label.displayName
					? `Meeting labeled as ${selection.label.displayName}.`
					: "Meeting label updated."
			);
		} catch (error) {
			console.error(error);
			new Notice("Could not update meeting label.", 6000);
		}
	}

	private async removeMeetingTag(tag: string) {
		if (!this.currentMeetingFile) {
			return;
		}
		try {
			await this.app.fileManager.processFrontMatter(
				this.currentMeetingFile,
				(frontmatter) => {
					// Remove from tags array
					if (Array.isArray(frontmatter.tags)) {
						frontmatter.tags = frontmatter.tags.filter(
							(t: string) => t !== tag && t !== `#${tag}`
						);
					}
					// If this was the meeting_label, clear it
					if (frontmatter.meeting_label === tag) {
						delete frontmatter.meeting_label;
					}
				}
			);
			this.updateLabelHeader();
			new Notice(`Removed tag: ${tag}`);
		} catch (error) {
			console.error(error);
			new Notice("Could not remove tag.", 6000);
		}
	}

	private openCategoryModal(initialQuery?: string, reopenAfter = false) {
		const initialName = this.formatCategoryName(initialQuery);
		const initialPrefix = this.formatCategoryPrefix(initialQuery);
		new MeetingLabelCategoryModal(
			this.app,
			this.plugin,
			{
				initialName,
				initialPrefix,
			},
			() => {
				this.updateLabelHeader();
				if (reopenAfter) {
					setTimeout(
						() => this.openLabelPicker(initialQuery ?? ""),
						100
					);
				}
			}
		).open();
	}

	private formatCategoryName(raw?: string): string {
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

	private formatCategoryPrefix(raw?: string): string {
		if (!raw?.trim()) {
			return "";
		}
		return (
			normalizeTagPrefix(raw) ||
			`${slugifyTagSegment(raw) || "category"}/`
		);
	}

	public async showDashboard(): Promise<void> {
		this.currentFilePath = null;
		this.currentTranscriptPath = null;
		this.currentAudioPath = null;
		this.currentMeetingLabel = undefined;
		this.updateLabelHeader();
		this.resetAttachments();
		this.setMode("dashboard");
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
