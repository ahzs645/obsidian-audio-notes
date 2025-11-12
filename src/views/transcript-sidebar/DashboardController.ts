import type { EventRef } from "obsidian";
import SidebarPlanner from "../../sidebar/SidebarPlanner.svelte";
import type { MeetingEvent } from "../../meeting-events";
import {
	collectMeetingEvents,
	localDateKey,
} from "../../meeting-events";
import { getEffectiveMeetingLabelCategories } from "../../meeting-labels";
import type AutomaticAudioNotes from "../../main";

export class DashboardController {
	private component: SidebarPlanner | undefined;
	private refreshTimeout: number | null = null;
	private listenersRegistered = false;
	private events: MeetingEvent[] = [];
	private selectedDate: string = localDateKey(new Date());
	private filterValue = "";

	constructor(
		private readonly plugin: AutomaticAudioNotes,
		private readonly registerEvent: (ref: EventRef) => void,
		private readonly openFile: (
			path: string,
			newLeaf: boolean
		) => Promise<void>
	) {}

	ensure(container: HTMLDivElement | null) {
		if (this.component || !container) {
			return;
		}
		container.empty();
		this.component = new SidebarPlanner({
			target: container,
			props: {
				events: this.events,
				selectedDate: this.selectedDate,
				categories: this.getCategories(),
				filterValue: this.filterValue,
				onSelectDate: (date: string) => this.handleSelectDate(date),
				onOpenNote: (path: string, newLeaf: boolean) =>
					this.openFile(path, newLeaf),
				onFilterChange: (value: string) =>
					this.handleFilterChange(value),
			},
		});
		this.registerListeners();
		this.refreshEvents();
	}

	destroy() {
		if (this.refreshTimeout) {
			window.clearTimeout(this.refreshTimeout);
			this.refreshTimeout = null;
		}
		this.component?.$destroy();
		this.component = undefined;
		this.listenersRegistered = false;
	}

	scheduleRefresh() {
		if (this.refreshTimeout) {
			window.clearTimeout(this.refreshTimeout);
		}
		this.refreshTimeout = window.setTimeout(() => {
			this.refreshTimeout = null;
			this.refreshEvents();
		}, 200);
	}

	private registerListeners() {
		if (this.listenersRegistered) {
			return;
		}
		this.listenersRegistered = true;
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

	private handleSelectDate(date: string) {
		this.selectedDate = date;
		this.component?.$set({
			selectedDate: this.selectedDate,
		});
	}

	private refreshEvents() {
		const categories = this.getCategories();
		this.events = collectMeetingEvents(
			this.plugin.app,
			this.plugin.settings.calendarTagColors,
			this.plugin.settings.meetingLabelCategories
		);
		this.component?.$set({
			events: this.events,
			selectedDate: this.selectedDate,
			categories,
			filterValue: this.filterValue,
		});
	}

	private handleFilterChange(filterId: string) {
		this.filterValue = filterId || "";
		this.component?.$set({
			filterValue: this.filterValue,
		});
	}

	private getCategories() {
		return getEffectiveMeetingLabelCategories(
			this.plugin.settings.meetingLabelCategories
		);
	}
}
