import {
	Modal,
	Notice,
	Setting,
	TFile,
	TextComponent,
} from "obsidian";
import type AutomaticAudioNotes from "./main";
import {
	extractWhisperArchive,
	importVttFile,
	importWhisperArchive,
	notifyWhisperImportSuccess,
	WhisperDuplicateError,
	type WhisperImportResult,
} from "./WhisperImporter";
import {
	MeetingLabelPickerModal,
	type MeetingLabelSelection,
} from "./MeetingLabelPickerModal";
import { applyMeetingLabelToFile } from "./meeting-label-manager";
import { TrimWhisperModal, type TrimResult } from "./TrimWhisperModal";

export class ImportWhisperModal extends Modal {
	private plugin: AutomaticAudioNotes;
	private selectedFiles: File[] = [];
	private useDateFolders: boolean;
	private createNote: boolean;
	private noteTitle: string;
	private dragCounter = 0;
	private importButton: HTMLButtonElement | undefined;
	private trimButton: HTMLButtonElement | undefined;
	private noteTitleInput?: TextComponent;
	private fileInput?: HTMLInputElement;
	private dropzoneEl?: HTMLElement;
	private dropzoneTextEl?: HTMLElement;
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
		this.dropzoneEl = contentEl.createDiv({
			cls: "aan-whisper-dropzone",
		});
		this.dropzoneTextEl = this.dropzoneEl.createEl("p");
		this.dropzoneEl.createEl("p", {
			text: "Multiple archives are supported.",
			cls: "aan-whisper-dropzone-hint",
		});
		this.dropzoneEl.addEventListener("click", () => {
			this.fileInput?.click();
		});
		this.dropzoneEl.addEventListener("dragenter", (event) =>
			this.handleDragEnter(event)
		);
		this.dropzoneEl.addEventListener("dragover", (event) =>
			this.handleDragOver(event)
		);
		this.dropzoneEl.addEventListener("dragleave", (event) =>
			this.handleDragLeave(event)
		);
		this.dropzoneEl.addEventListener("drop", (event) =>
			this.handleDrop(event)
		);

