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
import { generateRandomString } from "../utils";

export const AUDIO_NOTES_TRANSCRIPT_VIEW = "audio-notes-transcript-view";

interface TranscriptSidebarState {
	file?: string;
}

type MeetingDateParts = {
	year?: string;
	month?: string;
	day?: string;
};

interface MeetingFolderResult {
	audioPath: string;
	meetingFolder: string | null;
	dateParts: MeetingDateParts;
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
	private currentAudioFileName: string | null = null;

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
		let activeFile = file;
		this.setMode("meeting");
		this.currentFilePath = activeFile.path;
		this.currentAudioPath = null;
		this.resetAttachments();
		if (!this.transcriptComponent) {
			this.renderBase();
		}
		this.dashboardContainer?.addClass("is-hidden");
		this.meetingContainer?.removeClass("is-hidden");
		this.renderHeader(activeFile);

		let cache =
			this.plugin.app.metadataCache.getFileCache(activeFile);
		const frontmatter = (cache?.frontmatter ??
			{}) as Record<string, unknown>;
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


		if (!audioPath) {
			this.renderEmpty(
				"Add a `media_uri` property to this note to load the recording."
			);
			return;
		}

		const meetingFolderResult = await this.ensureMeetingFolderForAudio(
			activeFile,
			audioPath,
			audioFieldKey,
			noteTitle
		);
		if (meetingFolderResult) {
			audioPath = meetingFolderResult.audioPath;
			this.attachmentFolderPath = meetingFolderResult.meetingFolder ?? null;
			if (meetingFolderResult.dateParts) {
				const relocated = await this.ensureMeetingNoteFolder(
					activeFile,
					meetingFolderResult.dateParts
				);
				if (relocated) {
					activeFile = relocated;
					this.currentFilePath = relocated.path;
					cache =
						this.plugin.app.metadataCache.getFileCache(relocated);
				}
			}
		} else {
			this.attachmentFolderPath = null;
		}
		this.currentAudioPath = audioPath;
		const resolvedAudioFile = audioPath
			? this.plugin.app.vault.getAbstractFileByPath(audioPath)
			: null;
		this.currentAudioFileName =
			resolvedAudioFile instanceof TFile ? resolvedAudioFile.name : null;
		await this.refreshAttachmentsList();

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
		this.currentAudioFileName = null;
	}

	private async ensureMeetingFolderForAudio(
		meetingFile: TFile,
		audioPath: string,
		audioFieldKey: string | null,
		meetingTitle: string
	): Promise<MeetingFolderResult | null> {
		if (!audioPath || audioPath.includes("://")) {
			return { audioPath, meetingFolder: null, dateParts: {} };
		}
		const audioFile =
			this.plugin.app.vault.getAbstractFileByPath(audioPath);
		if (!(audioFile instanceof TFile)) {
			return { audioPath, meetingFolder: null, dateParts: {} };
		}

		const dateParts = this.extractDateParts(
			audioFile.basename,
			audioFile
		);
		const parentFolder = audioFile.parent;
		const currentParentPath = parentFolder?.path ?? "";
		const baseParentPath = this.getMeetingBasePath(audioFile);

		if (baseParentPath) {
			const baseReady = await this.ensureFolder(baseParentPath);
			if (!baseReady) {
				return {
					audioPath: audioFile.path,
					meetingFolder: currentParentPath || null,
					dateParts,
				};
			}
		}

		const parentSegments = currentParentPath
			? currentParentPath.split("/").filter(Boolean)
			: [];
		const baseSegments = baseParentPath
			? baseParentPath.split("/").filter(Boolean)
			: [];
		const hashedFolderRegex = /^[a-z0-9]{4}-/;
		const basePrefix = baseParentPath ? `${baseParentPath}/` : "";
		const hasHashedFolder =
			parentFolder && hashedFolderRegex.test(parentFolder.name);
		const isDirectChildOfBase =
			Boolean(baseParentPath) &&
			currentParentPath.startsWith(basePrefix) &&
			parentSegments.length === baseSegments.length + 1 &&
			hasHashedFolder;
		const isStandaloneHashedParent = !baseParentPath && hasHashedFolder;

		let meetingFolderPath: string;
		if ((isDirectChildOfBase || isStandaloneHashedParent) && currentParentPath) {
			meetingFolderPath = currentParentPath;
		} else {
			meetingFolderPath = this.buildMeetingFolderPath(
				baseParentPath,
				meetingTitle,
				audioFile.basename
			);
			const folderReady = await this.ensureFolder(meetingFolderPath);
			if (!folderReady) {
				return {
					audioPath: audioFile.path,
					meetingFolder: currentParentPath || null,
					dateParts,
				};
			}
		}

		const originalParentPath = currentParentPath;
		let targetPath = `${meetingFolderPath}/${audioFile.name}`;
		if (audioFile.path !== targetPath) {
			await this.plugin.app.fileManager.renameFile(
				audioFile,
				targetPath
			);
		}

		if (audioFieldKey && targetPath !== audioPath) {
			await this.plugin.app.fileManager.processFrontMatter(
				meetingFile,
				(fm) => {
					fm[audioFieldKey] = targetPath;
				}
			);
		}

		const updatedAudioFile =
			this.plugin.app.vault.getAbstractFileByPath(targetPath);
		if (!(updatedAudioFile instanceof TFile)) {
			targetPath = audioFile.path;
		}

		if (meetingFolderPath !== originalParentPath) {
			await this.cleanupLegacyAudioAncestors(originalParentPath);
		}

			return {
				audioPath: targetPath,
				meetingFolder: meetingFolderPath,
				dateParts,
			};
	}

	private async ensureFolder(path: string): Promise<boolean> {
		if (!path) return false;
		const normalizedPath = path.replace(/^\/+|\/+$/g, "");
		if (!normalizedPath.length) return false;
		const existingFile =
			this.plugin.app.vault.getAbstractFileByPath(normalizedPath);
		if (existingFile instanceof TFolder) {
			return true;
		}
		if (existingFile instanceof TFile) {
			console.warn(
				`Audio Notes: Folder path ${normalizedPath} already exists as a file`
			);
			return false;
		}
		const parentPath = normalizedPath
			.split("/")
			.slice(0, -1)
			.join("/");
		if (parentPath && !(await this.ensureFolder(parentPath))) {
			return false;
		}
		try {
			await this.plugin.app.vault.createFolder(normalizedPath);
			return true;
		} catch (error) {
			const retry =
				this.plugin.app.vault.getAbstractFileByPath(normalizedPath);
			if (retry instanceof TFolder) {
				return true;
			}
			console.error(
				"Audio Notes: Failed to create folder",
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
					.filter((file) => file.path !== this.currentAudioPath)
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
		const audioFile =
			this.plugin.app.vault.getAbstractFileByPath(this.currentAudioPath);
		if (audioFile instanceof TFile && audioFile.parent) {
			this.attachmentFolderPath = audioFile.parent.path;
			return this.attachmentFolderPath;
		}
		return null;
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

	private getMeetingBasePath(audioFile: TFile): string {
		const segments = audioFile.path.split("/").filter(Boolean);
		const audioIndex = segments.indexOf("audio");
		const dateParts = this.extractDateParts(
			audioFile.basename,
			audioFile
		);
		let baseSegments: string[] =
			audioIndex === -1
				? audioFile.parent?.path?.split("/").filter(Boolean) ?? []
				: segments.slice(0, audioIndex);
		if (audioIndex === -1 && baseSegments.length) {
			const last = baseSegments[baseSegments.length - 1];
			if (/^[a-z0-9]{4}-/.test(last)) {
				baseSegments = baseSegments.slice(0, -1);
			}
		}

		const pushSegment = (value?: string) => {
			if (!value) return;
			if (baseSegments[baseSegments.length - 1] === value) return;
			if (baseSegments.includes(value)) return;
			baseSegments.push(value);
		};

		if (audioIndex !== -1) {
			const yearSegment = segments[audioIndex + 1] ?? dateParts.year;
			const monthSegment = segments[audioIndex + 2] ?? dateParts.month;
			pushSegment(yearSegment);
			pushSegment(monthSegment);
		} else {
			pushSegment(dateParts.year);
			pushSegment(dateParts.month);
		}

		pushSegment(dateParts.day);

		return baseSegments.join("/");
	}

	private buildMeetingFolderPath(
		baseParentPath: string,
		meetingTitle: string,
		fallback: string
	): string {
		const slugBase = meetingTitle?.trim() || fallback || "meeting";
		const slug = slugBase
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 20) || "meeting";
		let folderName = "";
		let fullPath = "";
		do {
			const hash = generateRandomString(4).toLowerCase();
			folderName = `${hash}-${slug}`;
			fullPath = baseParentPath
				? `${baseParentPath}/${folderName}`
				: folderName;
		} while (
			this.plugin.app.vault.getAbstractFileByPath(fullPath) instanceof
			TFolder
		);
		return fullPath;
	}

	private extractDateParts(value: string, file?: TFile): {
		year?: string;
		month?: string;
		day?: string;
	} {
		const match = value.match(/(\d{4})-(\d{2})-(\d{2})/);
		if (match) {
			return {
				year: match[1],
				month: match[2],
				day: match[3],
			};
		}
		const timestamp =
			file?.stat?.ctime ??
			file?.stat?.mtime ??
			Date.now();
		const date = new Date(timestamp);
		if (isNaN(date.getTime())) {
			return {};
		}
		const year = date.getFullYear().toString();
		const month = (date.getMonth() + 1).toString().padStart(2, "0");
		const day = date.getDate().toString().padStart(2, "0");
		return { year, month, day };
	}

	private async cleanupLegacyAudioAncestors(path: string | null) {
		let current = path;
		while (current) {
			const folder = this.plugin.app.vault.getAbstractFileByPath(current);
			if (!(folder instanceof TFolder)) break;
			if (folder.children.length > 0) break;
			const segments = current.split("/").filter(Boolean);
			if (!segments.length) break;
			const removedSegment = segments[segments.length - 1];
			await this.plugin.app.vault.delete(folder);
			segments.pop();
			if (!segments.length) break;
			if (removedSegment === "audio") {
				break;
			}
			current = segments.join("/");
		}
	}

	private async ensureMeetingNoteFolder(
		meetingFile: TFile,
		dateParts: MeetingDateParts
	): Promise<TFile | null> {
		const { year, month, day } = dateParts;
		if (!year || !month || !day) {
			return null;
		}
		const parentPath = meetingFile.parent?.path ?? "";
		if (!parentPath) {
			return null;
		}
		const segments = parentPath.split("/").filter(Boolean);
		if (!segments.length) {
			return null;
		}

		const lastThreeAreDate =
			segments.length >= 3 &&
			/^\d{4}$/.test(segments[segments.length - 3]) &&
			/^\d{2}$/.test(segments[segments.length - 2]) &&
			/^\d{2}$/.test(segments[segments.length - 1]);
		const baseSegments = lastThreeAreDate
			? segments.slice(0, -3)
			: segments;
		if (!baseSegments.length) {
			return null;
		}
		const basePath = baseSegments.join("/");
		const desiredParent = `${basePath}/${year}/${month}/${day}`;
		if (parentPath === desiredParent) {
			return null;
		}
		const ready = await this.ensureFolder(desiredParent);
		if (!ready) {
			return null;
		}
		const targetPath = `${desiredParent}/${meetingFile.name}`;
		await this.plugin.app.fileManager.renameFile(meetingFile, targetPath);
		const updatedFile = this.plugin.app.vault.getAbstractFileByPath(
			targetPath
		);
		return updatedFile instanceof TFile ? updatedFile : meetingFile;
	}
}
