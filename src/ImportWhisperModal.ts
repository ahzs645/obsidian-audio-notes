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
} from "./WhisperImporter";

export class ImportWhisperModal extends Modal {
	private plugin: AutomaticAudioNotes;
	private selectedFile: File | undefined;
	private audioFolder: string;
	private transcriptFolder: string;
	private useDateFolders: boolean;
	private createNote: boolean;
	private noteFolder: string;
	private noteTitle: string;
	private importButton: HTMLButtonElement | undefined;
	private noteFolderInput?: TextComponent;
	private noteTitleInput?: TextComponent;

	constructor(plugin: AutomaticAudioNotes) {
		super(plugin.app);
		this.plugin = plugin;
		this.audioFolder = plugin.settings.whisperAudioFolder;
		this.transcriptFolder = plugin.settings.whisperTranscriptFolder;
		this.useDateFolders = plugin.settings.whisperUseDateFolders;
		this.createNote = plugin.settings.whisperCreateNote;
		this.noteFolder = plugin.settings.whisperNoteFolder;
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
		fileInput.addEventListener("change", (evt: Event) => {
			const target = evt.target as HTMLInputElement;
			this.selectedFile = target.files?.[0];
			if (this.selectedFile) {
				this.noteTitle =
					this.selectedFile.name.replace(/\.whisper$/i, "") || "";
				this.noteTitleInput?.setValue(this.noteTitle);
			}
			this.toggleImportButton();
		});

		new Setting(contentEl)
			.setName("Audio destination")
			.setDesc("Files are stored relative to your vault root.")
			.addText((text) =>
				text
					.setValue(this.audioFolder)
					.onChange(async (value) => {
						const cleaned = value.trim();
						this.audioFolder = cleaned;
						this.plugin.settings.whisperAudioFolder = cleaned;
						await this.plugin.saveSettings();
					})
			);
		new Setting(contentEl)
			.setName("Transcript destination")
			.setDesc("JSON transcripts are saved here.")
			.addText((text) =>
				text
					.setValue(this.transcriptFolder)
					.onChange(async (value) => {
						const cleaned = value.trim();
						this.transcriptFolder = cleaned;
						this.plugin.settings.whisperTranscriptFolder = cleaned;
						await this.plugin.saveSettings();
					})
			);

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

		const noteFolderSetting = new Setting(contentEl)
			.setName("Note destination")
			.setDesc("Relative folder for the generated note.")
			.addText((text) => {
				this.noteFolderInput = text;
				text.setPlaceholder("02-meetings")
					.setValue(this.noteFolder)
					.onChange(async (value) => {
						const cleaned = value.trim();
						this.noteFolder = cleaned;
						this.plugin.settings.whisperNoteFolder = cleaned;
						await this.plugin.saveSettings();
					});
			});

		const noteTitleSetting = new Setting(contentEl)
			.setName("Note title")
			.setDesc("Defaults to the Whisper filename if left blank.")
			.addText((text) => {
				this.noteTitleInput = text;
				text.setPlaceholder("Pipeline decisions with Will")
					.setValue(this.noteTitle)
					.onChange((value) => {
						this.noteTitle = value;
					});
			});

		this.importButton = contentEl.createEl("button", {
			text: "Import",
			cls: "mod-cta",
		});
		this.importButton.disabled = true;
		this.importButton.addEventListener("click", () => this.importFile());

		this.toggleNoteInputs();
	}

	onClose() {
		this.contentEl.empty();
	}

	private toggleImportButton() {
		if (!this.importButton) return;
		this.importButton.disabled = !this.selectedFile;
	}

	private toggleNoteInputs() {
		const disabled = !this.createNote;
		this.noteFolderInput?.setDisabled(disabled);
		this.noteTitleInput?.setDisabled(disabled);
	}

	private async importFile() {
		if (!this.selectedFile) {
			new Notice("Select a .whisper file first.");
			return;
		}
		try {
			this.importButton?.setAttribute("disabled", "true");
			if (this.importButton) {
				this.importButton.textContent = "Importing…";
			}
			const buffer = await this.selectedFile.arrayBuffer();
			const result = await importWhisperArchive(
				this.plugin,
				buffer,
				this.selectedFile.name,
				{
					audioFolder: this.audioFolder || this.plugin.settings.whisperAudioFolder,
					transcriptFolder:
						this.transcriptFolder ||
						this.plugin.settings.whisperTranscriptFolder,
					useDateFolders: this.useDateFolders,
					createNote: this.createNote,
					noteFolder: this.noteFolder || this.plugin.settings.whisperNoteFolder,
					noteTitle: this.noteTitle || undefined,
				}
			);
			notifyWhisperImportSuccess(result);
			if (result.notePath) {
				const file = this.plugin.app.vault.getAbstractFileByPath(
					result.notePath
				);
				if (file instanceof TFile) {
					await this.plugin.app.workspace
						.getLeaf(true)
						.openFile(file);
				}
			}
			this.close();
		} catch (error) {
			console.error("Audio Notes: Whisper import failed", error);
			new Notice(
				`Failed to import Whisper archive: ${
					(error as Error)?.message ?? error
				}`
			);
			this.importButton?.removeAttribute("disabled");
			if (this.importButton) {
				this.importButton.textContent = "Import";
			}
		}
	}
}