		const fileSetting = new Setting(contentEl)
			.setName("Whisper archive")
			.setDesc("The .whisper file you want to import.");
		this.fileInput = fileSetting.controlEl.createEl("input", {
			type: "file",
		});
		this.fileInput.accept = ".whisper,.vtt";
		this.fileInput.multiple = true;
		this.fileInput.addEventListener("change", (evt: Event) => {
			const target = evt.target as HTMLInputElement;
			this.setSelectedFiles(target.files ? Array.from(target.files) : []);
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
				.onClick(() => this.clearSelectedFiles())
		);
		this.updateSelectedFilesList();
		this.updateDropzone();

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

		const buttonRow = contentEl.createDiv({ cls: "aan-whisper-button-row" });

		this.trimButton = buttonRow.createEl("button", {
			text: "Trim & Import",
		});
		this.trimButton.disabled = true;
		this.trimButton.addEventListener("click", () =>
			this.openTrimModal()
		);

		this.importButton = buttonRow.createEl("button", {
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
		if (this.trimButton) {
			this.trimButton.disabled = this.selectedFiles.length !== 1;
		}
	}

	private clearSelectedFiles() {
		this.selectedFiles = [];
		this.noteTitle = "";
		this.noteTitleInput?.setValue("");
		if (this.fileInput) {
			this.fileInput.value = "";
		}
		this.updateSelectionUi();
	}

	private setSelectedFiles(files: File[]) {
		const { accepted, rejectedCount } = this.filterWhisperFiles(files);
		this.selectedFiles = accepted;
		this.syncNoteTitle();
		this.updateSelectionUi();
		if (rejectedCount) {
			new Notice(
				`${rejectedCount} file${rejectedCount === 1 ? "" : "s"} skipped. Only .whisper archives and .vtt files are supported.`,
				5000
			);
		}
	}

	private addSelectedFiles(files: File[]) {
		const { accepted, rejectedCount } = this.filterWhisperFiles(files);
		if (!accepted.length && rejectedCount) {
			new Notice("Only .whisper archives and .vtt files are supported.", 5000);
			return;
		}
		const merged = new Map<string, File>();
		for (const file of this.selectedFiles) {
			merged.set(this.getFileKey(file), file);
		}
		for (const file of accepted) {
			merged.set(this.getFileKey(file), file);
		}
		this.selectedFiles = Array.from(merged.values());
		this.syncNoteTitle();
		this.updateSelectionUi();
		if (rejectedCount) {
			new Notice(
				`${rejectedCount} file${rejectedCount === 1 ? "" : "s"} skipped. Only .whisper archives and .vtt files are supported.`,
				5000
			);
		}
	}

	private syncNoteTitle() {
		if (this.selectedFiles.length === 1) {
			this.noteTitle =
				this.selectedFiles[0].name.replace(/\.(whisper|vtt)$/i, "") || "";
			this.noteTitleInput?.setValue(this.noteTitle);
			return;
		}
		this.noteTitle = "";
		this.noteTitleInput?.setValue("");
	}

	private updateSelectionUi() {
		this.updateSelectedFilesList();
		this.toggleNoteInputs();
		this.toggleImportButton();
		this.updateDropzone();
		if (this.fileInput) {
			this.fileInput.value = "";
		}
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

	private updateDropzone() {
		if (!this.dropzoneEl || !this.dropzoneTextEl) {
			return;
		}
		this.dropzoneTextEl.setText(
			this.selectedFiles.length
				? "Drop more .whisper or .vtt files here or click to browse"
				: "Drop .whisper or .vtt files here or click to browse"
		);
		this.dropzoneEl.classList.toggle(
			"has-selection",
			this.selectedFiles.length > 0
		);
	}

	private filterWhisperFiles(files: File[]): {
		accepted: File[];
		rejectedCount: number;
	} {
		const accepted = files.filter(
			(file) =>
				file.name.toLowerCase().endsWith(".whisper") ||
				file.name.toLowerCase().endsWith(".vtt")
		);
		return {
			accepted,
			rejectedCount: files.length - accepted.length,
		};
	}

	private getFileKey(file: File): string {
		return `${file.name}:${file.size}:${file.lastModified}`;
	}

	private handleDragEnter(event: DragEvent) {
		event.preventDefault();
		this.dragCounter += 1;
		this.dropzoneEl?.classList.add("is-dragging");
	}

	private handleDragOver(event: DragEvent) {
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = "copy";
		}
	}

	private handleDragLeave(event: DragEvent) {
		event.preventDefault();
		this.dragCounter = Math.max(this.dragCounter - 1, 0);
		if (this.dragCounter === 0) {
			this.dropzoneEl?.classList.remove("is-dragging");
		}
	}

	private handleDrop(event: DragEvent) {
		event.preventDefault();
		this.dragCounter = 0;
		this.dropzoneEl?.classList.remove("is-dragging");
		const files = event.dataTransfer?.files;
		if (files?.length) {
			this.addSelectedFiles(Array.from(files));
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

	private async openTrimModal() {
		if (this.selectedFiles.length !== 1) {
			new Notice("Trim is only available for a single archive.");
			return;
		}
		const file = this.selectedFiles[0];
		try {
			if (this.trimButton) {
				this.trimButton.disabled = true;
				this.trimButton.textContent = "Loading…";
			}
			const buffer = await file.arrayBuffer();
			const extracted = extractWhisperArchive(buffer);
			const trimModal = new TrimWhisperModal(this.plugin, {
				audioBuffer: extracted.audioBuffer,
				audioExtension: extracted.audioExtension,
				durationSec: extracted.durationSec,
				fileName: file.name,
				segments: extracted.segments,
				onConfirm: (trimResult: TrimResult) => {
					this.importWithTrim(buffer, file.name, trimResult);
				},
			});
			trimModal.open();
		} catch (error) {
			console.error("Audio Notes: failed to open trim modal", error);
			new Notice(
				`Failed to load archive for trimming: ${(error as Error)?.message ?? error}`
			);
		} finally {
			if (this.trimButton) {
				this.trimButton.disabled = false;
				this.trimButton.textContent = "Trim & Import";
			}
		}
	}

	private async importWithTrim(
		archiveBuffer: ArrayBuffer,
		fileName: string,
		trimResult: TrimResult
	) {
		try {
			this.importButton?.setAttribute("disabled", "true");
			if (this.trimButton) this.trimButton.disabled = true;
			if (this.importButton) {
				this.importButton.textContent = "Importing…";
			}
			const overrideTitle = this.noteTitle?.trim() || undefined;
			const result = await importWhisperArchive(
				this.plugin,
				archiveBuffer,
				fileName,
				{
					audioFolder: this.plugin.settings.whisperAudioFolder,
					transcriptFolder:
						this.plugin.settings.whisperTranscriptFolder,
					useDateFolders: this.useDateFolders,
					createNote: this.createNote,
					noteFolder: this.plugin.settings.whisperNoteFolder,
					noteTitle: overrideTitle,
					trimOptions: {
						startSec: trimResult.trimRange.startSec,
						endSec: trimResult.trimRange.endSec,
						trimmedAudioBuffer: trimResult.trimmedAudioBuffer,
					},
				}
			);
			await this.applyMeetingLabel(result.notePath);
			notifyWhisperImportSuccess(result);
			void this.openImportedNote(result);
			this.close();
		} catch (error) {
			if (error instanceof WhisperDuplicateError) {
				new Notice(
					`Skipped: already imported (${error.existingTranscriptPath ?? "duplicate transcript"}).`,
					6000
				);
			} else {
				console.error("Audio Notes: trimmed import failed", error);
				new Notice(
					`Failed to import trimmed archive: ${(error as Error)?.message ?? error}`
				);
			}
			this.importButton?.removeAttribute("disabled");
			if (this.trimButton) this.trimButton.disabled = false;
			if (this.importButton) {
				this.importButton.textContent = "Import";
			}
		}
	}

	private async importFiles() {
		if (!this.selectedFiles.length) {
			new Notice("Select at least one .whisper or .vtt file first.");
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
				try {
					const overrideTitle =
						total === 1
							? this.noteTitle?.trim() || undefined
							: undefined;
					const importOptions = {
						audioFolder: this.plugin.settings.whisperAudioFolder,
						transcriptFolder: this.plugin.settings.whisperTranscriptFolder,
						useDateFolders: this.useDateFolders,
						createNote: this.createNote,
						noteFolder: this.plugin.settings.whisperNoteFolder,
						noteTitle: overrideTitle,
					};
					let result: WhisperImportResult;
					if (file.name.toLowerCase().endsWith(".vtt")) {
						const vttContent = await file.text();
						result = await importVttFile(
							this.plugin,
							vttContent,
							file.name,
							importOptions
						);
					} else {
						const buffer = await file.arrayBuffer();
						result = await importWhisperArchive(
							this.plugin,
							buffer,
							file.name,
							importOptions
						);
					}
					results.push(result);
					await this.applyMeetingLabel(result.notePath);
				} catch (error) {
					if (error instanceof WhisperDuplicateError) {
						new Notice(
							`Skipped ${file.name}: already imported (${error.existingTranscriptPath ?? "duplicate transcript"}).`,
							6000
						);
						continue;
					}
					throw error;
				}
			}
			this.notifyResults(results);
			this.close();
		} catch (error) {
			console.error("Audio Notes: Whisper import failed", error);
			new Notice(
				`Failed to import ${
					currentFileName || "file"
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
