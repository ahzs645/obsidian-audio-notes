import { Modal, Notice, Setting, TFile, setIcon } from "obsidian";
import type AutomaticAudioNotes from "../main";
import {
	formatClock,
	splitPointBefore,
	splitSchedule,
	splitSegments,
	suggestSplitPoints,
	type SplitSegment,
} from "../MeetingSplit";
import { meetingStart } from "../MeetingMetadataRepair";
import { MeetingSplitService } from "../services/MeetingSplitService";
import { formatLength } from "../schedule-math";

interface SplitMeetingModalOptions {
	file: TFile;
	audioPath: string | null;
	transcriptPath: string | null;
	onDone?: (secondNotePath: string) => void;
}

const NUDGE_SEC = 5;

/**
 * Splits a recording that ran through two meetings. With audio, the split
 * point can be scrubbed and listened to; with only a transcript, it is
 * picked from the lines. Either way the timeline shows where people talked,
 * so the quiet gap between meetings stands out.
 */
export class SplitMeetingModal extends Modal {
	private readonly service: MeetingSplitService;
	private segments: SplitSegment[] = [];
	private totalSec = 0;
	private splitSec = 0;
	private start: Date;
	private end: Date | null;
	private firstTitle: string;
	private secondTitle: string;
	private copyLabelAndAttendees = true;
	private trashOriginals = true;
	private busy = false;

	private audio: HTMLAudioElement | null = null;
	private audioFile: TFile | null = null;
	private timelineEl!: HTMLElement;
	private canvasEl!: HTMLCanvasElement;
	private handleEl!: HTMLElement;
	private handleLabelEl!: HTMLElement;
	private playheadEl!: HTMLElement;
	private firstShadeEl!: HTMLElement;
	private clockEl: HTMLElement | null = null;
	private playButton: HTMLButtonElement | null = null;
	private partEls: { range: HTMLElement; meta: HTMLElement }[] = [];
	private listEl: HTMLElement | null = null;
	private rowEls: HTMLElement[] = [];
	private dividerEl: HTMLElement | null = null;
	private errorEl!: HTMLElement;
	private submitButton!: HTMLButtonElement;
	private renderFrame: number | null = null;
	private resizeObserver: ResizeObserver | null = null;

	constructor(private readonly plugin: AutomaticAudioNotes, private readonly options: SplitMeetingModalOptions) {
		super(plugin.app);
		this.service = new MeetingSplitService(plugin);
		const fm = (plugin.app.metadataCache.getFileCache(options.file)?.frontmatter ?? {}) as Record<string, unknown>;
		this.start = meetingStart(fm) ?? new Date(options.file.stat.ctime);
		const end = typeof fm.end === "string" ? new Date(fm.end) : null;
		this.end = end && !Number.isNaN(end.getTime()) ? end : null;
		this.firstTitle = options.file.basename;
		this.secondTitle = `${options.file.basename} (part 2)`;
		const audio = options.audioPath ? plugin.app.vault.getAbstractFileByPath(options.audioPath) : null;
		this.audioFile = audio instanceof TFile ? audio : null;
	}

	async onOpen(): Promise<void> {
		const { contentEl, modalEl } = this;
		modalEl.addClass("aan-split-modal");
		contentEl.empty();
		contentEl.createEl("h2", { text: "Split meeting" });
		const intro = contentEl.createEl("p", { cls: "aan-split-intro" });
		intro.setText(
			this.audioFile
				? "Drag the marker to where the second meeting starts. Dragging scrubs the recording so you can listen for the handover."
				: "Pick the line where the second meeting starts. There's no recording in the vault for this note, so only the transcript is split."
		);

		const loading = contentEl.createDiv({ cls: "aan-split-loading", text: "Loading transcript…" });
		try {
			const transcript = this.options.transcriptPath
				? await this.service.readTranscript(this.options.transcriptPath)
				: null;
			this.segments = (transcript?.segments ?? [])
				.filter((segment) => Number.isFinite(Number(segment.start)))
				.map((segment) => ({ ...segment, start: Number(segment.start), end: Number(segment.end) || Number(segment.start) }))
				.sort((a, b) => a.start - b.start);
		} catch (error) {
			console.error("Audio Notes: could not read transcript for split", error);
		}
		loading.remove();

		const transcriptEnd = this.segments.reduce((max, s) => Math.max(max, s.end), 0);
		const scheduled = this.end ? (this.end.getTime() - this.start.getTime()) / 1000 : 0;
		this.totalSec = Math.max(transcriptEnd, scheduled > 0 && !this.segments.length ? scheduled : 0);

		if (!this.audioFile && !this.segments.length) {
			contentEl.createEl("p", {
				cls: "aan-split-error",
				text: "This meeting has neither a recording in the vault nor a transcript, so there's nothing to split.",
			});
			return;
		}

		if (this.audioFile) this.buildAudioControls(contentEl);
		this.buildTimeline(contentEl);
		this.buildSuggestions(contentEl);
		this.buildParts(contentEl);
		if (this.segments.length) this.buildTranscript(contentEl);
		this.buildOptions(contentEl);

		this.errorEl = contentEl.createDiv({ cls: "aan-split-error" });
		const footer = contentEl.createDiv({ cls: "modal-button-container" });
		footer.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		this.submitButton = footer.createEl("button", { text: "Split meeting", cls: "mod-cta" });
		this.submitButton.addEventListener("click", () => void this.submit());

		const suggestion = suggestSplitPoints(this.segments)[0];
		this.setSplit(suggestion ? suggestion.atSec : this.totalSec / 2, false);
	}

