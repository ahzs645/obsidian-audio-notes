import {
	ItemView,
	Notice,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
import TranscriptDisplay from "../transcript-view/TranscriptDisplay.svelte";
import type { TranscriptSegmentWithSpeaker } from "../transcript-view/types";
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
	private playerHost: HTMLDivElement | null = null;
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

		if (this.playerHost) {
			if (playerEl) {
				this.playerHost.empty();
				this.playerHost.addClass("has-player");
				this.playerHost.appendChild(playerEl);
			} else {
				this.playerHost.removeClass("has-player");
			}
		}

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

		this.playerHost = this.meetingContainer.createDiv({
			cls: "audio-note-player-host",
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

	private async openFile(path: string, newLeaf: boolean) {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			return;
		}
		const leaf = this.plugin.app.workspace.getLeaf(newLeaf);
		await leaf.openFile(file);
	}
}
