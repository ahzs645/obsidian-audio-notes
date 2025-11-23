import { App, Modal, Setting } from "obsidian";
import type AutomaticAudioNotes from "../main";
import {
	MeetingLabelPickerModal,
	type MeetingLabelSelection,
} from "../MeetingLabelPickerModal";
import { MeetingLabelCategoryModal } from "../settings/MeetingLabelCategoryModal";
import { normalizeTagPrefix, slugifyTagSegment } from "../meeting-labels";

export interface NewMeetingDetails {
	title: string;
	date: string; // YYYY-MM-DD
	startTime: string; // HH:mm
	endTime?: string;
	meetingLabelTag?: string;
}

interface NewMeetingModalOptions {
	initialTitle?: string;
	initialDate?: string;
	initialStartTime?: string;
	initialEndTime?: string;
	onSubmit: (details: NewMeetingDetails) => void;
	plugin: AutomaticAudioNotes;
}

export class NewMeetingModal extends Modal {
	private titleValue: string;
	private dateValue: string;
	private startTimeValue: string;
	private endTimeValue: string;
	private plugin: AutomaticAudioNotes;
	private meetingLabelSelection: MeetingLabelSelection | undefined;
	private labelInputEl: HTMLInputElement | null = null;

	constructor(app: App, private options: NewMeetingModalOptions) {
		super(app);
		this.plugin = options.plugin;
		const now = new Date();
		this.titleValue = options.initialTitle ?? "New meeting";
		this.dateValue =
			options.initialDate?.trim() || now.toISOString().slice(0, 10);
		const defaultStartTime = `${now
			.getHours()
			.toString()
			.padStart(2, "0")}:${now
			.getMinutes()
			.toString()
			.padStart(2, "0")}`;
		const parseableStartTime =
			options.initialStartTime?.trim() || defaultStartTime;
		this.startTimeValue = parseableStartTime;
		const defaultEnd = this.buildDefaultEndTime(
			parseableStartTime,
			now
		);
		this.endTimeValue =
			options.initialEndTime?.trim() || defaultEnd;
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
			.setName("Label")
			.setDesc("Optional")
			.addText((input) => {
				this.labelInputEl = input.inputEl;
				input.inputEl.readOnly = true;
				input.inputEl.placeholder = "Select or create label";
				input.inputEl.classList.add("aan-transcript-label-input");
				input.inputEl.addEventListener("click", (event) => {
					event.preventDefault();
					this.openMeetingLabelPicker();
				});
				input.inputEl.addEventListener("keydown", (event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						this.openMeetingLabelPicker();
					}
				});
				this.updateMeetingLabelDisplay();
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
			meetingLabelTag: this.meetingLabelSelection?.tag,
		};
		this.options.onSubmit(details);
		this.close();
	}

	private buildDefaultEndTime(startTime: string, now: Date): string {
		const [hours, minutes] = startTime
			.split(":")
			.map((value) => Number(value));
		const end = new Date(now);
		if (Number.isFinite(hours) && Number.isFinite(minutes)) {
			end.setHours(hours, minutes + 60, 0, 0);
		} else {
			end.setTime(now.getTime() + 60 * 60 * 1000);
		}
		return `${end
			.getHours()
			.toString()
			.padStart(2, "0")}:${end
			.getMinutes()
			.toString()
			.padStart(2, "0")}`;
	}

	private updateMeetingLabelDisplay() {
		if (!this.labelInputEl) return;
		if (!this.meetingLabelSelection) {
			this.labelInputEl.value = "";
			this.labelInputEl.classList.add("is-placeholder");
			return;
		}
		const { label } = this.meetingLabelSelection;
		const iconPrefix = label.icon ? `${label.icon} ` : "";
		this.labelInputEl.value = `${iconPrefix}${label.displayName}`;
		this.labelInputEl.classList.remove("is-placeholder");
	}

	private openMeetingLabelPicker(initialQuery = "") {
		const picker = new MeetingLabelPickerModal(
			this.app,
			this.plugin,
			(selection) => {
				this.meetingLabelSelection = selection;
				this.updateMeetingLabelDisplay();
			},
			{
				onCreateCategory: (query) =>
					this.openCategoryModal(query, true),
			}
		);
		if (initialQuery) {
			picker.setInitialQuery(initialQuery);
		}
		picker.open();
	}

	private openCategoryModal(initialQuery?: string, reopenAfter = false) {
		const initialName = this.formatCategoryName(initialQuery);
		const initialPrefix = this.formatCategoryPrefix(initialQuery);
		new MeetingLabelCategoryModal(
			this.app,
			this.plugin,
			{
				initialName,
				initialPrefix,
			},
			() => {
				if (reopenAfter) {
					setTimeout(
						() => this.openMeetingLabelPicker(initialQuery ?? ""),
						100
					);
				}
			}
		).open();
	}

	private formatCategoryName(raw?: string): string {
		const value = raw?.trim();
		if (!value) return "";
		return value
			.split(/[\s/_-]+/)
			.filter(Boolean)
			.map(
				(part) =>
					part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
			)
			.join(" ");
	}

	private formatCategoryPrefix(raw?: string): string {
		if (!raw?.trim()) {
			return "";
		}
		return (
			normalizeTagPrefix(raw) ||
			`${slugifyTagSegment(raw) || "category"}/`
		);
	}
}