	onClose(): void {
		this.audio?.pause();
		this.audio?.removeAttribute("src");
		this.audio = null;
		this.resizeObserver?.disconnect();
		if (this.renderFrame) cancelAnimationFrame(this.renderFrame);
		this.contentEl.empty();
	}

	// ── Audio ───────────────────────────────────────────────────────

	private buildAudioControls(parent: HTMLElement) {
		const audio = new Audio(this.app.vault.getResourcePath(this.audioFile!));
		audio.preload = "metadata";
		this.audio = audio;
		audio.addEventListener("loadedmetadata", () => {
			if (Number.isFinite(audio.duration) && audio.duration > 0) {
				this.totalSec = Math.max(this.totalSec, audio.duration);
				if (!this.splitSec) this.splitSec = this.totalSec / 2;
				this.scheduleRender();
			}
		});
		audio.addEventListener("timeupdate", () => this.scheduleRender());
		audio.addEventListener("play", () => this.updatePlayButton());
		audio.addEventListener("pause", () => this.updatePlayButton());

		const row = parent.createDiv({ cls: "aan-split-controls" });
		this.playButton = this.iconButton(row, "play", "Play / pause", () => {
			if (audio.paused) void audio.play();
			else audio.pause();
		});
		this.iconButton(row, "rewind", `Back ${NUDGE_SEC}s`, () => this.seek(audio.currentTime - NUDGE_SEC));
		this.iconButton(row, "fast-forward", `Forward ${NUDGE_SEC}s`, () => this.seek(audio.currentTime + NUDGE_SEC));
		this.clockEl = row.createSpan({ cls: "aan-split-clock" });
		const actions = row.createDiv({ cls: "aan-split-controls-actions" });
		actions
			.createEl("button", { text: "Split at playhead" })
			.addEventListener("click", () => this.setSplit(audio.currentTime, false));
		actions
			.createEl("button", { text: "Hear the split" })
			.addEventListener("click", () => {
				// A few seconds of each side of the cut.
				this.seek(this.splitSec - 4);
				void audio.play();
			});
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
		const button = parent.createEl("button", {
			cls: "clickable-icon aan-split-icon-btn",
			attr: { type: "button", "aria-label": label },
		});
		setIcon(button, icon);
		button.addEventListener("click", onClick);
		return button;
	}

	private updatePlayButton() {
		if (!this.playButton || !this.audio) return;
		setIcon(this.playButton, this.audio.paused ? "play" : "pause");
	}

	private seek(sec: number) {
		if (!this.audio) return;
		this.audio.currentTime = Math.max(0, Math.min(sec, this.totalSec || sec));
		this.scheduleRender();
	}

	// ── Timeline ────────────────────────────────────────────────────

