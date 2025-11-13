import { App, Modal, Setting } from "obsidian";

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
	onSubmit: (update: MeetingScheduleUpdate) => void;
}

export class EditMeetingScheduleModal extends Modal {
	private startDate: string;
	private startTime: string;
	private endDate: string;
	private endTime: string;

	constructor(app: App, private options: EditMeetingScheduleModalOptions) {
		super(app);
		const now = new Date();
		const defaultDate = now.toISOString().slice(0, 10);
		const defaultStartTime = `${now
			.getHours()
			.toString()
			.padStart(2, "0")}:${now
			.getMinutes()
			.toString()
			.padStart(2, "0")}`;
		const defaultEnd = new Date(now.getTime() + 60 * 60 * 1000);
		const defaultEndTime = `${defaultEnd
			.getHours()
			.toString()
			.padStart(2, "0")}:${defaultEnd
			.getMinutes()
			.toString()
			.padStart(2, "0")}`;

		this.startDate = options.initialStartDate ?? defaultDate;
		this.startTime = options.initialStartTime ?? defaultStartTime;
		this.endDate = options.initialEndDate ?? this.startDate;
		this.endTime = options.initialEndTime ?? defaultEndTime;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Edit meeting schedule" });

		new Setting(contentEl)
			.setName("Start date")
			.addText((input) => {
				input.inputEl.type = "date";
				input.setValue(this.startDate).onChange((value) => {
					this.startDate = value;
					if (!this.endDate) {
						this.endDate = value;
					}
				});
			});

		new Setting(contentEl)
			.setName("Start time")
			.addText((input) => {
				input.inputEl.type = "time";
				input.setValue(this.startTime).onChange((value) => {
					this.startTime = value;
				});
			});

		new Setting(contentEl)
			.setName("End date")
			.setDesc("Defaults to the start date when left blank.")
			.addText((input) => {
				input.inputEl.type = "date";
				input.setValue(this.endDate).onChange((value) => {
					this.endDate = value;
				});
			});

		new Setting(contentEl)
			.setName("End time")
			.addText((input) => {
				input.inputEl.type = "time";
				input.setValue(this.endTime).onChange((value) => {
					this.endTime = value;
				});
			});

		const footer = new Setting(contentEl);
		footer
			.addButton((btn) =>
				btn
					.setButtonText("Update schedule")
					.setCta()
					.onClick(() => this.submit())
			)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private submit() {
		if (!this.startDate || !this.startTime) {
			return;
		}
		const update: MeetingScheduleUpdate = {
			startDate: this.startDate,
			startTime: this.startTime,
			endDate: this.endDate || this.startDate,
			endTime: this.endTime || this.startTime,
		};
		this.options.onSubmit(update);
		this.close();
	}
}
