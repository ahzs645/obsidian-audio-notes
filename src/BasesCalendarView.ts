import type { QueryController } from "obsidian";
import { BasesView, TFile } from "obsidian";
import type AutomaticAudioNotes from "./main";
import MeetingCalendar from "./MeetingCalendar.svelte";
import { collectMeetingEvents, localDateKey } from "./meeting-events";

export const AUDIO_NOTES_BASES_CALENDAR_VIEW = "audio-notes-bases-calendar";

function todayISO(): string {
	return new Date().toISOString().slice(0, 10);
}

export class BasesCalendarView extends BasesView {
	type = AUDIO_NOTES_BASES_CALENDAR_VIEW;
	private containerEl: HTMLElement;
	private component: MeetingCalendar | undefined;
	private plugin: AutomaticAudioNotes;
	private selectedDate: string = localDateKey(new Date());
	private refreshTimeout: number | null = null;

	constructor(
		controller: QueryController,
		scrollEl: HTMLElement,
		plugin: AutomaticAudioNotes
	) {
		super(controller);
		this.plugin = plugin;
		this.containerEl = scrollEl.createDiv({ cls: "aan-calendar-view" });
	}

	onload(): void {
		this.renderCalendar();
		this.registerListeners();
	}

	onunload(): void {
		if (this.refreshTimeout) {
			window.clearTimeout(this.refreshTimeout);
			this.refreshTimeout = null;
		}
		this.component?.$destroy();
		this.component = undefined;
	}

	public onDataUpdated(): void {
		this.renderCalendar();
	}

	private registerListeners() {
		const schedule = () => this.scheduleRefresh();
		this.registerEvent(this.plugin.app.metadataCache.on("changed", schedule));
		this.registerEvent(this.plugin.app.vault.on("create", schedule));
		this.registerEvent(this.plugin.app.vault.on("delete", schedule));
		this.registerEvent(this.plugin.app.vault.on("rename", schedule));
		// @ts-ignore custom event emitted when settings change
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
			this.renderCalendar();
		}, 200);
	}

	private renderCalendar() {
		const events = collectMeetingEvents(
			this.plugin.app,
			this.plugin.settings.calendarTagColors
		);
		if (
			events.length &&
			!events.some(
				(event) => event.displayDate === this.selectedDate
			)
		) {
			this.selectedDate = events[0].displayDate;
		}

		if (!this.component) {
			this.component = new MeetingCalendar({
				target: this.containerEl,
				props: {
					events,
					selectedDate: this.selectedDate,
					colorLegend: this.plugin.settings.calendarTagColors,
					onSelectDate: (date: string) => {
						this.selectedDate = date;
					},
					onOpenNote: (path: string, newLeaf: boolean) =>
						this.openFile(path, newLeaf),
					onRefresh: () => this.renderCalendar(),
				},
			});
		} else {
			this.component.$set({
				events,
				selectedDate: this.selectedDate,
				colorLegend: this.plugin.settings.calendarTagColors,
			});
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