	private buildTimeline(parent: HTMLElement) {
		this.timelineEl = parent.createDiv({ cls: "aan-split-timeline" });
		this.firstShadeEl = this.timelineEl.createDiv({ cls: "aan-split-shade" });
		this.canvasEl = this.timelineEl.createEl("canvas", { cls: "aan-split-canvas" });
		this.playheadEl = this.timelineEl.createDiv({ cls: "aan-split-playhead" });
		this.handleEl = this.timelineEl.createDiv({
			cls: "aan-split-handle",
			attr: { role: "slider", tabindex: "0", "aria-label": "Split point" },
		});
		this.handleLabelEl = this.handleEl.createDiv({ cls: "aan-split-handle-label" });
		const axis = parent.createDiv({ cls: "aan-split-axis" });
		axis.createSpan({ text: "0:00" });
		axis.createSpan({ cls: "aan-split-axis-end" });

		const timeAt = (event: PointerEvent) => {
			const rect = this.timelineEl.getBoundingClientRect();
			return ((event.clientX - rect.left) / rect.width) * this.totalSec;
		};
		let dragging = false;
		this.timelineEl.addEventListener("pointerdown", (event) => {
			dragging = true;
			this.timelineEl.setPointerCapture(event.pointerId);
			this.setSplit(timeAt(event), true);
		});
		this.timelineEl.addEventListener("pointermove", (event) => {
			if (dragging) this.setSplit(timeAt(event), true);
		});
		const stop = () => {
			dragging = false;
		};
		this.timelineEl.addEventListener("pointerup", stop);
		this.timelineEl.addEventListener("pointercancel", stop);
		this.handleEl.addEventListener("keydown", (event) => {
			const step = event.shiftKey ? 30 : 1;
			if (event.key === "ArrowLeft") this.setSplit(this.splitSec - step, true);
			else if (event.key === "ArrowRight") this.setSplit(this.splitSec + step, true);
			else return;
			event.preventDefault();
		});

		this.resizeObserver = new ResizeObserver(() => this.drawSpeech());
		this.resizeObserver.observe(this.timelineEl);
	}

	/** Bars where someone is talking; gaps are the quiet stretches. */
	private drawSpeech() {
		const canvas = this.canvasEl;
		const width = this.timelineEl.clientWidth;
		const height = this.timelineEl.clientHeight;
		if (!width || !height || !this.totalSec) return;
		const ratio = window.devicePixelRatio || 1;
		canvas.width = Math.round(width * ratio);
		canvas.height = Math.round(height * ratio);
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.scale(ratio, ratio);
		ctx.clearRect(0, 0, width, height);
		const color = getComputedStyle(this.timelineEl).getPropertyValue("--text-muted").trim() || "#888";
		ctx.fillStyle = color;
		ctx.globalAlpha = 0.55;
		const top = height * 0.3;
		const barHeight = height * 0.4;
		for (const segment of this.segments) {
			const x = (segment.start / this.totalSec) * width;
			const w = Math.max(1, ((segment.end - segment.start) / this.totalSec) * width);
			ctx.fillRect(x, top, w, barHeight);
		}
	}

	private setSplit(sec: number, scrub: boolean) {
		const max = this.totalSec || sec;
		this.splitSec = Math.max(0, Math.min(sec, max));
		if (scrub && this.audio) {
			this.audio.currentTime = this.splitSec;
		}
		this.scheduleRender();
	}

	private scheduleRender() {
		if (this.renderFrame) return;
		this.renderFrame = requestAnimationFrame(() => {
			this.renderFrame = null;
			this.render();
		});
	}

	private render() {
		const total = this.totalSec || 1;
		const pct = (sec: number) => `${Math.max(0, Math.min(100, (sec / total) * 100))}%`;
		this.handleEl.style.left = pct(this.splitSec);
		this.firstShadeEl.style.width = pct(this.splitSec);
		this.handleLabelEl.setText(formatClock(this.splitSec));
		this.handleEl.setAttribute("aria-valuenow", String(Math.round(this.splitSec)));
		this.handleEl.setAttribute("aria-valuetext", formatClock(this.splitSec));
		this.contentEl.querySelector(".aan-split-axis-end")?.setText(formatClock(this.totalSec));
		if (this.audio) {
			this.playheadEl.style.left = pct(this.audio.currentTime);
			this.playheadEl.toggleClass("is-hidden", this.audio.currentTime <= 0 && this.audio.paused);
			this.clockEl?.setText(`${formatClock(this.audio.currentTime)} / ${formatClock(this.totalSec)}`);
		} else {
			this.playheadEl.addClass("is-hidden");
		}
		this.drawSpeechOnce();
		this.renderParts();
		this.renderTranscriptDivider();
		this.validate();
	}

