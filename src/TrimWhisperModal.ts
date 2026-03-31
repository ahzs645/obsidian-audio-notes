import { Modal, Notice, Setting } from "obsidian";
import type AutomaticAudioNotes from "./main";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, {
	type Region,
} from "wavesurfer.js/dist/plugins/regions.esm.js";
import { trimAudioToWav, type TrimRange } from "./AudioTrimmer";
import type { ProcessedSegment } from "./WhisperImporter";

export interface TrimResult {
	trimRange: TrimRange;
	trimmedAudioBuffer: Buffer;
}

interface TrimWhisperModalOptions {
	audioBuffer: Buffer;
	audioExtension: string;
	durationSec: number;
	fileName: string;
	segments: ProcessedSegment[];
	onConfirm: (result: TrimResult) => void;
}

export class TrimWhisperModal extends Modal {
	private plugin: AutomaticAudioNotes;
	private options: TrimWhisperModalOptions;
	private wavesurfer: WaveSurfer | null = null;
	private region: Region | null = null;
	private regionsPlugin: RegionsPlugin | null = null;
	private startInput: HTMLInputElement | null = null;
	private endInput: HTMLInputElement | null = null;
	private confirmButton: HTMLButtonElement | null = null;
	private transcriptContainer: HTMLElement | null = null;
	private segmentEls: HTMLElement[] = [];
	private isProcessing = false;

	constructor(plugin: AutomaticAudioNotes, options: TrimWhisperModalOptions) {
		super(plugin.app);
		this.plugin = plugin;
		this.options = options;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("aan-trim-modal");

		contentEl.createEl("h2", { text: "Trim audio before import" });
		contentEl.createEl("p", {
			text: `Drag the waveform region or click transcript segments to set trim boundaries for "${this.options.fileName}".`,
			cls: "aan-trim-description",
		});

		// Waveform container
		const waveformContainer = contentEl.createDiv({
			cls: "aan-trim-waveform",
		});

		// Time display
		const timeRow = contentEl.createDiv({ cls: "aan-trim-time-row" });

		const startGroup = timeRow.createDiv({ cls: "aan-trim-time-group" });
		startGroup.createEl("label", { text: "Start" });
		this.startInput = startGroup.createEl("input", {
			type: "text",
			cls: "aan-trim-time-input",
			value: this.formatTime(0),
		});

		const endGroup = timeRow.createDiv({ cls: "aan-trim-time-group" });
		endGroup.createEl("label", { text: "End" });
		this.endInput = endGroup.createEl("input", {
			type: "text",
			cls: "aan-trim-time-input",
			value: this.formatTime(this.options.durationSec),
		});

		const durationGroup = timeRow.createDiv({
			cls: "aan-trim-time-group",
		});
		durationGroup.createEl("label", { text: "Duration" });
		durationGroup.createEl("span", {
			text: this.formatTime(this.options.durationSec),
			cls: "aan-trim-duration-display",
		});

		// Transcript panel
		if (this.options.segments.length > 0) {
			this.buildTranscriptPanel(contentEl);
		}

		// Playback controls
		const controlsSetting = new Setting(contentEl).setName("Preview");
		controlsSetting.addButton((btn) =>
			btn
				.setButtonText("Play selection")
				.setCta()
				.onClick(() => this.playSelection())
		);
		controlsSetting.addButton((btn) =>
			btn.setButtonText("Play all").onClick(() => this.playAll())
		);
		controlsSetting.addButton((btn) =>
			btn.setButtonText("Stop").onClick(() => this.stopPlayback())
		);

		// Action buttons
		const actionRow = contentEl.createDiv({ cls: "aan-trim-actions" });
		actionRow
			.createEl("button", { text: "Cancel" })
			.addEventListener("click", () => this.close());

		this.confirmButton = actionRow.createEl("button", {
			text: "Trim & Import",
			cls: "mod-cta",
		});
		this.confirmButton.addEventListener("click", () =>
			this.handleConfirm()
		);

		// Input change handlers
		this.startInput.addEventListener("change", () =>
			this.handleTimeInputChange()
		);
		this.endInput.addEventListener("change", () =>
			this.handleTimeInputChange()
		);

		// Initialize WaveSurfer
		this.initWaveSurfer(waveformContainer);
	}

	onClose() {
		if (this.wavesurfer) {
			this.wavesurfer.destroy();
			this.wavesurfer = null;
		}
		this.contentEl.empty();
	}

	// ── Transcript panel ──────────────────────────────────────────

