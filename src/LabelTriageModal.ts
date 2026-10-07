import { Modal, Notice, TFile } from "obsidian";
import type AutomaticAudioNotes from "./main";
import {
	MeetingLabelPickerModal,
} from "./MeetingLabelPickerModal";
import {
	applyMeetingLabelToFile,
	getAttendeesFromFrontmatter,
	getMeetingLabelFromFrontmatter,
} from "./meeting-label-manager";
import { collectTags, isMeetingCache } from "./meeting-events";
import {
	buildMeetingLabelInfo,
	findLabelCategoryForTag,
	getEffectiveMeetingLabelCategories,
	normalizeTagName,
	resolveLabelColor,
	type MeetingLabelInfo,
	type NormalizedMeetingLabelCategory,
} from "./meeting-labels";
import { NOTES_PLACEHOLDER_LINE } from "./MeetingNoteTemplate";
import { confirmWithModal } from "./modals/ConfirmModal";

const AI_CONTEXT_MAX_CHARS = 4000;
/** Reads are cheap but plentiful; batch them so the UI keeps painting. */
const CONTENT_SCAN_BATCH = 10;
/** Each suggestion spawns its own CLI process, so a few can run at once. */
const AI_SUGGEST_CONCURRENCY = 3;

interface TriageItem {
	file: TFile;
	title: string;
	date: string;
	attendees: string[];
	hasContent: boolean;
	chosenTag?: string;
	source?: "ai" | "manual";
	rowEl?: HTMLElement;
	labelEl?: HTMLElement;
	chooseEl?: HTMLButtonElement;
	applyButton?: HTMLButtonElement;
}

interface LabelOption {
	tag: string;
	info: MeetingLabelInfo;
}

export class LabelTriageModal extends Modal {
	private items: TriageItem[] = [];
	private categories: NormalizedMeetingLabelCategory[] = [];
	private labelOptions: LabelOption[] = [];
	private listEl?: HTMLElement;
	private summaryEl?: HTMLElement;
	private aiStatusEl?: HTMLElement;
	private suggestButton?: HTMLButtonElement;
	private applyAllButton?: HTMLButtonElement;
	private emptyToggleEl?: HTMLElement;
	private emptyToggleTextEl?: HTMLElement;
	private showEmpty = false;
	private suggesting = false;
	private cancelSuggest = false;
	private scanning = false;
	private checkingAi = false;
	private closed = false;
	private activeTag = "";
	private individualMode = false;
	private activeHintEl?: HTMLElement;
	private filterEl?: HTMLInputElement;
	private filterQuery = "";
	private individualCheckbox?: { checked: boolean };
	private modeButtons?: { one: HTMLButtonElement; each: HTMLButtonElement };
	private chipsEl?: HTMLElement;
	/** Notes per label tag, so the quick chips lead with the busiest labels. */
	private labelUsage = new Map<string, number>();
	private applying = new Set<TriageItem>();
	private resultEl?: HTMLElement;

	constructor(private plugin: AutomaticAudioNotes) {
		super(plugin.app);
	}

