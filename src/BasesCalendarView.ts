import type { QueryController } from "obsidian";
import { BasesView, TFile } from "obsidian";
import type AutomaticAudioNotes from "./main";
import MeetingCalendar from "./MeetingCalendar.svelte";
import { collectMeetingEventsForFiles, localDateKey } from "./meeting-events";

export const AUDIO_NOTES_BASES_CALENDAR_VIEW = "audio-notes-bases-calendar";

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
		// Bases reruns the query and calls onDataUpdated when files come and
		// go; these cover edits to a matching note's times or label, which
		// change the calendar without changing the result set.
		const schedule = () => this.scheduleRefresh();
		this.registerEvent(this.plugin.app.metadataCache.on("changed", schedule));
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

	/** The notes the Base's filters matched; none until the first query runs. */
	private queryFiles(): TFile[] {
		return (this.data?.data ?? [])
			.map((entry) => entry.file)
			.filter((file): file is TFile => file instanceof TFile);
	}

	private renderCalendar() {
		// Only the Base's results, still limited to notes that are meetings
		// with a start time.
		const events = collectMeetingEventsForFiles(
			this.plugin.app,
			this.queryFiles(),
			this.plugin.settings.calendarTagColors,
			this.plugin.settings.meetingLabelCategories
		);
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
