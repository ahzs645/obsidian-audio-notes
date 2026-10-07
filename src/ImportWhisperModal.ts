import { Modal, Notice, Setting, TFile, setIcon } from "obsidian";
import type AutomaticAudioNotes from "./main";
import {
	extractWhisperArchive,
	importVttFile,
	importWhisperArchive,
	isWhisperArchiveName,
	notifyWhisperImportSuccess,
	parseVttFilenameDate,
	peekWhisperArchive,
	stripWhisperArchiveExtension,
	WhisperDuplicateError,
	type WhisperImportResult,
} from "./WhisperImporter";
import {
	MeetingLabelPickerModal,
	type MeetingLabelSelection,
} from "./MeetingLabelPickerModal";
import { applyMeetingLabelToFile } from "./meeting-label-manager";
import { resolveLabelColor } from "./meeting-labels";
import { formatLength } from "./schedule-math";
import { TrimWhisperModal, type TrimResult } from "./TrimWhisperModal";

type ImportStatus = "ready" | "importing" | "done" | "duplicate" | "failed";

interface ImportItem {
	key: string;
	file: File;
	kind: "archive" | "vtt";
	/** "Thu, Sep 10 · 2:02 PM · 1h 16m · 1,305 lines", filled in once read. */
	details?: string;
	status: ImportStatus;
	message?: string;
	result?: WhisperImportResult;
	rowEl?: HTMLElement;
}

const ACCEPTED = "Only .whisper (or .whisper.zip) archives and .vtt transcripts can be imported.";

/**
 * One list of files with a status per file. Picking, dropping and removing
 * all happen in that list; options that rarely change sit in a collapsed
 * section, and a failed file no longer stops the rest of a batch.
 */
export class ImportWhisperModal extends Modal {
	private plugin: AutomaticAudioNotes;
	private items: ImportItem[] = [];
	private useDateFolders: boolean;
	private createNote: boolean;
	private noteTitle = "";
	private busy = false;
	private dragCounter = 0;
	private meetingLabelSelection?: MeetingLabelSelection;
	/** Archives are read one at a time so a big batch doesn't load them all at once. */
	private detailsQueue: Promise<void> = Promise.resolve();

	private fileInput!: HTMLInputElement;
	private dropzoneEl!: HTMLElement;
	private dropzoneTextEl!: HTMLElement;
	private listEl!: HTMLElement;
	private titleSetting!: Setting;
	private titleInput!: HTMLInputElement;
	private labelChipEl!: HTMLElement;
	private optionsSummaryEl!: HTMLElement;
	private importButton!: HTMLButtonElement;
	private trimButton!: HTMLButtonElement;
	private cancelButton!: HTMLButtonElement;

