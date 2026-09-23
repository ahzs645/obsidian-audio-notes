import { setIcon } from "obsidian";
import type { MeetingScheduleInfo } from "./MeetingScheduleInfo";

interface MeetingHeaderCallbacks {
	onLabelClick: () => void;
	onAttendeeClick: () => void;
	onScheduleEdit: () => void;
	onDelete: () => void;
}

interface LabelDisplayState {
	text: string;
	placeholder: string;
	canEdit: boolean;
	hasValue: boolean;
}

export class MeetingHeader {
	private headerEl: HTMLDivElement;
	private titleEl: HTMLHeadingElement;
	private scheduleSummaryEl: HTMLDivElement;
	private scheduleDateEl: HTMLDivElement;
	private scheduleTimeEl: HTMLDivElement;
	private scheduleEditButtonEl: HTMLButtonElement;
	private labelInputEl: HTMLInputElement;
	private attendeeInputEl: HTMLInputElement;
	private deleteButtonEl: HTMLButtonElement;

	constructor(
		container: HTMLElement,
		private callbacks: MeetingHeaderCallbacks
	) {
		this.headerEl = container.createDiv({
			cls: "aan-transcript-sidebar-header",
		});
		const titleRow = this.headerEl.createDiv({
			cls: "aan-transcript-title-row",
		});
		this.titleEl = titleRow.createEl("h2", {
			text: "Transcript",
		});
		this.titleEl.classList.add("aan-transcript-title");
		this.deleteButtonEl = titleRow.createEl("button", {
			cls: "aan-transcript-delete-btn clickable-icon",
			attr: {
				type: "button",
				title: "Delete meeting",
				"aria-label": "Delete meeting",
			},
		});
		setIcon(this.deleteButtonEl, "trash-2");
		this.deleteButtonEl.addEventListener("click", () => {
			this.callbacks.onDelete();
		});
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
		this.scheduleEditButtonEl = this.scheduleSummaryEl.createEl("button", {
			cls: "aan-transcript-schedule-edit clickable-icon",
			attr: {
				type: "button",
				title: "Edit meeting date & time",
				"aria-label": "Edit meeting date and time",
			},
		});
		setIcon(this.scheduleEditButtonEl, "calendar-clock");
		this.scheduleEditButtonEl.addEventListener("click", () => {
			this.callbacks.onScheduleEdit();
		});
		const actionsEl = this.headerEl.createDiv({
			cls: "aan-transcript-sidebar-actions",
		});
		const labelField = actionsEl.createDiv({
			cls: "aan-transcript-label-field",
		});
		this.labelInputEl = labelField.createEl("input", {
			type: "text",
			attr: { readonly: "readonly" },
		}) as HTMLInputElement;
		this.labelInputEl.classList.add("aan-transcript-label-input");
		this.labelInputEl.placeholder = "Select or create label";
		this.labelInputEl.title = "Click to assign a meeting label";
		this.labelInputEl.addEventListener("click", (event) => {
			event.preventDefault();
			this.callbacks.onLabelClick();
		});
		this.labelInputEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				this.callbacks.onLabelClick();
			}
		});
		const attendeeField = actionsEl.createDiv({
			cls: "aan-transcript-attendee-field",
		});
		this.attendeeInputEl = attendeeField.createEl("input", {
			type: "text",
			attr: { readonly: "readonly" },
		}) as HTMLInputElement;
		this.attendeeInputEl.classList.add("aan-transcript-attendee-input");
		this.attendeeInputEl.placeholder = "Add attendees";
		this.attendeeInputEl.title = "Click to manage meeting attendees";
		this.attendeeInputEl.addEventListener("click", (event) => {
			event.preventDefault();
			this.callbacks.onAttendeeClick();
		});
		this.attendeeInputEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				this.callbacks.onAttendeeClick();
			}
		});
	}

	public setTitle(title: string): void {
		this.titleEl.setText(title);
	}

	public setLabel(state: LabelDisplayState): void {
		this.labelInputEl.toggleAttribute("disabled", !state.canEdit);
		this.labelInputEl.placeholder = state.placeholder;
		this.labelInputEl.value = state.text || "";
		this.labelInputEl.classList.toggle("is-placeholder", !state.hasValue);
	}

	public setSchedule(
		info: MeetingScheduleInfo | null,
		canEdit: boolean
	): void {
		this.scheduleEditButtonEl?.toggleAttribute("disabled", !canEdit);
		if (!canEdit) {
			this.scheduleSummaryEl.classList.add("is-placeholder");
			this.scheduleDateEl.setText("Open a meeting note to view schedule");
			this.scheduleDateEl.removeAttribute("title");
			this.scheduleTimeEl.setText("");
			this.scheduleTimeEl.removeAttribute("title");
			return;
		}
		if (!info) {
			this.scheduleSummaryEl.classList.add("is-placeholder");
			this.scheduleDateEl.setText("Set meeting date");
			this.scheduleDateEl.removeAttribute("title");
			this.scheduleTimeEl.setText(
				"Use the calendar button to pick a time"
			);
			this.scheduleTimeEl.removeAttribute("title");
			return;
		}
		this.scheduleSummaryEl.classList.remove("is-placeholder");
		this.scheduleDateEl.setText(formatShortDateRange(info.start, info.end));
		this.scheduleDateEl.setAttribute("title", info.dateLabel);
		// Keep each time whole so narrow panes wrap after the dash, not inside "8:58 AM".
		this.scheduleTimeEl.empty();
		this.scheduleTimeEl.createSpan({
			text: `${formatShortTime(info.start)} –`,
			cls: "aan-nowrap",
		});
		this.scheduleTimeEl.append(" ");
		this.scheduleTimeEl.createSpan({
			text: formatShortTime(info.end),
			cls: "aan-nowrap",
		});
		this.scheduleTimeEl.setAttribute("title", info.timeLabel);
	}

	public setAttendees(attendees: string[], canEdit: boolean): void {
		this.attendeeInputEl.toggleAttribute("disabled", !canEdit);
		if (!canEdit) {
			this.attendeeInputEl.placeholder =
				"Open a meeting note to add attendees";
			this.attendeeInputEl.value = "";
			this.attendeeInputEl.classList.add("is-placeholder");
			return;
		}
		if (!attendees.length) {
			this.attendeeInputEl.placeholder = "Add attendees";
			this.attendeeInputEl.value = "";
			this.attendeeInputEl.classList.add("is-placeholder");
			return;
		}
		this.attendeeInputEl.classList.remove("is-placeholder");
		this.attendeeInputEl.placeholder = "";
		if (attendees.length <= 3) {
			this.attendeeInputEl.value = attendees.join(", ");
		} else {
			this.attendeeInputEl.value = `${attendees.slice(0, 2).join(", ")} +${attendees.length - 2} more`;
		}
	}

	public setDeleteEnabled(enabled: boolean): void {
		this.deleteButtonEl.toggleAttribute("disabled", !enabled);
	}

	public getElement(): HTMLDivElement {
		return this.headerEl;
	}
}

/** "Tue, Sep 22" (year only when it isn't this year); spans days as "Sep 22 – Sep 23". */
function formatShortDateRange(start: Date, end: Date): string {
	const thisYear = new Date().getFullYear();
	const format = (date: Date, weekday: boolean) =>
		date.toLocaleDateString(undefined, {
			weekday: weekday ? "short" : undefined,
			month: "short",
			day: "numeric",
			year: date.getFullYear() === thisYear ? undefined : "numeric",
		});
	if (start.toDateString() === end.toDateString()) {
		return format(start, true);
	}
	return `${format(start, false)} – ${format(end, false)}`;
}

/** "8:06 AM" — matches the sidebar agenda cards. */
function formatShortTime(date: Date): string {
	return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
