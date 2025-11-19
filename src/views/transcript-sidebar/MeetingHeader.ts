import { setIcon } from "obsidian";
import type { MeetingScheduleInfo } from "./MeetingScheduleInfo";

interface MeetingHeaderCallbacks {
	onLabelClick: () => void;
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
	private deleteButtonEl: HTMLButtonElement;

	constructor(
		container: HTMLElement,
		private callbacks: MeetingHeaderCallbacks
	) {
		this.headerEl = container.createDiv({
			cls: "aan-transcript-sidebar-header",
		});
		this.titleEl = this.headerEl.createEl("h2", {
			text: "Transcript",
		});
		this.titleEl.classList.add("aan-transcript-title");
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
		this.scheduleEditButtonEl = actionsEl.createEl("button", {
			cls: "aan-transcript-btn icon-only",
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
		this.deleteButtonEl = actionsEl.createEl("button", {
			cls: "aan-transcript-btn icon-only danger",
			attr: {
				type: "button",
				title: "Delete meeting",
				"aria-label": "Delete meeting",
			},
		});
		setIcon(this.deleteButtonEl, "trash");
		this.deleteButtonEl.addEventListener("click", () => {
			this.callbacks.onDelete();
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
			this.scheduleTimeEl.setText("");
			return;
		}
		if (!info) {
			this.scheduleSummaryEl.classList.add("is-placeholder");
			this.scheduleDateEl.setText("Set meeting date");
			this.scheduleTimeEl.setText(
				"Use the calendar button to pick a time"
			);
			return;
		}
		this.scheduleSummaryEl.classList.remove("is-placeholder");
		this.scheduleDateEl.setText(info.dateLabel);
		this.scheduleTimeEl.setText(info.timeLabel);
	}

	public setDeleteEnabled(enabled: boolean): void {
		this.deleteButtonEl.toggleAttribute("disabled", !enabled);
	}

	public getElement(): HTMLDivElement {
		return this.headerEl;
	}
}

