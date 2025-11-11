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
import SidebarPlanner from "../sidebar/SidebarPlanner.svelte";
import type { MeetingEvent } from "../meeting-events";
import {
	collectMeetingEvents,
	localDateKey,
} from "../meeting-events";

export const AUDIO_NOTES_TRANSCRIPT_VIEW = "audio-notes-transcript-view";

interface TranscriptSidebarState {
	file?: string;
}

export class TranscriptSidebarView extends ItemView {
	private transcriptComponent: TranscriptDisplay | null = null;
	private calendarComponent: SidebarPlanner | undefined;
	private transcriptWrapper: HTMLDivElement | null = null;
	private headerEl: HTMLDivElement | null = null;
	private meetingContainer: HTMLDivElement | null = null;
	private dashboardContainer: HTMLDivElement | null = null;
	private dashboardPlaceholder: HTMLParagraphElement | null = null;
	private currentFilePath: string | null = null;
	private currentTranscriptPath: string | null = null;
	private calendarEvents: MeetingEvent[] = [];
	private selectedDate: string = localDateKey(new Date());
	private refreshTimeout: number | null = null;
	private mode: "meeting" | "dashboard" = "dashboard";
	private dashboardListenersRegistered = false;
	private currentAttachments: SidebarAttachment[] = [];
	private attachmentFolderPath: string | null = null;
	private currentAudioPath: string | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: AutomaticAudioNotes
	) {
		super(leaf);
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
		this.destroyCalendar();
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
		this.setMode("meeting");
		this.currentFilePath = file.path;
		this.currentAudioPath = null;
		this.resetAttachments();
		if (!this.transcriptComponent) {
			this.renderBase();
		}
		this.dashboardContainer?.addClass("is-hidden");
		this.meetingContainer?.removeClass("is-hidden");
		this.renderHeader(file);

		const cache =
			this.plugin.app.metadataCache.getFileCache(file);
		const frontmatter = (cache?.frontmatter ??
			{}) as Record<string, unknown>;
		const audioPath = (frontmatter["media_uri"] ??
			frontmatter["audio"] ??
			frontmatter["media"]) as string | undefined;
		const transcriptPath = (frontmatter["transcript_uri"] ??
			frontmatter["transcript"]) as string | undefined;

		this.currentTranscriptPath =
			typeof transcriptPath === "string"
				? transcriptPath
				: null;


		if (!audioPath) {
			this.renderEmpty(
				"Add a `media_uri` property to this note to load the recording."
			);
			return;
		}

		this.currentAudioPath = audioPath;
		await this.prepareAttachmentFolder(audioPath);
		await this.refreshAttachmentsList();

		const title =
			(frontmatter["title"] as string | undefined) ||
			file.basename;
		const audioNote = new AudioNote(
			title,
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

		const setTranscriptProps = (props: Record<string, unknown>) => {
			this.transcriptComponent?.$set(props);
		};

		const [, playerEl] = this.plugin.createAudioPlayerElements(
			audioNote,
			setTranscriptProps
		);

		setTranscriptProps({
			title: "Live Transcript",
			playerContainer: playerEl ?? null,
			isTranscribing: false,
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

	private renderHeader(file: TFile) {
		if (!this.headerEl) return;
		this.headerEl
			.querySelector(".aan-transcript-title")
			?.setText(file.basename);
	}

	private renderEmpty(message: string) {
		if (!this.transcriptWrapper) return;
		this.transcriptWrapper.empty();
		this.transcriptWrapper.createEl("p", {
			text: message,
			cls: "aan-transcript-empty-state",
		});
	}

	public async showDashboard(): Promise<void> {
		this.currentFilePath = null;
		this.currentTranscriptPath = null;
		this.currentAudioPath = null;
		this.resetAttachments();
		this.setMode("dashboard");
		this.meetingContainer?.addClass("is-hidden");
		this.dashboardContainer?.removeClass("is-hidden");
		this.ensureCalendar();
		this.scheduleRefresh();
	}

	private ensureCalendar() {
		if (this.calendarComponent || !this.dashboardContainer) {
			return;
		}
	this.dashboardContainer.empty();
	this.calendarComponent = new SidebarPlanner({
		target: this.dashboardContainer,
		props: {
			events: this.calendarEvents,
			selectedDate: this.selectedDate,
			onSelectDate: (date: string) => {
				this.selectedDate = date;
				this.calendarComponent?.$set({
					selectedDate: this.selectedDate,
				});
			},
			onOpenNote: (path: string, newLeaf: boolean) =>
				this.openFile(path, newLeaf),
			onRefresh: () => this.refreshEvents(),
		},
	});
		this.registerDashboardListeners();
		this.refreshEvents();
	}

	private destroyCalendar() {
		if (this.refreshTimeout) {
			window.clearTimeout(this.refreshTimeout);
			this.refreshTimeout = null;
		}
		this.calendarComponent?.$destroy();
		this.calendarComponent = undefined;
		this.dashboardListenersRegistered = false;
	}

	private registerDashboardListeners() {
		if (this.dashboardListenersRegistered) {
			return;
		}
		this.dashboardListenersRegistered = true;
		const schedule = () => this.scheduleRefresh();
		this.registerEvent(this.plugin.app.metadataCache.on("changed", schedule));
		this.registerEvent(this.plugin.app.vault.on("create", schedule));
		this.registerEvent(this.plugin.app.vault.on("delete", schedule));
		this.registerEvent(this.plugin.app.vault.on("rename", schedule));
		// @ts-ignore custom workspace signal
		this.registerEvent(
			(this.plugin.app.workspace as any).on(
				"audio-notes:settings-updated",
				schedule
			)
		);
	}

	private scheduleRefresh() {
		if (this.refreshTimeout) {
			window.clearTimeout(this.refreshTimeout);
		}
		this.refreshTimeout = window.setTimeout(() => {
			this.refreshTimeout = null;
			this.refreshEvents();
		}, 200);
	}

	private refreshEvents() {
		this.calendarEvents = collectMeetingEvents(
			this.plugin.app,
			this.plugin.settings.calendarTagColors
		);
		if (
			this.calendarEvents.length &&
			!this.calendarEvents.some(
				(event) => event.displayDate === this.selectedDate
			)
		) {
			this.selectedDate = this.calendarEvents[0].displayDate;
		}
	this.calendarComponent?.$set({
		events: this.calendarEvents,
		selectedDate: this.selectedDate,
	});
}


	private resetAttachments() {
		this.currentAttachments = [];
		this.attachmentFolderPath = null;
		this.transcriptComponent?.$set({
			attachments: [],
			attachmentsEnabled: false,
		});
	}

	private async prepareAttachmentFolder(audioPath: string): Promise<void> {
		const audioFile =
			this.plugin.app.vault.getAbstractFileByPath(audioPath);
		if (!(audioFile instanceof TFile)) {
			this.attachmentFolderPath = null;
			return;
		}
		const parentPath = audioFile.parent?.path;
		if (!parentPath) {
			this.attachmentFolderPath = null;
			return;
		}
		const meetingFolder = `${parentPath}/${audioFile.basename}`;
		const attachmentsFolder = `${meetingFolder}/attachments`;
		const meetingReady = await this.ensureFolder(meetingFolder);
		const attachmentsReady =
			meetingReady && (await this.ensureFolder(attachmentsFolder));
		this.attachmentFolderPath = attachmentsReady ? attachmentsFolder : null;
	}

	private async ensureFolder(path: string): Promise<boolean> {
		if (!path) return false;
		const existingFile =
			this.plugin.app.vault.getAbstractFileByPath(path);
		if (existingFile instanceof TFolder) {
			return true;
		}
		if (existingFile instanceof TFile) {
			console.warn(
				`Audio Notes: Attachment path ${path} already exists as a file`
			);
			return false;
		}
		try {
			await this.plugin.app.vault.createFolder(path);
			return true;
		} catch (error) {
			console.error(
				"Audio Notes: Failed to create attachments folder",
				error
			);
			return false;
		}
	}

	private async refreshAttachmentsList(): Promise<void> {
		let attachments: SidebarAttachment[] = [];
		if (this.attachmentFolderPath) {
			const folder = this.plugin.app.vault.getAbstractFileByPath(
				this.attachmentFolderPath
			);
			if (folder instanceof TFolder) {
				attachments = folder.children
					.filter((child): child is TFile => child instanceof TFile)
					.map((file) => ({
						path: file.path,
						name: file.name,
						extension: file.extension ?? "",
						size: this.formatFileSize(file.stat?.size ?? 0),
					}))
					.sort((a, b) => a.name.localeCompare(b.name));
			}
		}
		this.currentAttachments = attachments;
		this.transcriptComponent?.$set({
			attachments,
			attachmentsEnabled: Boolean(this.attachmentFolderPath),
		});
	}

	private formatFileSize(bytes: number): string {
		if (!bytes || bytes <= 0) {
			return "0 B";
		}
		const units = ["B", "KB", "MB", "GB", "TB"];
		const index = Math.min(
			Math.floor(Math.log(bytes) / Math.log(1024)),
			units.length - 1
		);
		const value = bytes / Math.pow(1024, index);
		return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${
			units[index]
		}`;
	}

	private async handleAttachmentUpload(files: File[]): Promise<void> {
		if (!files?.length) return;
		const folderPath = await this.ensureAttachmentFolderReady();
		if (!folderPath) {
			new Notice(
				"Unable to determine attachment folder for this meeting.",
				4000
			);
			return;
		}
		for (const file of files) {
			try {
				const buffer = await file.arrayBuffer();
				const { path, finalName, renamed } =
					await this.getAvailableAttachmentPath(file.name);
				await this.plugin.app.vault.createBinary(path, buffer);
				if (renamed) {
					new Notice(
						`${file.name} exists. Saved as ${finalName}.`,
						4000
					);
				}
			} catch (error) {
				console.error(
					"Audio Notes: Failed to save attachment",
					error
				);
				new Notice(
					`Failed to save ${file.name}. See console for details.`,
					5000
				);
			}
		}
		await this.refreshAttachmentsList();
	}

	private async ensureAttachmentFolderReady(): Promise<string | null> {
		if (this.attachmentFolderPath) {
			const ready = await this.ensureFolder(this.attachmentFolderPath);
			if (ready) {
				return this.attachmentFolderPath;
			}
			this.attachmentFolderPath = null;
		}
		if (!this.currentAudioPath) {
			return null;
		}
		await this.prepareAttachmentFolder(this.currentAudioPath);
		return this.attachmentFolderPath;
	}

	private async getAvailableAttachmentPath(
		fileName: string
	): Promise<{
		path: string;
		finalName: string;
		renamed: boolean;
	}> {
		const folderPath = await this.ensureAttachmentFolderReady();
		if (!folderPath) {
			throw new Error("Attachment folder is not ready");
		}
		const trimmedName = fileName?.trim() || "attachment";
		const dotIndex = trimmedName.lastIndexOf(".");
		const base =
			dotIndex === -1
				? trimmedName
				: trimmedName.slice(0, dotIndex);
		const ext = dotIndex === -1 ? "" : trimmedName.slice(dotIndex);
		const safeBase = base || "attachment";
		let finalName = trimmedName;
		let counter = 1;
		while (
			this.plugin.app.vault.getAbstractFileByPath(
				`${folderPath}/${finalName}`
			)
		) {
			finalName = `${safeBase}-${counter}${ext}`;
			counter++;
		}
		return {
			path: `${folderPath}/${finalName}`,
			finalName,
			renamed: finalName !== trimmedName,
		};
	}

	private async openAttachment(path: string): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice("Attachment no longer exists.", 3000);
			await this.refreshAttachmentsList();
			return;
		}
		try {
			let leaf = this.plugin.app.workspace.getLeaf(false);
			if (!leaf) {
				leaf = this.plugin.app.workspace.getLeaf(true);
			}
			await leaf.openFile(file);
		} catch (error) {
			console.error("Audio Notes: Failed to open attachment", error);
			new Notice("Unable to open attachment.", 4000);
		}
	}

	private async deleteAttachment(path: string): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			await this.refreshAttachmentsList();
			return;
		}
		try {
			await this.plugin.app.vault.delete(file);
			await this.refreshAttachmentsList();
		} catch (error) {
			console.error(
				"Audio Notes: Failed to delete attachment",
				error
			);
			new Notice("Unable to delete attachment.", 4000);
		}
	}

	private async openFile(path: string, newLeaf: boolean) {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			return;
		}
		const leaf = this.plugin.app.workspace.getLeaf(newLeaf);
		await leaf.openFile(file);
	}
}
