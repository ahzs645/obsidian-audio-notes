import {
	ItemView,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
import type AutomaticAudioNotes from "./main";
import MeetingCalendar from "./MeetingCalendar.svelte";
import type { MeetingEvent } from "./meeting-events";
import { collectMeetingEvents, localDateKey } from "./meeting-events";

export const AUDIO_NOTES_CALENDAR_VIEW = "audio-notes-calendar";
const CALENDAR_VIEW_NAME = "Audio Notes Calendar";

export class MeetingCalendarView extends ItemView {
	private plugin: AutomaticAudioNotes;
	private component: MeetingCalendar | undefined;
	private events: MeetingEvent[] = [];
	private selectedDate: string = localDateKey(new Date());
	private refreshTimeout: number | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: AutomaticAudioNotes) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return AUDIO_NOTES_CALENDAR_VIEW;
	}

	getDisplayText(): string {
		return CALENDAR_VIEW_NAME;
	}

	getIcon(): string {
		return "calendar";
	}

	async onOpen() {
		this.containerEl.empty();
		this.containerEl.addClass("aan-calendar-view");
		this.component = new MeetingCalendar({
			target: this.containerEl,
			props: {
				events: this.events,
				selectedDate: this.selectedDate,
				colorLegend: this.plugin.settings.calendarTagColors,
				onSelectDate: (date: string) => {
					this.selectedDate = date;
					this.component?.$set({
						selectedDate: this.selectedDate,
					});
				},
				onOpenNote: (path: string, newLeaf: boolean) =>
					this.openFile(path, newLeaf),
				onRefresh: () => this.refreshEvents(),
			},
		});
		this.refreshEvents();
		this.registerListeners();
	}

	async onClose() {
		if (this.refreshTimeout) {
			window.clearTimeout(this.refreshTimeout);
			this.refreshTimeout = null;
		}
		this.component?.$destroy();
		this.component = undefined;
	}

	private registerListeners() {
		const schedule = () => this.scheduleRefresh();
		this.registerEvent(this.plugin.app.metadataCache.on("changed", schedule));
		this.registerEvent(this.plugin.app.vault.on("create", schedule));
		this.registerEvent(this.plugin.app.vault.on("delete", schedule));
		this.registerEvent(this.plugin.app.vault.on("rename", schedule));
		// @ts-ignore — custom workspace event emitted by the plugin
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
		this.events = collectMeetingEvents(
			this.plugin.app,
			this.plugin.settings.calendarTagColors
		);
		if (
			this.events.length &&
			!this.events.some(
				(event) => event.displayDate === this.selectedDate
			)
		) {
			this.selectedDate = this.events[0].displayDate;
		}

		this.component?.$set({
			events: this.events,
			selectedDate: this.selectedDate,
			colorLegend: this.plugin.settings.calendarTagColors,
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
