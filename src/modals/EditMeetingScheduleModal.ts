import { App, Modal, Setting, type ToggleComponent } from "obsidian";
import { localDateKey } from "../meeting-events";
import {
	combineLocal,
	formatLength,
	moveStart,
	scheduleLengthMs,
	setEnd,
	setLengthMinutes,
	splitLocal,
	validateSchedule,
	type ScheduleFields,
} from "../schedule-math";

export interface MeetingScheduleUpdate {
	startDate: string;
	startTime: string;
	endDate: string;
	endTime: string;
}

interface EditMeetingScheduleModalOptions {
	initialStartDate?: string;
	initialStartTime?: string;
	initialEndDate?: string;
	initialEndTime?: string;
	/** Length of the meeting's recording, offered as a one-click end time. */
	recordingLengthSec?: number | null;
	onSubmit: (update: MeetingScheduleUpdate) => void;
}

const LENGTH_PRESETS = [15, 30, 45, 60, 90];

export class EditMeetingScheduleModal extends Modal {
	private fields: ScheduleFields;
	private multiDay: boolean;
	private inputs: Partial<Record<keyof ScheduleFields, HTMLInputElement>> = {};
	private endDateSetting: Setting | null = null;
	private summaryEl: HTMLElement | null = null;
	private errorEl: HTMLElement | null = null;
	private submitButton: HTMLButtonElement | null = null;
	private multiDayToggle: ToggleComponent | null = null;
	private syncingToggle = false;

	constructor(app: App, private options: EditMeetingScheduleModalOptions) {
		super(app);
		const now = new Date();
		now.setSeconds(0, 0);
		const startDate = options.initialStartDate || localDateKey(now);
		const startTime = options.initialStartTime || splitLocal(now).time;
		const fallbackEnd = splitLocal(
			new Date((combineLocal(startDate, startTime) ?? now).getTime() + 60 * 60 * 1000)
		);
		this.fields = {
			startDate,
			startTime,
			endDate: options.initialEndDate || startDate,
			endTime: options.initialEndTime || fallbackEnd.time,
		};
		// Same-day unless the saved meeting already spans days.
		this.multiDay = this.fields.endDate !== this.fields.startDate;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("aan-schedule-modal");
		contentEl.createEl("h2", { text: "Edit meeting schedule" });

		new Setting(contentEl)
			.setName("Date")
			.addText((input) => {
				input.inputEl.type = "date";
				this.inputs.startDate = input.inputEl;
				input.inputEl.addEventListener("change", () =>
					this.update(moveStart(this.fields, { startDate: input.inputEl.value }))
				);
			});

		new Setting(contentEl)
			.setName("Start time")
			.setDesc("Moving the start keeps the meeting's length.")
			.addText((input) => {
				input.inputEl.type = "time";
				this.inputs.startTime = input.inputEl;
				input.inputEl.addEventListener("change", () =>
					this.update(moveStart(this.fields, { startTime: input.inputEl.value }))
				);
			});

		new Setting(contentEl)
			.setName("End time")
			.addText((input) => {
				input.inputEl.type = "time";
				this.inputs.endTime = input.inputEl;
				input.inputEl.addEventListener("change", () =>
					this.update(setEnd(this.fields, { endTime: input.inputEl.value }, this.multiDay))
				);
			});

		const lengthSetting = new Setting(contentEl).setName("Length");
		lengthSetting.controlEl.addClass("aan-schedule-presets");
		for (const minutes of LENGTH_PRESETS) {
			lengthSetting.addButton((btn) =>
				btn
					.setButtonText(formatLength(minutes * 60_000))
					.onClick(() => this.update(setLengthMinutes(this.fields, minutes)))
			);
		}
		const recordingSec = this.options.recordingLengthSec;
		if (recordingSec && recordingSec > 60) {
			lengthSetting.addButton((btn) =>
				btn
					.setButtonText(`Recording (${formatLength(recordingSec * 1000)})`)
					.setTooltip("End when the recording ends")
					.onClick(() =>
						this.update(setLengthMinutes(this.fields, Math.round(recordingSec / 60)))
					)
			);
		}

		new Setting(contentEl)
			.setName("Ends on a different day")
			.setDesc("Leave off for normal meetings; the end date follows the date above.")
			.addToggle((toggle) => {
				this.multiDayToggle = toggle;
				toggle.setValue(this.multiDay).onChange((value) => {
					if (this.syncingToggle) return;
					this.multiDay = value;
					// Turning it off pulls the end back onto the start day.
					this.update(value ? this.fields : setEnd(this.fields, {}, false));
				});
			});

		this.endDateSetting = new Setting(contentEl)
			.setName("End date")
			.addText((input) => {
				input.inputEl.type = "date";
				this.inputs.endDate = input.inputEl;
				input.inputEl.addEventListener("change", () =>
					this.update(setEnd(this.fields, { endDate: input.inputEl.value }, true))
				);
			});

		this.summaryEl = contentEl.createDiv({ cls: "aan-schedule-summary" });
		this.errorEl = contentEl.createDiv({ cls: "aan-schedule-error" });

		new Setting(contentEl)
			.addButton((btn) => {
				this.submitButton = btn.buttonEl;
				btn.setButtonText("Update schedule").setCta().onClick(() => this.submit());
			})
			.addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()));

		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private update(next: ScheduleFields) {
		this.fields = next;
		// A start or length pushed past midnight makes this a multi-day meeting.
		if (next.endDate !== next.startDate) this.multiDay = true;
		this.render();
	}

	private render() {
		for (const key of Object.keys(this.inputs) as (keyof ScheduleFields)[]) {
			const input = this.inputs[key];
			if (input && input.value !== this.fields[key]) input.value = this.fields[key];
		}
		this.endDateSetting?.settingEl.toggleClass("is-hidden", !this.multiDay);
		if (this.multiDayToggle && this.multiDayToggle.getValue() !== this.multiDay) {
			this.syncingToggle = true;
			this.multiDayToggle.setValue(this.multiDay);
			this.syncingToggle = false;
		}

		const error = validateSchedule(this.fields);
		this.errorEl?.setText(error ?? "");
		if (this.submitButton) this.submitButton.disabled = Boolean(error);
		const start = combineLocal(this.fields.startDate, this.fields.startTime);
		const end = combineLocal(this.fields.endDate, this.fields.endTime);
		if (this.summaryEl) {
			this.summaryEl.setText(
				!error && start && end ? describeRange(start, end, scheduleLengthMs(this.fields)) : ""
			);
		}
	}

	private submit() {
		if (validateSchedule(this.fields)) return;
		this.options.onSubmit({ ...this.fields });
		this.close();
	}
}

function describeRange(start: Date, end: Date, lengthMs: number | null): string {
	const day = (d: Date) =>
		d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
	const time = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	const sameDay = start.toDateString() === end.toDateString();
	const range = sameDay
		? `${day(start)} · ${time(start)} – ${time(end)}`
		: `${day(start)} ${time(start)} – ${day(end)} ${time(end)}`;
	return `${range} (${formatLength(lengthMs)})`;
}