	constructor(plugin: AutomaticAudioNotes) {
		super(plugin.app);
		this.plugin = plugin;
		this.useDateFolders = plugin.settings.whisperUseDateFolders;
		this.createNote = plugin.settings.whisperCreateNote;
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		modalEl.addClass("aan-import-modal");
		contentEl.empty();
		contentEl.createEl("h2", { text: "Import recordings" });
		contentEl.createEl("p", {
			cls: "aan-import-intro",
			text: "Add .whisper archives (recording + transcript) or .vtt transcripts. Each becomes a meeting note.",
		});

		this.fileInput = contentEl.createEl("input", {
			type: "file",
			attr: { accept: ".whisper,.zip,.vtt", multiple: "", hidden: "" },
		});
		this.fileInput.addEventListener("change", () => {
			this.addFiles(Array.from(this.fileInput.files ?? []));
			this.fileInput.value = "";
		});

		this.dropzoneEl = contentEl.createDiv({
			cls: "aan-whisper-dropzone",
			attr: { role: "button", tabindex: "0" },
		});
		const dropIcon = this.dropzoneEl.createSpan({ cls: "aan-import-drop-icon" });
		setIcon(dropIcon, "upload");
		this.dropzoneTextEl = this.dropzoneEl.createEl("p");
		this.dropzoneEl.addEventListener("click", () => this.fileInput.click());
		this.dropzoneEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				this.fileInput.click();
			}
		});
		this.dropzoneEl.addEventListener("dragenter", (event) => this.handleDragEnter(event));
		this.dropzoneEl.addEventListener("dragover", (event) => {
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		});
		this.dropzoneEl.addEventListener("dragleave", (event) => this.handleDragLeave(event));
		this.dropzoneEl.addEventListener("drop", (event) => this.handleDrop(event));

		this.listEl = contentEl.createDiv({ cls: "aan-import-list" });

		this.titleSetting = new Setting(contentEl)
			.setName("Note title")
			.setDesc("Leave blank to use the file name. AI notes can rename it later.");
		this.titleInput = this.titleSetting.controlEl.createEl("input", {
			type: "text",
			attr: { placeholder: "e.g. Pipeline decisions with Will" },
		});
		this.titleInput.addEventListener("input", () => {
			this.noteTitle = this.titleInput.value;
		});

		const labelSetting = new Setting(contentEl)
			.setName("Meeting label")
			.setDesc("Applied to every imported note.");
		this.labelChipEl = labelSetting.controlEl.createEl("button", {
			cls: "aan-import-label-chip",
			attr: { type: "button" },
		});
		this.labelChipEl.addEventListener("click", () => this.openMeetingLabelPicker());

		const options = contentEl.createEl("details", { cls: "aan-import-options" });
		const summary = options.createEl("summary");
		summary.createSpan({ text: "Import options", cls: "aan-import-options-title" });
		this.optionsSummaryEl = summary.createSpan({ cls: "aan-import-options-summary" });
		new Setting(options)
			.setName("Create a meeting note")
			.setDesc(`Saved in ${this.plugin.settings.whisperNoteFolder || "the vault root"}.`)
			.addToggle((toggle) =>
				toggle.setValue(this.createNote).onChange(async (value) => {
					this.createNote = value;
					this.plugin.settings.whisperCreateNote = value;
					await this.plugin.saveSettings();
					this.render();
				})
			);
		new Setting(options)
			.setName("File by month")
			.setDesc(
				`Put recordings and transcripts in YYYY/MM folders under ${this.plugin.settings.whisperAudioFolder} and ${this.plugin.settings.whisperTranscriptFolder}.`
			)
			.addToggle((toggle) =>
				toggle.setValue(this.useDateFolders).onChange(async (value) => {
					this.useDateFolders = value;
					this.plugin.settings.whisperUseDateFolders = value;
					await this.plugin.saveSettings();
					this.render();
				})
			);

		const footer = contentEl.createDiv({ cls: "aan-whisper-button-row" });
		this.trimButton = footer.createEl("button", { text: "Trim & import…" });
		this.trimButton.title = "Cut the start or end of the recording before importing";
		this.trimButton.addEventListener("click", () => void this.openTrimModal());
		footer.createDiv({ cls: "aan-import-spacer" });
		this.cancelButton = footer.createEl("button", { text: "Cancel" });
		this.cancelButton.addEventListener("click", () => this.close());
		this.importButton = footer.createEl("button", { cls: "mod-cta" });
		this.importButton.addEventListener("click", () => void this.importAll());

		this.render();
	}

	onClose() {
		this.contentEl.empty();
	}

	// ── Selection ──────────────────────────────────────────────────

	private addFiles(files: File[]) {
		if (this.busy) return;
		const accepted = files.filter(
			(file) => isWhisperArchiveName(file.name) || /\.vtt$/i.test(file.name)
		);
		const rejected = files.length - accepted.length;
		if (rejected) {
			new Notice(
				`${rejected} file${rejected === 1 ? "" : "s"} skipped. ${ACCEPTED}`,
				5000
			);
		}
		// Finished rows from a previous run make way for the new batch.
		this.items = this.items.filter((item) => item.status !== "done" && item.status !== "duplicate");
		for (const file of accepted) {
			const key = `${file.name}:${file.size}:${file.lastModified}`;
			if (this.items.some((item) => item.key === key)) continue;
			const item: ImportItem = {
				key,
				file,
				kind: /\.vtt$/i.test(file.name) ? "vtt" : "archive",
				status: "ready",
			};
			this.items.push(item);
			this.detailsQueue = this.detailsQueue.then(() => this.readDetails(item));
		}
		this.render();
	}

	private removeItem(item: ImportItem) {
		if (this.busy) return;
		this.items = this.items.filter((entry) => entry !== item);
		this.render();
	}

	/** Date, length and line count, read without unpacking the audio. */
	private async readDetails(item: ImportItem) {
		if (!this.items.includes(item)) return;
		try {
			let startMs: number | undefined;
			let durationSec = 0;
			let lines: number | undefined;
			if (item.kind === "vtt") {
				const parsed = parseVttFilenameDate(item.file.name);
				startMs = parsed.startMs;
				if (parsed.startMs && parsed.endMs) durationSec = (parsed.endMs - parsed.startMs) / 1000;
			} else {
				const peek = peekWhisperArchive(await item.file.arrayBuffer());
				startMs = peek.startMs;
				durationSec = peek.durationSec;
				lines = peek.lineCount;
			}
			const parts: string[] = [];
			if (startMs) {
				const start = new Date(startMs);
				parts.push(
					start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
					start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
				);
			}
			const length = formatLength(durationSec * 1000);
			if (length) parts.push(length);
			if (lines !== undefined) parts.push(`${lines.toLocaleString()} lines`);
			item.details = parts.join(" · ");
		} catch (error) {
			item.details = undefined;
			item.status = "failed";
			item.message = error instanceof Error ? error.message : String(error);
		}
		this.render();
	}

	// ── Rendering ──────────────────────────────────────────────────

	private render() {
		const pending = this.items.filter((item) => item.status === "ready" || item.status === "failed");
		const single = this.items.length === 1 ? this.items[0] : undefined;

		this.dropzoneTextEl.setText(
			this.items.length
				? "Drop more files here, or click to add"
				: "Drop .whisper or .vtt files here, or click to choose"
		);
		this.dropzoneEl.toggleClass("is-compact", this.items.length > 0);

		this.listEl.empty();
		this.listEl.toggleClass("is-empty", !this.items.length);
		for (const item of this.items) this.renderItem(item);

		// A title only makes sense for one note; batches keep file names.
		const showTitle = this.createNote && this.items.length <= 1;
		this.titleSetting.settingEl.toggleClass("is-hidden", !showTitle);
		this.titleInput.disabled = this.busy;
		if (single && !this.noteTitle && !this.titleInput.value) {
			this.titleInput.placeholder = stripWhisperArchiveExtension(single.file.name).replace(/\.vtt$/i, "");
		}

		this.renderLabelChip();
		this.optionsSummaryEl.setText(
			[
				this.createNote ? `Notes in ${this.plugin.settings.whisperNoteFolder || "vault root"}` : "No notes",
				this.useDateFolders ? "filed by month" : "no month folders",
			].join(" · ")
		);

		const retrying = pending.some((item) => item.status === "failed");
		this.importButton.disabled = this.busy || !pending.length;
		this.importButton.setText(
			this.busy
				? "Importing…"
				: retrying
					? `Retry ${pending.length} file${pending.length === 1 ? "" : "s"}`
					: `Import${pending.length > 1 ? ` ${pending.length} files` : ""}`
		);
		const finished = this.items.length > 0 && !pending.length && !this.busy;
		this.cancelButton.setText(finished ? "Done" : "Cancel");
		this.cancelButton.toggleClass("mod-cta", finished);
		this.importButton.toggleClass("is-hidden", finished);
		// Trimming needs the recording, so only a single archive.
		const canTrim = !this.busy && pending.length === 1 && this.items.length === 1 && pending[0].kind === "archive";
		this.trimButton.toggleClass("is-hidden", !canTrim);
	}

	private renderItem(item: ImportItem) {
		const row = this.listEl.createDiv({ cls: `aan-import-item is-${item.status}` });
		item.rowEl = row;
		const icon = row.createSpan({ cls: "aan-import-item-icon" });
		setIcon(icon, item.kind === "vtt" ? "file-text" : "file-audio");
		const body = row.createDiv({ cls: "aan-import-item-body" });
		body.createDiv({ cls: "aan-import-item-name", text: item.file.name });
		const meta = body.createDiv({ cls: "aan-import-item-meta" });
		const kind = item.kind === "vtt" ? "Transcript only" : "Recording + transcript";
		const size = formatBytes(item.file.size);
		meta.setText(
			item.message && item.status !== "done"
				? item.message
				: [kind, item.details ?? (item.kind === "archive" ? "reading…" : ""), size]
						.filter(Boolean)
						.join(" · ")
		);

		const side = row.createDiv({ cls: "aan-import-item-side" });
		if (item.status === "ready") {
			const remove = side.createEl("button", {
				cls: "clickable-icon",
				attr: { type: "button", "aria-label": `Remove ${item.file.name}` },
			});
			setIcon(remove, "x");
			remove.disabled = this.busy;
			remove.addEventListener("click", () => this.removeItem(item));
			return;
		}
		const pill = side.createSpan({ cls: "aan-import-status" });
		if (item.status === "importing") pill.setText("Importing…");
		if (item.status === "duplicate") pill.setText("Already imported");
		if (item.status === "failed") {
			pill.setText("Failed");
			const remove = side.createEl("button", {
				cls: "clickable-icon",
				attr: { type: "button", "aria-label": `Remove ${item.file.name}` },
			});
			setIcon(remove, "x");
			remove.disabled = this.busy;
			remove.addEventListener("click", () => this.removeItem(item));
		}
		if (item.status === "done") {
			const path = item.result?.notePath;
			if (path) {
				const open = side.createEl("button", { text: "Open note", attr: { type: "button" } });
				open.addEventListener("click", () => void this.openNote(path));
			} else {
				pill.setText("Imported");
			}
		}
	}

	private renderLabelChip() {
		const chip = this.labelChipEl;
		chip.empty();
		const selection = this.meetingLabelSelection;
		chip.toggleClass("has-label", Boolean(selection));
		if (selection) {
			chip.style.setProperty(
				"--aan-label-color",
				resolveLabelColor(selection.tag, this.plugin.settings.calendarTagColors)
			);
			chip.createSpan({ cls: "aan-import-label-dot" });
			chip.createSpan({ text: selection.label.displayName });
			const clear = chip.createSpan({
				cls: "aan-import-label-clear",
				attr: { role: "button", "aria-label": "Remove label" },
			});
			setIcon(clear, "x");
			clear.addEventListener("click", (event) => {
				event.stopPropagation();
				this.meetingLabelSelection = undefined;
				this.render();
			});
		} else {
			chip.style.removeProperty("--aan-label-color");
			chip.setText("Choose label…");
		}
		chip.toggleAttribute("disabled", this.busy);
	}

	// ── Drag and drop ──────────────────────────────────────────────

	private handleDragEnter(event: DragEvent) {
		event.preventDefault();
		this.dragCounter += 1;
		this.dropzoneEl.addClass("is-dragging");
	}

	private handleDragLeave(event: DragEvent) {
		event.preventDefault();
		this.dragCounter = Math.max(this.dragCounter - 1, 0);
		if (this.dragCounter === 0) this.dropzoneEl.removeClass("is-dragging");
	}

	private handleDrop(event: DragEvent) {
		event.preventDefault();
		this.dragCounter = 0;
		this.dropzoneEl.removeClass("is-dragging");
		const files = event.dataTransfer?.files;
		if (files?.length) this.addFiles(Array.from(files));
	}

	// ── Import ─────────────────────────────────────────────────────

	private importOptions(title?: string) {
		return {
			audioFolder: this.plugin.settings.whisperAudioFolder,
			transcriptFolder: this.plugin.settings.whisperTranscriptFolder,
			useDateFolders: this.useDateFolders,
			createNote: this.createNote,
			noteFolder: this.plugin.settings.whisperNoteFolder,
			noteTitle: title,
		};
	}

	/** Imports every pending file; one failure doesn't stop the others. */
	private async importAll() {
		const queue = this.items.filter((item) => item.status === "ready" || item.status === "failed");
		if (!queue.length || this.busy) return;
		this.busy = true;
		const title = this.items.length === 1 ? this.noteTitle.trim() || undefined : undefined;
		for (const item of queue) {
			item.status = "importing";
			item.message = undefined;
			this.render();
			try {
				const result =
					item.kind === "vtt"
						? await importVttFile(this.plugin, await item.file.text(), item.file.name, this.importOptions(title))
						: await importWhisperArchive(this.plugin, await item.file.arrayBuffer(), item.file.name, this.importOptions(title));
				await this.applyMeetingLabel(result.notePath);
				item.result = result;
				item.status = "done";
			} catch (error) {
				if (error instanceof WhisperDuplicateError) {
					item.status = "duplicate";
					item.message = error.existingTranscriptPath
						? `Already in ${error.existingTranscriptPath}`
						: "Already imported";
				} else {
					console.error("Audio Notes: import failed", item.file.name, error);
					item.status = "failed";
					item.message = error instanceof Error ? error.message : String(error);
				}
			}
		}
		this.busy = false;
		this.finish();
	}

	private finish() {
		const done = this.items.filter((item) => item.status === "done");
		const failed = this.items.filter((item) => item.status === "failed");
		// A single clean import goes straight to its note, as before.
		if (this.items.length === 1 && done.length === 1) {
			notifyWhisperImportSuccess(done[0].result!);
			void this.openNote(done[0].result!.notePath);
			this.close();
			return;
		}
		if (done.length) {
			new Notice(
				`Imported ${done.length} of ${this.items.length}${failed.length ? `; ${failed.length} failed` : ""}.`,
				6000
			);
		}
		this.render();
	}

	private async openTrimModal() {
		const item = this.items[0];
		if (!item || item.kind !== "archive") return;
		this.trimButton.disabled = true;
		this.trimButton.setText("Loading…");
		try {
			const buffer = await item.file.arrayBuffer();
			const extracted = extractWhisperArchive(buffer);
			new TrimWhisperModal(this.plugin, {
				audioBuffer: extracted.audioBuffer,
				audioExtension: extracted.audioExtension,
				durationSec: extracted.durationSec,
				fileName: item.file.name,
				segments: extracted.segments,
				onConfirm: (trimResult: TrimResult) => void this.importWithTrim(item, buffer, trimResult),
			}).open();
		} catch (error) {
			console.error("Audio Notes: failed to open trim modal", error);
			new Notice(`Couldn't open this archive for trimming: ${(error as Error)?.message ?? error}`);
		} finally {
			this.trimButton.disabled = false;
			this.trimButton.setText("Trim & import…");
		}
	}

	private async importWithTrim(item: ImportItem, buffer: ArrayBuffer, trim: TrimResult) {
		this.busy = true;
		item.status = "importing";
		this.render();
		try {
			const result = await importWhisperArchive(this.plugin, buffer, item.file.name, {
				...this.importOptions(this.noteTitle.trim() || undefined),
				trimOptions: {
					startSec: trim.trimRange.startSec,
					endSec: trim.trimRange.endSec,
					trimmedAudioBuffer: trim.trimmedAudioBuffer,
				},
			});
			await this.applyMeetingLabel(result.notePath);
			item.result = result;
			item.status = "done";
		} catch (error) {
			if (error instanceof WhisperDuplicateError) {
				item.status = "duplicate";
				item.message = `Already in ${error.existingTranscriptPath ?? "the vault"}`;
			} else {
				console.error("Audio Notes: trimmed import failed", error);
				item.status = "failed";
				item.message = error instanceof Error ? error.message : String(error);
			}
		}
		this.busy = false;
		this.finish();
	}

	private openMeetingLabelPicker() {
		if (this.busy) return;
		new MeetingLabelPickerModal(
			this.app,
			this.plugin,
			(selection) => {
				this.meetingLabelSelection = selection;
				this.render();
			},
			{ currentTags: this.meetingLabelSelection ? [this.meetingLabelSelection.tag] : [] }
		).open();
	}

	private async applyMeetingLabel(notePath?: string) {
		if (!notePath || !this.meetingLabelSelection?.tag) return;
		const file = this.plugin.app.vault.getAbstractFileByPath(notePath);
		if (file instanceof TFile) {
			await applyMeetingLabelToFile(this.plugin.app, file, this.meetingLabelSelection.tag);
		}
	}

	private async openNote(path?: string) {
		if (!path) return;
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.plugin.app.workspace.getLeaf(true).openFile(file);
		}
	}
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