	private drawnTotal = 0;
	/** Redraws only when the scale changes (the audio's length arriving). */
	private drawSpeechOnce() {
		if (!this.totalSec || this.drawnTotal === this.totalSec) return;
		this.drawnTotal = this.totalSec;
		this.drawSpeech();
	}

	// ── Suggestions ─────────────────────────────────────────────────

	private buildSuggestions(parent: HTMLElement) {
		const suggestions = suggestSplitPoints(this.segments);
		if (!suggestions.length) return;
		const row = parent.createDiv({ cls: "aan-split-suggestions" });
		row.createSpan({ text: "Long pauses:", cls: "aan-split-suggestions-label" });
		for (const suggestion of suggestions) {
			const chip = row.createEl("button", {
				cls: "aan-split-chip",
				text: `${formatClock(suggestion.atSec)} · ${formatLength(suggestion.gapSec * 1000) || `${Math.round(suggestion.gapSec)}s`} quiet`,
			});
			chip.addEventListener("click", () => this.setSplit(suggestion.atSec, true));
		}
	}

	// ── Parts summary ───────────────────────────────────────────────

	private buildParts(parent: HTMLElement) {
		const grid = parent.createDiv({ cls: "aan-split-parts" });
		const part = (n: 1 | 2) => {
			const card = grid.createDiv({ cls: `aan-split-part aan-split-part--${n}` });
			card.createDiv({ cls: "aan-split-part-heading", text: n === 1 ? "This note" : "New note" });
			const input = card.createEl("input", {
				type: "text",
				cls: "aan-split-title",
				attr: { "aria-label": n === 1 ? "Title of the first meeting" : "Title of the second meeting" },
			});
			input.value = n === 1 ? this.firstTitle : this.secondTitle;
			input.addEventListener("input", () => {
				if (n === 1) this.firstTitle = input.value;
				else this.secondTitle = input.value;
				this.validate();
			});
			const range = card.createDiv({ cls: "aan-split-part-range" });
			const meta = card.createDiv({ cls: "aan-split-part-meta" });
			this.partEls.push({ range, meta });
		};
		part(1);
		part(2);
	}

	private renderParts() {
		if (this.partEls.length < 2) return;
		const fallbackEnd = new Date(this.start.getTime() + this.totalSec * 1000);
		const schedule = splitSchedule(this.start, this.end ?? fallbackEnd, this.splitSec, this.totalSec);
		const time = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
		const { first, second } = this.segments.length
			? splitSegments(this.segments, this.splitSec)
			: { first: [], second: [] };
		const describe = (part: { start: Date; end: Date }, lines: number) => {
			const length = formatLength(part.end.getTime() - part.start.getTime()) || "0m";
			return this.segments.length ? `${length} · ${lines} line${lines === 1 ? "" : "s"}` : length;
		};
		this.partEls[0].range.setText(`${time(schedule.first.start)} – ${time(schedule.first.end)}`);
		this.partEls[0].meta.setText(describe(schedule.first, first.length));
		this.partEls[1].range.setText(`${time(schedule.second.start)} – ${time(schedule.second.end)}`);
		this.partEls[1].meta.setText(describe(schedule.second, second.length));
	}

	// ── Transcript ──────────────────────────────────────────────────

	private buildTranscript(parent: HTMLElement) {
		this.listEl = parent.createDiv({ cls: "aan-split-transcript" });
		this.dividerEl = createDiv({ cls: "aan-split-divider" });
		this.dividerEl.createSpan({ text: "New meeting starts here" });
		this.segments.forEach((segment, index) => {
			const row = this.listEl!.createDiv({ cls: "aan-split-line" });
			const time = row.createEl("button", {
				cls: "aan-split-line-time",
				text: formatClock(segment.start),
				attr: { type: "button", "aria-label": this.audio ? `Play from ${formatClock(segment.start)}` : formatClock(segment.start) },
			});
			if (this.audio) {
				time.addEventListener("click", () => {
					this.seek(segment.start);
					void this.audio?.play();
				});
			}
			const speaker = typeof segment.speakerName === "string" ? segment.speakerName : typeof segment.speaker === "string" ? segment.speaker : "";
			const text = row.createDiv({ cls: "aan-split-line-text" });
			if (speaker) text.createEl("strong", { text: `${speaker}: ` });
			text.appendText(String(segment.text ?? "").trim());
			const action = row.createEl("button", {
				cls: "aan-split-line-action",
				text: "Split here",
				attr: { type: "button", "aria-label": `Start the new meeting at ${formatClock(segment.start)}` },
			});
			action.addEventListener("click", () => this.setSplit(splitPointBefore(this.segments, index), true));
			this.rowEls.push(row);
		});
	}

