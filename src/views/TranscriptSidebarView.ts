import {
	ItemView,
	Notice,
	TFile,
	TFolder,
	WorkspaceLeaf,
	setIcon,
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
import { confirmWithModal } from "../modals/ConfirmModal";
import {
	buildScheduleCallout,
	resolveMeetingContext,
} from "../MeetingNoteTemplate";
import {
	EditMeetingScheduleModal,
	type MeetingScheduleUpdate,
} from "../modals/EditMeetingScheduleModal";

export const AUDIO_NOTES_TRANSCRIPT_VIEW = "audio-notes-transcript-view";
const SPEAKER_LABELS_FIELD = "aan_speaker_labels";

interface TranscriptSidebarState {
	file?: string;
}

interface MeetingScheduleInfo {
	start: Date;
	end: Date;
	startDate: string;
	startTime: string;
	endDate: string;
	endTime: string;
	dateLabel: string;
	timeLabel: string;
}

export class TranscriptSidebarView extends ItemView {
	private transcriptComponent: TranscriptDisplay | null = null;
	private transcriptWrapper: HTMLDivElement | null = null;
	private headerEl: HTMLDivElement | null = null;
	private labelActionsEl: HTMLDivElement | null = null;
	private labelInputEl: HTMLInputElement | null = null;
	private scheduleSummaryEl: HTMLDivElement | null = null;
	private scheduleDateEl: HTMLDivElement | null = null;
	private scheduleTimeEl: HTMLDivElement | null = null;
	private scheduleEditButtonEl: HTMLButtonElement | null = null;
	private meetingContainer: HTMLDivElement | null = null;
	private dashboardContainer: HTMLDivElement | null = null;
	private dashboardPlaceholder: HTMLParagraphElement | null = null;
	private deleteButtonEl: HTMLButtonElement | null = null;
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

		this.updateSpeakerLabelOverrides(
			this.extractSpeakerLabelOverrides(frontmatter)
		);

		this.currentMeetingFile = activeFile;
		this.currentMeetingDateParts =
			meetingFolderResult?.dateParts ??
			this.meetingFiles.extractDatePartsFromFrontmatter(
				frontmatter
			) ??
			this.meetingFiles.deriveDatePartsFromNotePath(activeFile);
		this.updateScheduleSummary(frontmatter);
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
		this.headerEl = this.meetingContainer.createDiv({
			cls: "aan-transcript-sidebar-header",
		});
		const titleEl = this.headerEl.createEl("h2", {
			text: "Transcript",
		});
		titleEl.classList.add("aan-transcript-title");
		this.scheduleSummaryEl = this.headerEl.createDiv({
			cls: "aan-transcript-schedule is-placeholder",
		});
		this.scheduleDateEl = this.scheduleSummaryEl.createDiv({
			cls: "aan-transcript-schedule-date",
			text: "Open a meeting note to view schedule",
		});
		this.scheduleTimeEl = this.scheduleSummaryEl.createDiv({
			cls: "aan-transcript-schedule-time",
			text: "",
		});
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
				speakerLabelOverrides: this.speakerLabelOverrides,
				onRenameSpeaker: async (
					speakerKey: string,
					newLabel: string
				) => {
					await this.handleSpeakerRename(speakerKey, newLabel);
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
		this.scheduleEditButtonEl = this.labelActionsEl.createEl("button", {
			cls: "aan-transcript-btn icon-only",
			attr: {
				type: "button",
				title: "Edit meeting date & time",
				"aria-label": "Edit meeting date and time",
			},
		});
		setIcon(this.scheduleEditButtonEl, "calendar-clock");
		this.scheduleEditButtonEl.addEventListener("click", () => {
			this.openScheduleEditor();
		});
		this.deleteButtonEl = this.labelActionsEl.createEl("button", {
			cls: "aan-transcript-btn icon-only danger",
			attr: {
				type: "button",
				title: "Delete meeting",
				"aria-label": "Delete meeting",
			},
		});
		setIcon(this.deleteButtonEl, "trash");
		this.deleteButtonEl.addEventListener("click", () => {
			void this.confirmDeleteCurrentMeeting();
		});
	}

	private renderHeader(file: TFile) {
		if (!this.headerEl) return;
		this.headerEl
			.querySelector(".aan-transcript-title")
			?.setText(file.basename);
		this.updateLabelHeader();
		this.updateDeleteButtonState();
		this.updateScheduleSummary();
	}

	private renderEmpty(message: string) {
		if (!this.transcriptWrapper) return;
		this.transcriptWrapper.empty();
		this.transcriptWrapper.createEl("p", {
			text: message,
			cls: "aan-transcript-empty-state",
		});
	}

	private updateScheduleSummary(
		frontmatter?: Record<string, unknown> | null
	) {
		if (
			!this.scheduleSummaryEl ||
			!this.scheduleDateEl ||
			!this.scheduleTimeEl
		) {
			return;
		}
		const canEdit =
			this.mode === "meeting" && Boolean(this.currentMeetingFile);
		this.scheduleEditButtonEl?.toggleAttribute("disabled", !canEdit);
		if (!canEdit) {
			this.currentScheduleInfo = null;
			this.scheduleSummaryEl.classList.add("is-placeholder");
			this.scheduleDateEl.setText(
				"Open a meeting note to view schedule"
			);
			this.scheduleTimeEl.setText("");
			return;
		}
		const source =
			frontmatter ??
			((this.currentMeetingFile &&
				(this.plugin.app.metadataCache.getFileCache(
					this.currentMeetingFile
				)?.frontmatter as Record<string, unknown> | undefined)) ??
				null);
		const info = this.extractScheduleInfo(source);
		if (!info) {
			this.currentScheduleInfo = null;
			this.scheduleSummaryEl.classList.add("is-placeholder");
			this.scheduleDateEl.setText("Set meeting date");
			this.scheduleTimeEl.setText(
				"Use the calendar button to pick a time"
			);
			return;
		}
		this.currentScheduleInfo = info;
		this.scheduleSummaryEl.classList.remove("is-placeholder");
		this.scheduleDateEl.setText(info.dateLabel);
		this.scheduleTimeEl.setText(info.timeLabel);
	}

	private extractScheduleInfo(
		frontmatter?: Record<string, unknown> | null
	): MeetingScheduleInfo | null {
		if (!frontmatter) {
			return null;
		}
		const start =
			this.parseDateTime(
				this.normalizeDateValue(frontmatter["start_date"]),
				this.normalizeTimeValue(frontmatter["start_time"])
			) ?? this.parseIsoDate(frontmatter["start"]);
		if (!start) {
			return null;
		}
		const end =
			this.parseDateTime(
				this.normalizeDateValue(
					frontmatter["end_date"] ?? frontmatter["start_date"]
				),
				this.normalizeTimeValue(
					frontmatter["end_time"] ?? frontmatter["start_time"]
				)
			) ?? this.parseIsoDate(frontmatter["end"]) ?? start;
		const context = resolveMeetingContext(this.plugin.settings, {
			title: this.currentMeetingFile?.basename ?? "Meeting",
			audioPath: this.currentAudioPath ?? "",
			transcriptPath: this.currentTranscriptPath ?? undefined,
			start,
			end,
		});
		return {
			start,
			end,
			startDate: context.startDate,
			startTime: context.startTime,
			endDate: context.endDate,
			endTime: context.endTime,
			dateLabel: context.dateLabel,
			timeLabel: context.timeLabel,
		};
	}

	private normalizeDateValue(value: unknown): string | null {
		if (typeof value === "string" && value.trim().length) {
			return value.trim();
		}
		return null;
	}

	private normalizeTimeValue(value: unknown): string | null {
		if (typeof value === "string" && value.trim().length) {
			return value.trim();
		}
		return null;
	}

	private parseDateTime(
		dateStr?: string | null,
		timeStr?: string | null
	): Date | null {
		if (!dateStr) {
			return null;
		}
		const timePart =
			timeStr && timeStr.trim().length ? timeStr.trim() : "00:00";
		const iso = `${dateStr}T${timePart}`;
		const parsed = new Date(iso);
		return Number.isNaN(parsed.getTime()) ? null : parsed;
	}

	private parseIsoDate(value: unknown): Date | null {
		if (typeof value !== "string" || !value.trim().length) {
			return null;
		}
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? null : parsed;
	}

	private updateLabelHeader() {
		if (!this.labelInputEl) {
			return;
		}
		const canEdit =
			this.mode === "meeting" && Boolean(this.currentMeetingFile);
		this.labelInputEl.toggleAttribute("disabled", !canEdit);
		this.updateDeleteButtonState();
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

	private updateDeleteButtonState() {
		const enabled =
			this.mode === "meeting" &&
			Boolean(this.currentMeetingFile) &&
			!this.isDeletingMeeting;
		if (!this.deleteButtonEl) {
			return;
		}
		this.deleteButtonEl.toggleAttribute("disabled", !enabled);
	}

	private openScheduleEditor() {
		if (this.mode !== "meeting" || !this.currentMeetingFile) {
			new Notice("Open a meeting note to edit its schedule.", 4000);
			return;
		}
		new EditMeetingScheduleModal(this.app, {
			initialStartDate: this.currentScheduleInfo?.startDate,
			initialStartTime: this.currentScheduleInfo?.startTime,
			initialEndDate: this.currentScheduleInfo?.endDate,
			initialEndTime: this.currentScheduleInfo?.endTime,
			onSubmit: (update) => {
				void this.applyScheduleUpdate(update);
			},
		}).open();
	}

	private async applyScheduleUpdate(
		update: MeetingScheduleUpdate
	): Promise<void> {
		if (this.mode !== "meeting" || !this.currentMeetingFile) {
			new Notice("Open a meeting note to edit its schedule.", 4000);
			return;
		}
		const start = this.combineDateAndTime(
			update.startDate,
			update.startTime
		);
		if (!start) {
			new Notice("Invalid start date or time.", 4000);
			return;
		}
		const endInput = this.combineDateAndTime(
			update.endDate || update.startDate,
			update.endTime || update.startTime
		);
		const end =
			endInput && endInput.getTime() >= start.getTime()
				? endInput
				: new Date(start.getTime() + 60 * 60 * 1000);
		const startDateStr = this.formatFrontmatterDate(start);
		const endDateStr = this.formatFrontmatterDate(end);
		const startTimeStr = this.formatFrontmatterTime(start);
		const endTimeStr = this.formatFrontmatterTime(end);
		try {
			await this.plugin.app.fileManager.processFrontMatter(
				this.currentMeetingFile,
				(fm) => {
					fm.start = start.toISOString();
					fm.end = end.toISOString();
					fm.start_date = startDateStr;
					fm.start_time = startTimeStr;
					fm.end_date = endDateStr;
					fm.end_time = endTimeStr;
					fm.date = startDateStr;
				}
			);
			this.currentMeetingDateParts = {
				year: startDateStr.slice(0, 4),
				month: startDateStr.slice(5, 7),
				day: startDateStr.slice(8, 10),
			};
			const updatedFrontmatter = {
				start_date: startDateStr,
				start_time: startTimeStr,
				end_date: endDateStr,
				end_time: endTimeStr,
				start: start.toISOString(),
				end: end.toISOString(),
			};
			this.updateScheduleSummary(updatedFrontmatter);
			await this.refreshScheduleCallout(start, end);
			this.dashboardController.scheduleRefresh();
			new Notice("Meeting schedule updated.", 4000);
		} catch (error) {
			console.error(
				"Audio Notes: Could not update meeting schedule.",
				error
			);
			new Notice("Could not update meeting schedule.", 6000);
		}
	}

	private combineDateAndTime(
		dateStr?: string,
		timeStr?: string
	): Date | null {
		if (!dateStr) {
			return null;
		}
		const timePart =
			timeStr && timeStr.trim().length ? timeStr.trim() : "00:00";
		const iso = `${dateStr}T${timePart}`;
		const parsed = new Date(iso);
		return Number.isNaN(parsed.getTime()) ? null : parsed;
	}

	private formatFrontmatterDate(date: Date): string {
		const year = date.getFullYear().toString().padStart(4, "0");
		const month = (date.getMonth() + 1).toString().padStart(2, "0");
		const day = date.getDate().toString().padStart(2, "0");
		return `${year}-${month}-${day}`;
	}

	private formatFrontmatterTime(date: Date): string {
		const hours = date.getHours().toString().padStart(2, "0");
		const minutes = date.getMinutes().toString().padStart(2, "0");
		return `${hours}:${minutes}`;
	}

	private async refreshScheduleCallout(
		start: Date,
		end: Date
	): Promise<void> {
		const file = this.currentMeetingFile;
		if (!file) {
			return;
		}
		try {
			const content = await this.app.vault.read(file);
			const lines = content.split("\n");
			const scheduleIndex = lines.findIndex((line) =>
				line.trim().startsWith("> [!info] Schedule")
			);
			if (scheduleIndex === -1) {
				return;
			}
			let endIndex = scheduleIndex + 1;
			while (
				endIndex < lines.length &&
				lines[endIndex].trim().startsWith(">")
			) {
				endIndex += 1;
			}
			const context = resolveMeetingContext(this.plugin.settings, {
				title: file.basename,
				audioPath: this.currentAudioPath ?? "",
				transcriptPath: this.currentTranscriptPath ?? undefined,
				start,
				end,
			});
			const replacement = buildScheduleCallout(context).split("\n");
			lines.splice(
				scheduleIndex,
				Math.max(endIndex - scheduleIndex, 1),
				...replacement
			);
			await this.app.vault.modify(file, lines.join("\n"));
		} catch (error) {
			console.error(
				"Audio Notes: Could not refresh schedule callout.",
				error
			);
		}
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

	private openLabelPicker(initialQuery = "") {
		if (this.mode !== "meeting" || !this.currentMeetingFile) {
			new Notice("Open a meeting note to assign a label.", 4000);
			return;
		}

		// Get current tags from the file
		const cache = this.app.metadataCache.getFileCache(this.currentMeetingFile);
		const categories = getEffectiveMeetingLabelCategories(
			this.plugin.settings.meetingLabelCategories
		);
		const currentTagSet = new Set<string>();
		const frontmatterLabel = getMeetingLabelFromFrontmatter(
			(cache?.frontmatter as Record<string, unknown> | undefined) ?? undefined
		);
		if (frontmatterLabel) {
			currentTagSet.add(frontmatterLabel);
		}
		if (!currentTagSet.size && cache) {
			for (const tag of collectTags(cache)) {
				if (
					!categories.length ||
					categories.some((cat) => tag.startsWith(cat.tagPrefix))
				) {
					currentTagSet.add(tag);
				}
			}
		}
		if (this.currentMeetingLabel?.tag) {
			currentTagSet.add(this.currentMeetingLabel.tag);
		}
		const currentTags = Array.from(currentTagSet);
		console.log("Audio Notes: Meeting label picker tags", {
			file: this.currentMeetingFile?.path,
			currentTags,
			frontmatterLabel,
			currentMeetingLabel: this.currentMeetingLabel?.tag,
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

	private extractSpeakerLabelOverrides(
		source: Record<string, unknown> | undefined
	): Record<string, string> {
		if (!source) {
			return {};
		}
		const raw = source[SPEAKER_LABELS_FIELD];
		if (!raw || typeof raw !== "object") {
			return {};
		}
		const overrides: Record<string, string> = {};
		for (const [key, value] of Object.entries(
			raw as Record<string, unknown>
		)) {
			if (typeof value === "string") {
				const trimmed = value.trim();
				if (trimmed.length) {
					overrides[key] = trimmed;
				}
			}
		}
		return overrides;
	}

	private async handleSpeakerRename(
		speakerKey: string,
		newLabel: string
	): Promise<void> {
		if (!this.currentMeetingFile) {
			new Notice("Open a meeting note to rename speakers.", 4000);
			return;
		}
		const trimmed = newLabel?.trim();
		if (!trimmed) {
			new Notice("Enter a speaker name.", 4000);
			return;
		}
		if (this.speakerLabelOverrides[speakerKey] === trimmed) {
			return;
		}
		try {
			await this.app.fileManager.processFrontMatter(
				this.currentMeetingFile,
				(frontmatter) => {
					const overrides = this.extractSpeakerLabelOverrides(
						frontmatter as Record<string, unknown>
					);
					overrides[speakerKey] = trimmed;
					(frontmatter as Record<string, unknown>)[
						SPEAKER_LABELS_FIELD
					] = overrides;
				}
			);
			this.updateSpeakerLabelOverrides({
				...this.speakerLabelOverrides,
				[speakerKey]: trimmed,
			});
			new Notice(`Speaker renamed to ${trimmed}`, 3000);
		} catch (error) {
			console.error("Audio Notes: Could not rename speaker.", error);
			new Notice("Could not rename speaker.", 4000);
			throw error;
		}
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
		this.updateScheduleSummary(null);
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