	onOpen() {
		this.closed = false;
		this.categories = getEffectiveMeetingLabelCategories(
			this.plugin.settings.meetingLabelCategories
		);

		this.modalEl.addClass("aan-label-triage-modal");
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("aan-label-triage");
		contentEl.createEl("h2", { text: "Unlabeled meeting notes" });
		this.summaryEl = contentEl.createEl("p", {
			cls: "aan-label-triage-summary",
			text: "Scanning meeting notes…",
		});

		const toolbar = contentEl.createDiv({ cls: "aan-label-triage-toolbar" });

		// How labels get chosen: one label applied to many meetings, or a
		// label per meeting (where AI suggestions land).
		const modeRow = toolbar.createDiv({ cls: "aan-label-triage-mode", attr: { role: "group", "aria-label": "Labeling mode" } });
		const one = modeRow.createEl("button", { text: "One label for many", attr: { type: "button" } });
		const each = modeRow.createEl("button", { text: "Pick per meeting", attr: { type: "button" } });
		one.addEventListener("click", () => this.setIndividualMode(false));
		each.addEventListener("click", () => this.setIndividualMode(true));
		this.modeButtons = { one, each };

		const active = toolbar.createDiv({ cls: "aan-label-triage-active" });
		this.chipsEl = active.createDiv({ cls: "aan-label-triage-chips" });
		this.activeHintEl = active.createSpan({
			cls: "aan-label-triage-hint",
			text: "Pick a label, then click Apply on each meeting that belongs to it.",
		});

		const options = toolbar.createDiv({ cls: "aan-label-triage-options" });
		this.filterEl = options.createEl("input", {
			cls: "aan-label-triage-filter",
			type: "search",
			attr: {
				placeholder: "Filter by title, folder, date or attendee…",
				"aria-label": "Filter meeting notes",
			},
		});
		this.filterEl.addEventListener("input", () => {
			this.filterQuery = this.filterEl!.value.trim().toLowerCase();
			this.renderList();
		});
		this.suggestButton = options.createEl("button", {
			text: "Suggest with AI",
			cls: "aan-label-triage-suggest",
		});
		this.suggestButton.disabled = true;
		this.suggestButton.addEventListener("click", () => {
			if (this.suggesting) {
				// A run over a whole vault can take minutes; keep what it found so far.
				this.cancelSuggest = true;
				this.suggestButton!.setText("Stopping…");
				this.suggestButton!.disabled = true;
				return;
			}
			void this.suggestAll();
		});

		const controls = toolbar.createDiv({
			cls: "aan-label-triage-controls",
		});
		this.aiStatusEl = controls.createEl("span", {
			cls: "aan-label-triage-ai-status",
			attr: { role: "button", tabindex: "0", title: "Click to re-check the AI provider." },
		});
		this.aiStatusEl.addEventListener("click", () =>
			this.recheckAiStatus()
		);
		this.aiStatusEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				this.recheckAiStatus();
			}
		});
		this.emptyToggleEl = controls.createEl("label", {
			cls: "aan-label-triage-toggle",
		});
		this.emptyToggleEl.hide();
		const emptyCheckbox = this.emptyToggleEl.createEl("input", {
			type: "checkbox",
		});
		emptyCheckbox.addEventListener("change", () => {
			this.showEmpty = emptyCheckbox.checked;
			this.renderList();
		});
		this.emptyToggleTextEl = this.emptyToggleEl.createSpan();
		this.applyAllButton = controls.createEl("button", {
			text: "Apply all chosen labels",
			cls: "mod-cta",
		});
		this.applyAllButton.disabled = true;
		this.applyAllButton.addEventListener("click", () => {
			void this.applyAll();
		});
		// The provider can be enabled or logged into while this modal is open.
		window.addEventListener("focus", this.handleWindowFocus);
		void this.refreshAiStatus();
		this.renderModeButtons();

		this.resultEl = contentEl.createDiv({ cls: "aan-label-triage-result", attr: { "role": "status" } });

		this.listEl = contentEl.createDiv({ cls: "aan-label-triage-list" });
		void this.loadItems();
	}

	private setIndividualMode(value: boolean) {
		if (this.individualMode === value) return;
		this.individualMode = value;
		if (this.individualCheckbox) this.individualCheckbox.checked = value;
		this.renderModeButtons();
		this.renderList();
	}

	private renderModeButtons() {
		if (!this.modeButtons) return;
		this.modeButtons.one.toggleClass("is-active", !this.individualMode);
		this.modeButtons.each.toggleClass("is-active", this.individualMode);
		this.modeButtons.one.setAttribute("aria-pressed", String(!this.individualMode));
		this.modeButtons.each.setAttribute("aria-pressed", String(this.individualMode));
		this.contentEl.toggleClass("is-individual", this.individualMode);
		this.activeHintEl?.setText(
			this.individualMode
				? "Choose a label on each meeting, or let AI suggest them, then apply."
				: this.activeTag
					? "Click Apply on each meeting that belongs to this label."
					: "Pick a label, then click Apply on each meeting that belongs to it."
		);
	}

	private colorFor(tag: string): string {
		return resolveLabelColor(tag, this.plugin.settings.calendarTagColors);
	}

	/** The busiest labels as one-click chips, plus "More…" for the rest. */
	private renderChips() {
		const chips = this.chipsEl;
		if (!chips) return;
		chips.empty();
		const top = [...this.labelOptions]
			.sort((a, b) => (this.labelUsage.get(b.tag) ?? 0) - (this.labelUsage.get(a.tag) ?? 0))
			.slice(0, 6);
		if (this.activeTag && !top.some((option) => option.tag === this.activeTag)) {
			top.unshift({ tag: this.activeTag, info: buildMeetingLabelInfo(this.activeTag, this.categories) });
		}
		for (const option of top) {
			const chip = chips.createEl("button", {
				cls: "aan-label-triage-chip",
				attr: { type: "button", title: `${option.info.fullName} · #${option.tag}` },
			});
			chip.style.setProperty("--aan-label-color", this.colorFor(option.tag));
			chip.toggleClass("is-active", option.tag === this.activeTag);
			chip.setAttribute("aria-pressed", String(option.tag === this.activeTag));
			chip.createSpan({ cls: "aan-label-triage-dot" });
			chip.createSpan({ text: option.info.displayName });
			chip.addEventListener("click", () => this.setActiveTag(option.tag));
		}
		const more = chips.createEl("button", {
			cls: "aan-label-triage-chip is-more",
			text: top.length ? "More…" : "Choose label…",
			attr: { type: "button" },
		});
		more.addEventListener("click", () => {
			new MeetingLabelPickerModal(
				this.plugin.app,
				this.plugin,
				(selection) => this.setActiveTag(selection.tag),
				{ currentTags: this.activeTag ? [this.activeTag] : [] }
			).open();
		});
	}

	private setActiveTag(tag: string) {
		this.activeTag = tag;
		const wasIndividual = this.individualMode;
		this.individualMode = false;
		if (this.individualCheckbox) this.individualCheckbox.checked = false;
		this.renderChips();
		this.renderModeButtons();
		// Only a mode switch changes row markup; otherwise keep the scroll position.
		if (wasIndividual) this.renderList();
		else for (const item of this.items) this.updateRowLabel(item);
	}

	onClose() {
		this.closed = true;
		window.removeEventListener("focus", this.handleWindowFocus);
		this.contentEl.empty();
	}

	private handleWindowFocus = () => {
		if (!this.suggesting) void this.refreshAiStatus();
	};

	private recheckAiStatus() {
		if (this.suggesting || this.checkingAi) return;
		void this.refreshAiStatus();
	}

	private async loadItems() {
		this.items = this.collectUnlabeledMeetings();
		this.labelOptions = this.collectCandidateTags().map((tag) => ({
			tag,
			info: buildMeetingLabelInfo(tag, this.categories),
		}));
		this.renderChips();
		// Show and let the user label straight away; template-only notes drop
		// out of the list as their reads land rather than gating the render.
		this.scanning = this.items.length > 0;
		this.renderList();
		await this.scanForContent();
	}

	private async scanForContent() {
		const items = this.items.slice();
		for (let start = 0; start < items.length; start += CONTENT_SCAN_BATCH) {
			if (this.closed) return;
			const batch = items.slice(start, start + CONTENT_SCAN_BATCH);
			await Promise.all(
				batch.map(async (item) => {
					try {
						const content =
							await this.plugin.app.vault.cachedRead(item.file);
						item.hasContent = hasMeaningfulContent(content);
					} catch {
						item.hasContent = true;
					}
				})
			);
			if (this.closed) return;
			let hidden = false;
			for (const item of batch) {
				if (item.hasContent || this.showEmpty) continue;
				// Drop just this row so the scroll position and any open
				// dropdown elsewhere in the list survive the scan.
				item.rowEl?.remove();
				item.rowEl = undefined;
				hidden = true;
			}
			if (hidden) this.updateSummary();
		}
		if (this.closed) return;
		this.scanning = false;
		this.updateSummary();
	}

	private visibleItems(): TriageItem[] {
		return this.items.filter(
			(item) =>
				(this.showEmpty || item.hasContent) && this.matchesFilter(item)
		);
	}

	private matchesFilter(item: TriageItem): boolean {
		if (!this.filterQuery) return true;
		const haystack = [
			item.title,
			item.date,
			item.file.parent?.path ?? "",
			item.attendees.join(" "),
		]
			.join(" ")
			.toLowerCase();
		return this.filterQuery
			.split(/\s+/)
			.every((term) => haystack.includes(term));
	}

	private renderList() {
		if (!this.listEl) return;
		this.listEl.empty();
		const visible = this.visibleItems();
		if (!visible.length && this.items.length) {
			this.listEl.createDiv({
				cls: "aan-label-triage-empty",
				text: this.filterQuery
					? "No unlabeled meetings match this filter."
					: "Nothing left to label here.",
			});
		}
		for (const item of visible) {
			this.renderRow(item);
		}
		this.updateSummary();
		this.updateApplyAllButton();
	}

	private collectUnlabeledMeetings(): TriageItem[] {
		const items: TriageItem[] = [];
		for (const file of this.plugin.app.vault.getMarkdownFiles()) {
			const cache = this.plugin.app.metadataCache.getFileCache(file);
			if (!cache || !isMeetingCache(cache)) {
				continue;
			}
			const frontmatter = cache.frontmatter as
				| Record<string, unknown>
				| undefined;
			if (getMeetingLabelFromFrontmatter(frontmatter)) {
				continue;
			}
			const tags = collectTags(cache);
			const hasCategoryTag = tags.some((tag) =>
				findLabelCategoryForTag(tag, this.categories)
			);
			if (hasCategoryTag) {
				continue;
			}
			const date =
				typeof frontmatter?.start_date === "string"
					? frontmatter.start_date.trim()
					: "";
			items.push({
				file,
				title: file.basename,
				date,
				attendees: getAttendeesFromFrontmatter(frontmatter),
				hasContent: true,
			});
		}
		return items.sort((a, b) => b.date.localeCompare(a.date));
	}

	private collectCandidateTags(): string[] {
		const candidates = new Set<string>();
		this.labelUsage.clear();
		for (const file of this.plugin.app.vault.getMarkdownFiles()) {
			const cache = this.plugin.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			for (const tag of collectTags(cache)) {
				const normalized = normalizeTagName(tag);
				if (
					normalized &&
					findLabelCategoryForTag(normalized, this.categories)
				) {
					candidates.add(normalized);
					this.labelUsage.set(normalized, (this.labelUsage.get(normalized) ?? 0) + 1);
				}
			}
		}
		return Array.from(candidates).sort();
	}

	private renderRow(item: TriageItem) {
		if (!this.listEl) return;
		const row = this.listEl.createDiv({ cls: "aan-label-triage-row" });
		item.rowEl = row;

		const folder =
			item.file.parent && item.file.parent.path !== "/"
				? item.file.parent.path
				: "";
		const info = row.createDiv({ cls: "aan-label-triage-info" });
		const titleEl = info.createDiv({
			text: item.title,
			cls: "aan-label-triage-title",
		});
		titleEl.setAttribute(
			"title",
			folder ? `${item.title}\n${item.file.path}` : item.title
		);
		titleEl.setAttribute("tabindex", "0");
		titleEl.setAttribute("role", "link");
		titleEl.addEventListener("keydown", event => { if (event.key === "Enter") titleEl.click(); });
		titleEl.addEventListener("click", () => {
			void this.plugin.app.workspace
				.getLeaf(true)
				.openFile(item.file);
			this.close();
		});
		const metaParts = [
			item.date,
			folder,
			item.attendees.join(", "),
		].filter(Boolean);
		if (metaParts.length) {
			const metaEl = info.createDiv({
				text: metaParts.join(" • "),
				cls: "aan-label-triage-meta",
			});
			metaEl.setAttribute("title", metaParts.join(" • "));
		}

		const actions = row.createDiv({ cls: "aan-label-triage-actions" });
		item.labelEl = this.individualMode
			? actions.createSpan({ cls: "aan-label-triage-label" })
			: undefined;
		item.chooseEl = this.individualMode ? this.buildLabelChooser(item, actions) : undefined;
		item.applyButton = actions.createEl("button", {
			cls: "aan-label-triage-apply",
		});
		item.applyButton.addEventListener("click", () => {
			void this.applyItem(item);
		});

		this.updateRowLabel(item);
	}

	/** A colored button showing this meeting's chosen label; opens the picker. */
	private buildLabelChooser(item: TriageItem, container: HTMLElement): HTMLButtonElement {
		const button = container.createEl("button", {
			cls: "aan-label-triage-choose",
			attr: { type: "button" },
		});
		button.addEventListener("click", () => {
			new MeetingLabelPickerModal(
				this.plugin.app,
				this.plugin,
				(selection) => {
					item.chosenTag = selection.tag;
					item.source = "manual";
					this.updateRowLabel(item);
				},
				{ currentTags: item.chosenTag ? [item.chosenTag] : [] }
			).open();
		});
		return button;
	}

	private updateRowLabel(item: TriageItem) {
		const tag = this.individualMode ? item.chosenTag : this.activeTag;
		if (item.chooseEl) {
			const chooser = item.chooseEl;
			chooser.empty();
			chooser.toggleClass("has-label", Boolean(item.chosenTag));
			if (item.chosenTag) {
				const info = buildMeetingLabelInfo(item.chosenTag, this.categories);
				chooser.style.setProperty("--aan-label-color", this.colorFor(item.chosenTag));
				chooser.createSpan({ cls: "aan-label-triage-dot" });
				chooser.createSpan({ text: info.displayName });
				chooser.setAttribute("title", `${info.fullName} · #${item.chosenTag}`);
			} else {
				chooser.style.removeProperty("--aan-label-color");
				chooser.setText("Choose label…");
				chooser.removeAttribute("title");
			}
		}
		if (item.applyButton) {
			const button = item.applyButton;
			const applying = this.applying.has(item);
			button.disabled = !tag || applying;
			button.empty();
			if (tag) {
				button.style.setProperty("--aan-label-color", this.colorFor(tag));
				button.addClass("has-label");
				if (!this.individualMode) button.createSpan({ cls: "aan-label-triage-dot" });
			} else {
				button.style.removeProperty("--aan-label-color");
				button.removeClass("has-label");
			}
			button.createSpan({ text: applying ? "Applying…" : "Apply" });
			button.setAttribute(
				"title",
				tag
					? `Label “${item.title}” as ${buildMeetingLabelInfo(tag, this.categories).fullName}`
					: this.individualMode
						? "Choose a label for this meeting first."
						: "Pick a label at the top first."
			);
		}
		if (item.labelEl) {
			const fromAi = this.individualMode && item.source === "ai" && Boolean(item.chosenTag);
			item.labelEl.setText(fromAi ? "AI" : "");
			item.labelEl.toggleClass("has-label", fromAi);
			if (fromAi) item.labelEl.setAttribute("title", "Suggested by AI. Check it, then Apply.");
			else item.labelEl.removeAttribute("title");
		}
		this.updateApplyAllButton();
	}

	private updateApplyAllButton() {
		if (!this.applyAllButton) return;
		const count = this.items.filter((item) => item.chosenTag).length;
		this.applyAllButton.textContent = count
			? `Apply all chosen labels (${count})`
			: "Apply all chosen labels";
		this.applyAllButton.disabled = !count || this.applying.size > 0;
		this.applyAllButton.style.display = this.individualMode ? "" : "none";
	}

	private updateSummary() {
		if (!this.summaryEl) return;
		const visible = this.visibleItems();
		const total = this.items.length;
		const scanning = this.scanning ? " Checking for empty notes…" : "";
		this.summaryEl.setText(
			(!total
				? "All meeting notes have labels. Nice and tidy."
				: this.filterQuery
				? `${visible.length} of ${total} unlabeled meeting notes match the filter.`
				: visible.length
				? `${visible.length} meeting note${
						visible.length === 1 ? "" : "s"
				  } without a label.`
				: "All meeting notes with content have labels.") + scanning
		);
		if (this.emptyToggleEl && this.emptyToggleTextEl) {
			const emptyCount = this.items.filter(
				(item) => !item.hasContent
			).length;
			if (emptyCount) {
				this.emptyToggleTextEl.setText(
					`Include ${emptyCount} note${
						emptyCount === 1 ? "" : "s"
					} with no content beyond the import template`
				);
				this.emptyToggleEl.show();
			} else {
				this.emptyToggleEl.hide();
			}
		}
	}

	private async refreshAiStatus() {
		if (!this.aiStatusEl || !this.suggestButton || this.checkingAi) return;
		if (!this.plugin.meetingAiService.isConfigured()) {
			this.aiStatusEl.setText(
				"AI suggestions are disabled. Enable a local AI provider (Claude Code or Codex) in Audio Notes settings to use them."
			);
			this.suggestButton.disabled = true;
			return;
		}
		this.checkingAi = true;
		this.aiStatusEl.setText("Checking AI provider…");
		try {
			const health = await this.plugin.meetingAiService.checkHealth();
			if (this.closed) return;
			this.aiStatusEl?.setText(health.message);
			// A provider that went away has to disable the button again.
			if (this.suggestButton) {
				this.suggestButton.disabled = !health.available;
			}
		} catch (error) {
			if (this.closed) return;
			this.aiStatusEl?.setText(
				`Could not check AI provider: ${(error as Error)?.message ?? error}`
			);
			if (this.suggestButton) this.suggestButton.disabled = true;
		} finally {
			this.checkingAi = false;
		}
	}

	private async suggestAll() {
		if (this.suggesting || !this.suggestButton) return;
		const pending = this.visibleItems().filter((item) => !item.chosenTag);
		if (!pending.length) {
			new Notice("Every listed note already has a label chosen.");
			return;
		}
		const candidateTags = this.collectCandidateTags();
		if (!candidateTags.length) {
			new Notice(
				"No existing meeting labels found to suggest from. Pick labels manually first so the AI has options to choose between.",
				8000
			);
			return;
		}
		this.individualMode = true;
		if (this.individualCheckbox) this.individualCheckbox.checked = true;
		this.renderModeButtons();
		this.renderList();
		this.suggesting = true;
		this.cancelSuggest = false;
		const total = pending.length;
		let next = 0;
		let done = 0;
		let suggested = 0;
		let failed = 0;
		const showProgress = () => {
			// Leave the "Stopping…" text alone once the user has asked to stop.
			if (this.suggestButton && !this.cancelSuggest) {
				this.suggestButton.textContent = `Stop (${done}/${total})`;
			}
		};
		// Each call spawns its own provider process, so run a few at a time;
		// `next++` is safe to share because nothing awaits between the two steps.
		const worker = async () => {
			while (!this.closed && !this.cancelSuggest) {
				const item = pending[next++];
				if (!item) return;
				try {
					const context = await this.buildAiContext(item.file);
					const tag =
						await this.plugin.meetingAiService.suggestMeetingLabel({
							title: item.title,
							context,
							candidateTags,
						});
					if (tag && !this.closed && this.items.includes(item) && !item.chosenTag && !this.applying.has(item)) {
						item.chosenTag = tag;
						item.source = "ai";
						this.updateRowLabel(item);
						suggested += 1;
					}
				} catch (error) {
					failed += 1;
					console.error(
						"Audio Notes: AI label suggestion failed",
						item.file.path,
						error
					);
				}
				done += 1;
				showProgress();
			}
		};
		showProgress();
		try {
			await Promise.all(
				Array.from(
					{ length: Math.min(AI_SUGGEST_CONCURRENCY, total) },
					worker
				)
			);
			if (this.closed) return;
			const stopped = this.cancelSuggest;
			new Notice(
				`AI suggested labels for ${suggested} of ${
					stopped ? done : total
				} notes${stopped ? " before you stopped it" : ""}.${
					failed ? ` ${failed} failed (see console).` : ""
				}`,
				6000
			);
		} finally {
			this.suggesting = false;
			this.cancelSuggest = false;
			if (this.suggestButton) {
				this.suggestButton.textContent = "Suggest with AI";
				this.suggestButton.disabled = false;
			}
		}
	}

	private async buildAiContext(file: TFile): Promise<string> {
		const content = await this.plugin.app.vault.cachedRead(file);
		const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
		return body.slice(0, AI_CONTEXT_MAX_CHARS);
	}

	private removeItem(item: TriageItem) {
		this.items = this.items.filter((entry) => entry !== item);
		item.rowEl?.remove();
	}

	private async applyItem(item: TriageItem, tag = this.individualMode ? item.chosenTag : this.activeTag): Promise<boolean> {
		if (!tag || this.applying.has(item) || !this.items.includes(item)) return false;
		// Capture the label before awaiting: changing the active label affects only later clicks.
		this.applying.add(item);
		this.updateRowLabel(item);
		const visible = this.visibleItems(), index = visible.indexOf(item);
		const next = visible[index + 1] ?? visible[index - 1];
		try {
			await applyMeetingLabelToFile(this.plugin.app, item.file, tag);
			this.removeItem(item);
			if (!this.closed) {
				this.resultEl?.setText(`Labeled “${item.title}” · ${buildMeetingLabelInfo(tag, this.categories).displayName}`);
				this.updateSummary();
				// Keep keyboard users on the next row without stealing focus from a new selection.
				if (this.contentEl.ownerDocument.activeElement === this.contentEl.ownerDocument.body) next?.applyButton?.focus();
			}
			return true;
		} catch (error) {
			console.error("Audio Notes: could not apply meeting label", item.file.path, error);
			new Notice(`Could not label ${item.title}. Please try again.`, 6000);
			return false;
		} finally {
			this.applying.delete(item);
			if (!this.closed) { this.updateRowLabel(item); this.updateApplyAllButton(); }
		}
	}

	private async applyAll() {
		const ready = this.items.filter((item) => item.chosenTag);
		if (!ready.length) {
			new Notice(
				"No labels chosen yet. Use the dropdowns or AI suggestions first."
			);
			return;
		}
		const plural = ready.length === 1 ? "" : "s";
		const aiCount = ready.filter((item) => item.source === "ai").length;
		const confirmed = await confirmWithModal(this.plugin.app, {
			title: "Apply chosen labels?",
			message: `This writes a label into the frontmatter of ${
				ready.length
			} meeting note${plural}${
				aiCount
					? `, ${aiCount} of them suggested by the AI`
					: ""
			}. There is no undo from this modal.`,
			confirmText: `Apply ${ready.length} label${plural}`,
		});
		if (!confirmed || this.closed) return;
		let applied = 0;
		for (const item of ready) {
			if (this.closed) break;
			if (await this.applyItem(item, item.chosenTag)) applied += 1;
		}
		if (this.closed) return;
		this.updateSummary();
		this.updateApplyAllButton();
		const failedCount = ready.length - applied;
		new Notice(
			`Applied labels to ${applied} meeting note${
				applied === 1 ? "" : "s"
			}.${failedCount ? ` ${failedCount} could not be saved.` : ""}`
		);
	}
}

function hasMeaningfulContent(content: string): boolean {
	let body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
	body = body.replace(/```audio-note[\s\S]*?(```|$)/g, "");
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith(">")) continue;
		if (trimmed.startsWith("#")) continue;
		if (trimmed.startsWith("<!--")) continue;
		if (trimmed === NOTES_PLACEHOLDER_LINE) continue;
		if (trimmed === "_No meeting notes generated._") continue;
		if (/^[-*+]$/.test(trimmed)) continue;
		return true;
	}
	return false;
}