	private lastDividerIndex = -1;
	private renderTranscriptDivider() {
		if (!this.listEl || !this.dividerEl) return;
		let index = this.segments.findIndex((segment) => (segment.start + segment.end) / 2 >= this.splitSec);
		if (index === -1) index = this.segments.length;
		if (index === this.lastDividerIndex) return;
		this.lastDividerIndex = index;
		this.rowEls.forEach((row, i) => row.toggleClass("is-second", i >= index));
		const before = this.rowEls[index];
		if (before) this.listEl.insertBefore(this.dividerEl, before);
		else this.listEl.appendChild(this.dividerEl);
		// Keep the handover in view while scrubbing.
		const list = this.listEl;
		const top = this.dividerEl.offsetTop - list.clientHeight / 2;
		list.scrollTo({ top: Math.max(0, top) });
	}

	// ── Options & submit ────────────────────────────────────────────

	private buildOptions(parent: HTMLElement) {
		new Setting(parent)
			.setName("Copy label and attendees to the new note")
			.addToggle((toggle) =>
				toggle.setValue(this.copyLabelAndAttendees).onChange((value) => {
					this.copyLabelAndAttendees = value;
				})
			);
		if (this.audioFile || this.options.transcriptPath) {
			new Setting(parent)
				.setName("Move the original recording and transcript to the trash")
				.setDesc("They're replaced by one file per part. Files another note still links to are kept.")
				.addToggle((toggle) =>
					toggle.setValue(this.trashOriginals).onChange((value) => {
						this.trashOriginals = value;
					})
				);
		}
	}

	private validate(): boolean {
		let error = "";
		if (this.splitSec < 1 || this.splitSec > this.totalSec - 1) {
			error = "Move the marker away from the very start or end.";
		} else if (!this.firstTitle.trim() || !this.secondTitle.trim()) {
			error = "Give both meetings a title.";
		} else if (this.segments.length) {
			const { first, second } = splitSegments(this.segments, this.splitSec);
			if (!first.length || !second.length) error = "Each meeting needs at least one transcript line.";
		}
		if (!this.busy) this.errorEl?.setText(error);
		if (this.submitButton) this.submitButton.disabled = this.busy || Boolean(error);
		return !error;
	}

	private async submit(keepAudioWhole = false) {
		if (this.busy || !this.validate()) return;
		this.busy = true;
		this.audio?.pause();
		this.submitButton.disabled = true;
		this.errorEl.empty();
		try {
			const outcome = await this.service.split(
				{
					file: this.options.file,
					audioPath: this.options.audioPath,
					transcriptPath: this.options.transcriptPath,
					splitSec: this.splitSec,
					firstTitle: this.firstTitle.trim(),
					secondTitle: this.secondTitle.trim(),
					copyLabelAndAttendees: this.copyLabelAndAttendees,
					trashOriginals: this.trashOriginals,
					keepAudioWhole,
				},
				(message) => this.submitButton.setText(message)
			);
			const notes = [
				`Split into “${outcome.firstNote.basename}” and “${outcome.secondNotePath.split("/").pop()?.replace(/\.md$/, "")}”.`,
			];
			if (outcome.reencoded) notes.push("The recording was converted to WAV to cut it.");
			if (!outcome.audioCut && this.audioFile) notes.push("The full recording stays with the first note.");
			notes.push("AI notes in this note still cover both meetings; regenerate them for each part.");
			new Notice(notes.join("\n"), 10000);
			this.close();
			this.options.onDone?.(outcome.secondNotePath);
		} catch (error) {
			console.error("Audio Notes: split failed", error);
			this.busy = false;
			this.submitButton.setText("Split meeting");
			this.validate();
			const message = error instanceof Error ? error.message : String(error);
			this.errorEl.setText(`Couldn't split: ${message}`);
			if (this.audioFile && !keepAudioWhole) {
				const retry = this.errorEl.createEl("button", {
					text: "Split the transcript only",
					cls: "aan-split-retry",
				});
				retry.addEventListener("click", () => void this.submit(true));
			}
		}
	}
}
