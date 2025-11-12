import { App, Modal, Setting } from "obsidian";

export interface NewMeetingDetails {
	title: string;
	date: string; // YYYY-MM-DD
	startTime: string; // HH:mm
	endTime?: string;
}

interface NewMeetingModalOptions {
	initialTitle?: string;
	onSubmit: (details: NewMeetingDetails) => void;
}

export class NewMeetingModal extends Modal {
	private titleValue: string;
	private dateValue: string;
	private startTimeValue: string;
	private endTimeValue: string;

	constructor(app: App, private options: NewMeetingModalOptions) {
		super(app);
		const now = new Date();
		this.titleValue = options.initialTitle ?? "New meeting";
		this.dateValue = now.toISOString().slice(0, 10);
		this.startTimeValue = `${now
			.getHours()
			.toString()
			.padStart(2, "0")}:${now
			.getMinutes()
			.toString()
			.padStart(2, "0")}`;
		const end = new Date(now.getTime() + 60 * 60 * 1000);
		this.endTimeValue = `${end
			.getHours()
			.toString()
			.padStart(2, "0")}:${end
			.getMinutes()
			.toString()
			.padStart(2, "0")}`;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "New meeting" });

		new Setting(contentEl)
			.setName("Title")
			.addText((input) => {
				input.setValue(this.titleValue).onChange((value) => {
					this.titleValue = value.trim();
				});
				input.inputEl.placeholder = "Weekly sync";
				input.inputEl.focus();
			});

		new Setting(contentEl)
			.setName("Date")
			.addText((input) => {
				input.inputEl.type = "date";
				input.setValue(this.dateValue).onChange((value) => {
					this.dateValue = value;
				});
			});

		new Setting(contentEl)
			.setName("Start time")
			.addText((input) => {
				input.inputEl.type = "time";
				input.setValue(this.startTimeValue).onChange((value) => {
					this.startTimeValue = value;
				});
			});

		new Setting(contentEl)
			.setName("End time")
			.setDesc("Optional")
			.addText((input) => {
				input.inputEl.type = "time";
				input.setValue(this.endTimeValue).onChange((value) => {
					this.endTimeValue = value;
				});
			});

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Create meeting note")
					.setCta()
					.onClick(() => this.submit())
			)
			.addButton((btn) =>
				btn
					.setButtonText("Cancel")
					.onClick(() => this.close())
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private submit() {
		if (!this.dateValue || !this.startTimeValue) {
			return;
		}
		const details: NewMeetingDetails = {
			title: this.titleValue || "New meeting",
			date: this.dateValue,
			startTime: this.startTimeValue,
			endTime: this.endTimeValue,
		};
		this.options.onSubmit(details);
		this.close();
	}
}
