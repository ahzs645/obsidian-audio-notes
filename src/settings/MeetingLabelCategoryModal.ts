import { App, Modal, Notice, Setting, TextComponent } from "obsidian";
import type AutomaticAudioNotes from "../main";
import {
	normalizeTagPrefix,
	slugifyTagSegment,
	type MeetingLabelCategory,
} from "../meeting-labels";
import { MeetingLabelIconPickerModal } from "./MeetingLabelIconPickerModal";

interface MeetingLabelCategoryModalOptions {
	initialName?: string;
	initialPrefix?: string;
	initialIcon?: string;
}

export class MeetingLabelCategoryModal extends Modal {
	private name: string;
	private prefix: string;
	private icon: string;
	private nameInput: TextComponent | null = null;
	private prefixInput: TextComponent | null = null;
	private iconInput: TextComponent | null = null;

	constructor(
		app: App,
		private plugin: AutomaticAudioNotes,
		private options: MeetingLabelCategoryModalOptions = {},
		private onComplete?: (category: MeetingLabelCategory) => void
	) {
		super(app);
		this.name = options.initialName ?? "";
		this.prefix = options.initialPrefix ?? "";
		this.icon = options.initialIcon ?? "";
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "New meeting label category" });

		new Setting(contentEl)
			.setName("Name")
			.setDesc("Human-friendly name used in menus and chips.")
			.addText((text) => {
				this.nameInput = text;
				text.setValue(this.name);
				text.onChange((value) => {
					this.name = value;
				});
			});

		new Setting(contentEl)
			.setName("Tag prefix")
			.setDesc("Automatically prepended to all tags in this category.")
			.addText((text) => {
				this.prefixInput = text;
				text.setPlaceholder("job/");
				if (this.prefix) {
					text.setValue(this.prefix);
				}
				text.onChange((value) => {
					this.prefix = value;
				});
			});

		new Setting(contentEl)
			.setName("Icon or emoji")
			.setDesc("Optional. Appears beside the label in the calendar.")
			.addText((text) => {
				this.iconInput = text;
				if (this.icon) {
					text.setValue(this.icon);
				}
				text.onChange((value) => {
					this.icon = value;
				});
			})
			.addExtraButton((button) =>
				button
					.setIcon("sparkles")
					.setTooltip("Pick from library")
					.onClick(() => {
						new MeetingLabelIconPickerModal(this.app, (icon) => {
							this.icon = icon;
							this.iconInput?.setValue(icon);
						}).open();
					})
			);

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText("Create category")
					.setCta()
					.onClick(() => void this.saveCategory())
			)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => this.close())
			);
	}

	private async saveCategory() {
		const trimmedName = this.name.trim();
		if (!trimmedName) {
			new Notice("Enter a category name.", 4000);
			this.nameInput?.inputEl.focus();
			return;
		}
		const normalizedPrefix = normalizeTagPrefix(this.prefix);
		if (!normalizedPrefix) {
			new Notice("Provide a tag prefix (e.g. job/).", 4000);
			this.prefixInput?.inputEl.focus();
			return;
		}
		const categories = [
			...(this.plugin.settings.meetingLabelCategories || []),
		];
		if (
			categories.some(
				(category) => category.tagPrefix === normalizedPrefix
			)
		) {
			new Notice("That prefix is already in use.", 4000);
			return;
		}
		const id =
			slugifyTagSegment(trimmedName) ||
			slugifyTagSegment(normalizedPrefix.replace(/\/+/g, "-"));
		const category: MeetingLabelCategory = {
			id,
			name: trimmedName,
			icon: this.icon?.trim() || "",
			tagPrefix: normalizedPrefix,
		};
		categories.push(category);
		this.plugin.settings.meetingLabelCategories = categories;
		await this.plugin.saveSettings();
		this.onComplete?.(category);
		new Notice(`Added “${trimmedName}” category.`);
		this.close();
	}
}