	private buildTranscriptPanel(parent: HTMLElement) {
		const wrapper = parent.createDiv({ cls: "aan-trim-transcript" });
		wrapper.createEl("div", {
			cls: "aan-trim-transcript-header",
			text: "Transcript — click a segment to set trim point",
		});
		this.transcriptContainer = wrapper.createDiv({
			cls: "aan-trim-transcript-list",
		});

		this.segmentEls = [];
		for (const seg of this.options.segments) {
			const row = this.transcriptContainer.createDiv({
				cls: "aan-trim-seg",
			});

			const timeCol = row.createDiv({ cls: "aan-trim-seg-time" });
			timeCol.textContent = this.formatTime(seg.start);

			const textCol = row.createDiv({ cls: "aan-trim-seg-text" });
			if (seg.speakerName) {
				textCol.createEl("strong", {
					text: seg.speakerName + ": ",
					cls: "aan-trim-seg-speaker",
				});
			}
			textCol.createSpan({ text: seg.text });

			const actions = row.createDiv({ cls: "aan-trim-seg-actions" });
			const startBtn = actions.createEl("button", {
				text: "Set start",
				cls: "aan-trim-seg-btn",
			});
			const endBtn = actions.createEl("button", {
				text: "Set end",
				cls: "aan-trim-seg-btn",
			});

			startBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.setRegionStart(seg.start);
			});
			endBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.setRegionEnd(seg.end);
			});

			// Click the row itself to seek playback
			row.addEventListener("click", () => {
				if (!this.wavesurfer) return;
				const duration =
					this.wavesurfer.getDuration() || this.options.durationSec;
				if (duration > 0) {
					this.wavesurfer.seekTo(seg.start / duration);
				}
			});

			this.segmentEls.push(row);
		}
	}

	private setRegionStart(timeSec: number) {
		if (!this.region) return;
		const end = this.region.end;
		if (timeSec >= end) {
			new Notice("Start must be before the current end point.");
			return;
		}
		this.region.setOptions({ start: timeSec });
		this.syncInputsFromRegion();
		this.updateTranscriptHighlights();
	}

	private setRegionEnd(timeSec: number) {
		if (!this.region) return;
		const start = this.region.start;
		if (timeSec <= start) {
			new Notice("End must be after the current start point.");
			return;
		}
		this.region.setOptions({ end: timeSec });
		this.syncInputsFromRegion();
		this.updateTranscriptHighlights();
	}

	private updateTranscriptHighlights() {
		if (!this.region) return;
		const regionStart = this.region.start;
		const regionEnd = this.region.end;

		for (let i = 0; i < this.options.segments.length; i++) {
			const seg = this.options.segments[i];
			const el = this.segmentEls[i];
			if (!el) continue;

			const inside = seg.end > regionStart && seg.start < regionEnd;
			el.classList.toggle("is-included", inside);
			el.classList.toggle("is-excluded", !inside);
		}
	}

	// ── WaveSurfer ────────────────────────────────────────────────

	private async initWaveSurfer(container: HTMLElement) {
		const mime = this.getMimeType(this.options.audioExtension);
		const blob = new Blob([this.options.audioBuffer], { type: mime });
		const url = URL.createObjectURL(blob);

		this.regionsPlugin = RegionsPlugin.create();

		this.wavesurfer = WaveSurfer.create({
			container,
			waveColor: "var(--text-muted)",
			progressColor: "var(--interactive-accent)",
			cursorColor: "var(--text-normal)",
			height: 128,
			barWidth: 2,
			barGap: 1,
			barRadius: 2,
			normalize: true,
			plugins: [this.regionsPlugin],
		});

		this.wavesurfer.on("ready", () => {
			URL.revokeObjectURL(url);
			this.createTrimRegion();
		});

		this.wavesurfer.on("error", (err) => {
			URL.revokeObjectURL(url);
			console.error("Audio Notes: WaveSurfer error", err);
			new Notice("Failed to load audio waveform.");
		});

		await this.wavesurfer.load(url);
	}

	private createTrimRegion() {
		if (!this.regionsPlugin || !this.wavesurfer) return;

		const duration = this.wavesurfer.getDuration();
		this.region = this.regionsPlugin.addRegion({
			start: 0,
			end: duration,
			color: "rgba(var(--interactive-accent-rgb, 68, 131, 226), 0.25)",
			drag: true,
			resize: true,
		});

		this.regionsPlugin.on("region-updated", (region: Region) => {
			if (region === this.region) {
				this.syncInputsFromRegion();
				this.updateTranscriptHighlights();
			}
		});

		this.syncInputsFromRegion();
		this.updateTranscriptHighlights();
	}

	// ── Time inputs ───────────────────────────────────────────────

	private syncInputsFromRegion() {
		if (!this.region) return;
		if (this.startInput) {
			this.startInput.value = this.formatTime(this.region.start);
		}
		if (this.endInput) {
			this.endInput.value = this.formatTime(this.region.end);
		}
		this.updateDurationDisplay();
	}

	private handleTimeInputChange() {
		if (!this.startInput || !this.endInput || !this.region) return;
		const start = this.parseTime(this.startInput.value);
		const end = this.parseTime(this.endInput.value);
		if (start === null || end === null || start >= end) {
			new Notice("Invalid time range. Start must be before end.");
			this.syncInputsFromRegion();
			return;
		}
		const duration =
			this.wavesurfer?.getDuration() ?? this.options.durationSec;
		const clampedStart = Math.max(0, Math.min(start, duration));
		const clampedEnd = Math.max(clampedStart, Math.min(end, duration));
		this.region.setOptions({ start: clampedStart, end: clampedEnd });
		this.syncInputsFromRegion();
		this.updateTranscriptHighlights();
	}

	private updateDurationDisplay() {
		const display = this.contentEl.querySelector(
			".aan-trim-duration-display"
		);
		if (!display || !this.region) return;
		const dur = this.region.end - this.region.start;
		display.textContent = this.formatTime(dur);
	}

	// ── Playback ──────────────────────────────────────────────────

	private playSelection() {
		if (!this.region || !this.wavesurfer) return;
		this.region.play();
	}

	private playAll() {
		if (!this.wavesurfer) return;
		this.wavesurfer.seekTo(0);
		this.wavesurfer.play();
	}

	private stopPlayback() {
		if (!this.wavesurfer) return;
		this.wavesurfer.pause();
	}

	// ── Confirm / trim ────────────────────────────────────────────

	private async handleConfirm() {
		if (this.isProcessing || !this.region) return;
		const trimRange: TrimRange = {
			startSec: this.region.start,
			endSec: this.region.end,
		};
		const duration =
			this.wavesurfer?.getDuration() ?? this.options.durationSec;
		const isFullRange =
			Math.abs(trimRange.startSec) < 0.05 &&
			Math.abs(trimRange.endSec - duration) < 0.05;
		if (isFullRange) {
			this.options.onConfirm({
				trimRange,
				trimmedAudioBuffer: this.options.audioBuffer,
			});
			this.close();
			return;
		}
		this.isProcessing = true;
		if (this.confirmButton) {
			this.confirmButton.disabled = true;
			this.confirmButton.textContent = "Trimming\u2026";
		}
		try {
			const trimmedWav = await trimAudioToWav(
				this.options.audioBuffer.buffer.slice(
					this.options.audioBuffer.byteOffset,
					this.options.audioBuffer.byteOffset +
						this.options.audioBuffer.byteLength
				),
				trimRange
			);
			this.options.onConfirm({
				trimRange,
				trimmedAudioBuffer: Buffer.from(trimmedWav),
			});
			this.close();
		} catch (err) {
			console.error("Audio Notes: trim failed", err);
			new Notice(
				`Failed to trim audio: ${(err as Error)?.message ?? err}`
			);
			this.isProcessing = false;
			if (this.confirmButton) {
				this.confirmButton.disabled = false;
				this.confirmButton.textContent = "Trim & Import";
			}
		}
	}

	// ── Helpers ───────────────────────────────────────────────────

	private formatTime(totalSeconds: number): string {
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const seconds = totalSeconds % 60;
		const secStr = seconds.toFixed(1).padStart(4, "0");
		if (hours > 0) {
			return `${hours}:${String(minutes).padStart(2, "0")}:${secStr}`;
		}
		return `${minutes}:${secStr}`;
	}

	private parseTime(value: string): number | null {
		const parts = value.trim().split(":").map(Number);
		if (parts.some((p) => Number.isNaN(p))) return null;
		if (parts.length === 3) {
			return parts[0] * 3600 + parts[1] * 60 + parts[2];
		}
		if (parts.length === 2) {
			return parts[0] * 60 + parts[1];
		}
		if (parts.length === 1) {
			return parts[0];
		}
		return null;
	}

	private getMimeType(ext: string): string {
		switch (ext.toLowerCase()) {
			case "mp3":
				return "audio/mpeg";
			case "wav":
				return "audio/wav";
			case "ogg":
				return "audio/ogg";
			case "m4a":
			case "mp4":
				return "audio/mp4";
			case "webm":
				return "audio/webm";
			default:
				return "audio/mp4";
		}
	}
}
