import {
	Modal,
	Notice,
	Setting,
	TFile,
	TextComponent,
} from "obsidian";
import type AutomaticAudioNotes from "./main";
import {
	importWhisperArchive,
	notifyWhisperImportSuccess,
	type WhisperImportResult,
} from "./WhisperImporter";
import {
	MeetingLabelPickerModal,
	type MeetingLabelSelection,
} from "./MeetingLabelPickerModal";
import { applyMeetingLabelToFile } from "./meeting-label-manager";

export class ImportWhisperModal extends Modal {
	private plugin: AutomaticAudioNotes;
	private selectedFiles: File[] = [];
	private useDateFolders: boolean;
	private createNote: boolean;
	private noteTitle: string;
	private importButton: HTMLButtonElement | undefined;
	private noteTitleInput?: TextComponent;
	private selectedFilesContainer?: HTMLElement;
	private meetingLabelSelection?: MeetingLabelSelection;
	private meetingLabelDisplay?: HTMLElement;

	constructor(plugin: AutomaticAudioNotes) {
		super(plugin.app);
		this.plugin = plugin;
		this.useDateFolders = plugin.settings.whisperUseDateFolders;
		this.createNote = plugin.settings.whisperCreateNote;
		this.noteTitle = "";
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", {
			text: "Import Whisper transcription",
		});
		contentEl.createEl("p", {
			text: "Select a .whisper archive exported from WhisperKit (or compatible apps) and Audio Notes will extract the audio + transcript directly into your vault.",
		});

		const fileSetting = new Setting(contentEl)
			.setName("Whisper archive")
			.setDesc("The .whisper file you want to import.");
		const fileInput = fileSetting.controlEl.createEl("input", {
			type: "file",
		});
		fileInput.accept = ".whisper";
		fileInput.multiple = true;
		fileInput.addEventListener("change", (evt: Event) => {
			const target = evt.target as HTMLInputElement;
			this.selectedFiles = target.files ? Array.from(target.files) : [];
			if (this.selectedFiles.length === 1) {
				this.noteTitle =
					this.selectedFiles[0].name.replace(/\.whisper$/i, "") || "";
				this.noteTitleInput?.setValue(this.noteTitle);
			} else {
				this.noteTitle = "";
				this.noteTitleInput?.setValue("");
			}
			this.updateSelectedFilesList();
			this.toggleNoteInputs();
			this.toggleImportButton();
		});

		const selectionSetting = new Setting(contentEl)
			.setName("Selected archives")
			.setDesc("Choose one or more .whisper files to import in a batch.");
		this.selectedFilesContainer = selectionSetting.controlEl.createDiv(
			"aan-whisper-selected-files"
		);
		selectionSetting.addExtraButton((button) =>
			button
				.setIcon("x")
				.setTooltip("Clear selection")
				.onClick(() => {
					this.selectedFiles = [];
					this.noteTitle = "";
					this.noteTitleInput?.setValue("");
					fileInput.value = "";
					this.updateSelectedFilesList();
					this.toggleNoteInputs();
					this.toggleImportButton();
				})
		);
		this.updateSelectedFilesList();

		new Setting(contentEl)
			.setName("Use date subfolders")
			.setDesc("Organize imports into YYYY/MM folders using the recording date.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.useDateFolders)
					.onChange(async (value) => {
						this.useDateFolders = value;
						this.plugin.settings.whisperUseDateFolders = value;
						await this.plugin.saveSettings();
					})
			);

		const noteToggleSetting = new Setting(contentEl)
			.setName("Create note after import")
			.setDesc("Generate a Markdown note with the audio-note block.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.createNote)
					.onChange(async (value) => {
						this.createNote = value;
						this.plugin.settings.whisperCreateNote = value;
						await this.plugin.saveSettings();
						this.toggleNoteInputs();
					})
			);
		noteToggleSetting.controlEl.addClass("whisper-note-toggle");

		const noteTitleSetting = new Setting(contentEl)
			.setName("Note title")
			.setDesc(
				"Defaults to the archive filename when left blank. For batch imports, each note keeps its own filename."
			)
			.addText((text) => {
				this.noteTitleInput = text;
				text.setPlaceholder("Pipeline decisions with Will")
					.setValue(this.noteTitle)
					.onChange((value) => {
						this.noteTitle = value;
					});
			});

		const labelSetting = new Setting(contentEl)
			.setName("Meeting label")
			.setDesc("Apply a meeting label to every generated note (optional).");
		this.meetingLabelDisplay = labelSetting.controlEl.createDiv({
			text: "No label selected",
			cls: "aan-whisper-label-display",
		});
		labelSetting.addButton((button) =>
			button
				.setButtonText("Choose label")
				.onClick(() => this.openMeetingLabelPicker())
		);
		labelSetting.addExtraButton((button) =>
			button
				.setIcon("x")
				.setTooltip("Clear meeting label")
				.onClick(() => {
					this.meetingLabelSelection = undefined;
					this.updateMeetingLabelDisplay();
				})
		);

		this.importButton = contentEl.createEl("button", {
			text: "Import",
			cls: "mod-cta",
		});
		this.importButton.disabled = true;
		this.importButton.addEventListener("click", () => this.importFiles());

		this.toggleNoteInputs();
	}

	onClose() {
		this.contentEl.empty();
	}

	private toggleImportButton() {
		if (!this.importButton) return;
		this.importButton.disabled = !this.selectedFiles.length;
	}

	private toggleNoteInputs() {
		const disabled = !this.createNote || this.selectedFiles.length !== 1;
		this.noteTitleInput?.setDisabled(disabled);
		if (this.noteTitleInput) {
			const placeholder = disabled
				? "Uses archive filename automatically"
				: "Pipeline decisions with Will";
			this.noteTitleInput.setPlaceholder(placeholder);
		}
	}

	private updateSelectedFilesList() {
		if (!this.selectedFilesContainer) {
			return;
		}
		this.selectedFilesContainer.replaceChildren();
		if (!this.selectedFiles.length) {
			this.selectedFilesContainer.createSpan({
				text: "No archives selected.",
			});
			return;
		}
		const summary =
			this.selectedFiles.length === 1
				? this.selectedFiles[0].name
				: `${this.selectedFiles.length} archives selected`;
		this.selectedFilesContainer.createDiv({
			text: summary,
			cls: "aan-whisper-selected-files-summary",
		});
		if (this.selectedFiles.length > 1) {
			const list = this.selectedFilesContainer.createEl("ul", {
				cls: "aan-whisper-selected-files-list",
			});
			for (const file of this.selectedFiles) {
				list.createEl("li", { text: file.name });
			}
		}
	}

	private openMeetingLabelPicker() {
		const picker = new MeetingLabelPickerModal(
			this.app,
			this.plugin,
			(selection) => {
				this.meetingLabelSelection = selection;
				this.updateMeetingLabelDisplay();
			}
		);
		picker.open();
	}

	private updateMeetingLabelDisplay() {
		if (!this.meetingLabelDisplay) return;
		this.meetingLabelDisplay.replaceChildren();
		if (!this.meetingLabelSelection) {
			this.meetingLabelDisplay.setText("No label selected");
			return;
		}
		if (this.meetingLabelSelection.label.icon) {
			this.meetingLabelDisplay.createSpan({
				text: this.meetingLabelSelection.label.icon,
				cls: "aan-whisper-label-icon",
			});
		}
		this.meetingLabelDisplay.createSpan({
			text: this.meetingLabelSelection.label.displayName,
			cls: "aan-whisper-label-text",
		});
	}

	private async importFiles() {
		if (!this.selectedFiles.length) {
			new Notice("Select at least one .whisper file first.");
			return;
		}
		const total = this.selectedFiles.length;
		let currentFileName = "";
		const results = [];
		try {
			this.importButton?.setAttribute("disabled", "true");
			if (this.importButton) {
				this.importButton.textContent =
					total > 1 ? `Importing 1/${total}…` : "Importing…";
			}
			for (let index = 0; index < total; index++) {
				const file = this.selectedFiles[index];
				currentFileName = file.name;
				if (this.importButton && total > 1) {
					this.importButton.textContent = `Importing ${index + 1}/${total}…`;
				}
				const buffer = await file.arrayBuffer();
				const overrideTitle =
					total === 1 ? (this.noteTitle?.trim() || undefined) : undefined;
				const result = await importWhisperArchive(
					this.plugin,
					buffer,
					file.name,
					{
						audioFolder: this.plugin.settings.whisperAudioFolder,
						transcriptFolder: this.plugin.settings.whisperTranscriptFolder,
						useDateFolders: this.useDateFolders,
						createNote: this.createNote,
						noteFolder: this.plugin.settings.whisperNoteFolder,
						noteTitle: overrideTitle,
					}
				);
				results.push(result);
				await this.applyMeetingLabel(result.notePath);
			}
			this.notifyResults(results);
			this.close();
		} catch (error) {
			console.error("Audio Notes: Whisper import failed", error);
			new Notice(
				`Failed to import ${
					currentFileName || "Whisper archive"
				}: ${(error as Error)?.message ?? error}`
			);
			this.importButton?.removeAttribute("disabled");
			if (this.importButton) {
				this.importButton.textContent = "Import";
			}
			return;
		}
		this.importButton?.removeAttribute("disabled");
		if (this.importButton) {
			this.importButton.textContent = "Import";
		}
	}

	private notifyResults(results: WhisperImportResult[]) {
		if (!results.length) {
			return;
		}
		if (results.length === 1) {
			notifyWhisperImportSuccess(results[0]);
			void this.openImportedNote(results[0]);
			return;
		}
		const noteCount = results.filter((result) => Boolean(result.notePath)).length;
		new Notice(
			`${results.length} Whisper archives imported.\nNotes created: ${noteCount}`
		);
	}

	private async applyMeetingLabel(notePath?: string) {
		if (!notePath || !this.meetingLabelSelection?.tag) {
			return;
		}
		const file = this.plugin.app.vault.getAbstractFileByPath(notePath);
		if (file instanceof TFile) {
			await applyMeetingLabelToFile(
				this.plugin.app,
				file,
				this.meetingLabelSelection.tag
			);
		}
	}

	private async openImportedNote(result: WhisperImportResult) {
		if (!result.notePath) {
			return;
		}
		const file = this.plugin.app.vault.getAbstractFileByPath(result.notePath);
		if (file instanceof TFile) {
			await this.plugin.app.workspace.getLeaf(true).openFile(file);
		}
	}
}
