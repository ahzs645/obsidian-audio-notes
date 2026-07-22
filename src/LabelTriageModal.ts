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
	type MeetingLabelInfo,
	type NormalizedMeetingLabelCategory,
} from "./meeting-labels";
import { NOTES_PLACEHOLDER_LINE } from "./MeetingNoteTemplate";

const AI_CONTEXT_MAX_CHARS = 4000;
const CREATE_LABEL_OPTION = "__create-new-label__";

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
	selectEl?: HTMLSelectElement;
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
	private closed = false;

	constructor(private plugin: AutomaticAudioNotes) {
		super(plugin.app);
	}

	onOpen() {
		this.closed = false;
		this.categories = getEffectiveMeetingLabelCategories(
			this.plugin.settings.meetingLabelCategories
		);

		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("aan-label-triage");
		contentEl.createEl("h2", { text: "Unlabeled meeting notes" });
		this.summaryEl = contentEl.createEl("p", {
			cls: "aan-label-triage-summary",
			text: "Scanning meeting notes…",
		});

		const controls = contentEl.createDiv({
			cls: "aan-label-triage-controls",
		});
		this.suggestButton = controls.createEl("button", {
			text: "Suggest labels with AI",
		});
		this.suggestButton.disabled = true;
		this.suggestButton.addEventListener("click", () => {
			void this.suggestAll();
		});
		this.applyAllButton = controls.createEl("button", {
			text: "Apply all chosen labels",
			cls: "mod-cta",
		});
		this.applyAllButton.disabled = true;
		this.applyAllButton.addEventListener("click", () => {
			void this.applyAll();
		});

		this.emptyToggleEl = contentEl.createEl("label", {
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

		this.aiStatusEl = contentEl.createEl("p", {
			cls: "aan-label-triage-ai-status",
		});
		void this.refreshAiStatus();

		this.listEl = contentEl.createDiv({ cls: "aan-label-triage-list" });
		void this.loadItems();
	}

	onClose() {
		this.closed = true;
		this.contentEl.empty();
	}

	private async loadItems() {
		const items = this.collectUnlabeledMeetings();
		for (const item of items) {
			if (this.closed) return;
			try {
				const content = await this.plugin.app.vault.cachedRead(
					item.file
				);
				item.hasContent = hasMeaningfulContent(content);
			} catch {
				item.hasContent = true;
			}
		}
		if (this.closed) return;
		this.items = items;
		this.labelOptions = this.collectCandidateTags().map((tag) => ({
			tag,
			info: buildMeetingLabelInfo(tag, this.categories),
		}));
		this.renderList();
	}

	private visibleItems(): TriageItem[] {
		return this.items.filter((item) => this.showEmpty || item.hasContent);
	}

	private renderList() {
		if (!this.listEl) return;
		this.listEl.empty();
		for (const item of this.visibleItems()) {
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
		item.labelEl = actions.createDiv({
			cls: "aan-label-triage-label",
		});
		item.selectEl = this.buildLabelSelect(item, actions);
		item.applyButton = actions.createEl("button", {
			text: "Apply",
			cls: "mod-cta",
		});
		item.applyButton.addEventListener("click", () => {
			void this.applyItem(item);
		});

		this.updateRowLabel(item);
	}

	private buildLabelSelect(
		item: TriageItem,
		container: HTMLElement
	): HTMLSelectElement {
		const select = container.createEl("select", {
			cls: "dropdown aan-label-triage-select",
		});
		select.createEl("option", { text: "Choose label…", value: "" });

		const grouped = new Map<string, LabelOption[]>();
		for (const option of this.labelOptions) {
			const groupName = option.info.categoryName ?? "Other";
			const group = grouped.get(groupName) ?? [];
			group.push(option);
			grouped.set(groupName, group);
		}
		for (const [groupName, options] of grouped) {
			const groupEl = select.createEl("optgroup");
			groupEl.label = groupName;
			for (const option of options) {
				groupEl.createEl("option", {
					text: formatLabelOptionText(option.info),
					value: option.tag,
				});
			}
		}
		select.createEl("option", {
			text: "＋ New label…",
			value: CREATE_LABEL_OPTION,
		});

		select.addEventListener("change", () => {
			const value = select.value;
			if (value === CREATE_LABEL_OPTION) {
				select.value = item.chosenTag ?? "";
				const picker = new MeetingLabelPickerModal(
					this.plugin.app,
					this.plugin,
					(selection) => {
						item.chosenTag = selection.tag;
						item.source = "manual";
						this.updateRowLabel(item);
					}
				);
				picker.open();
				return;
			}
			item.chosenTag = value || undefined;
			item.source = value ? "manual" : undefined;
			this.updateRowLabel(item);
		});
		return select;
	}

	private ensureSelectOption(select: HTMLSelectElement, tag: string) {
		if (
			Array.from(select.options).some((option) => option.value === tag)
		) {
			return;
		}
		const info = buildMeetingLabelInfo(tag, this.categories);
		const option = document.createElement("option");
		option.value = tag;
		option.text = formatLabelOptionText(info);
		const createOption = Array.from(select.options).find(
			(entry) => entry.value === CREATE_LABEL_OPTION
		);
		select.insertBefore(option, createOption ?? null);
		if (!this.labelOptions.some((entry) => entry.tag === tag)) {
			this.labelOptions.push({ tag, info });
			this.labelOptions.sort((a, b) => a.tag.localeCompare(b.tag));
		}
	}

	private updateRowLabel(item: TriageItem) {
		if (item.selectEl) {
			if (item.chosenTag) {
				this.ensureSelectOption(item.selectEl, item.chosenTag);
			}
			item.selectEl.value = item.chosenTag ?? "";
			item.selectEl.setAttribute(
				"title",
				item.chosenTag ? `#${item.chosenTag}` : "Choose a label"
			);
		}
		if (item.applyButton) {
			item.applyButton.disabled = !item.chosenTag;
		}
		if (item.labelEl) {
			if (item.source === "ai" && item.chosenTag) {
				item.labelEl.setText("AI suggestion");
				item.labelEl.addClass("has-label");
			} else {
				item.labelEl.setText("");
				item.labelEl.removeClass("has-label");
			}
		}
		this.updateApplyAllButton();
	}

	private updateApplyAllButton() {
		if (!this.applyAllButton) return;
		const count = this.items.filter((item) => item.chosenTag).length;
		this.applyAllButton.textContent = count
			? `Apply all chosen labels (${count})`
			: "Apply all chosen labels";
		this.applyAllButton.disabled = !count;
	}

	private updateSummary() {
		if (!this.summaryEl) return;
		const visible = this.visibleItems();
		this.summaryEl.setText(
			visible.length
				? `${visible.length} meeting note${
						visible.length === 1 ? "" : "s"
				  } without a label.`
				: this.items.length
				? "All meeting notes with content have labels."
				: "All meeting notes have labels. Nice and tidy."
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
		if (!this.aiStatusEl || !this.suggestButton) return;
		if (!this.plugin.meetingAiService.isConfigured()) {
			this.aiStatusEl.setText(
				"AI suggestions are disabled. Enable a local AI provider (Claude Code or Codex) in Audio Notes settings to use them."
			);
			return;
		}
		this.aiStatusEl.setText("Checking AI provider…");
		try {
			const health = await this.plugin.meetingAiService.checkHealth();
			this.aiStatusEl?.setText(health.message);
			if (health.available && this.suggestButton) {
				this.suggestButton.disabled = false;
			}
		} catch (error) {
			this.aiStatusEl?.setText(
				`Could not check AI provider: ${(error as Error)?.message ?? error}`
			);
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
		this.suggesting = true;
		this.suggestButton.disabled = true;
		let done = 0;
		let suggested = 0;
		let failed = 0;
		try {
			for (const item of pending) {
				if (this.closed) return;
				this.suggestButton.textContent = `Suggesting ${done + 1}/${pending.length}…`;
				try {
					const context = await this.buildAiContext(item.file);
					const tag =
						await this.plugin.meetingAiService.suggestMeetingLabel({
							title: item.title,
							context,
							candidateTags,
						});
					if (tag && !this.closed) {
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
			}
			new Notice(
				`AI suggested labels for ${suggested} of ${pending.length} notes.${
					failed ? ` ${failed} failed (see console).` : ""
				}`,
				6000
			);
		} finally {
			this.suggesting = false;
			if (this.suggestButton) {
				this.suggestButton.textContent = "Suggest labels with AI";
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

	private async applyItem(item: TriageItem) {
		if (!item.chosenTag) {
			new Notice("Choose a label for this note first.");
			return;
		}
		try {
			await applyMeetingLabelToFile(
				this.plugin.app,
				item.file,
				item.chosenTag
			);
			this.removeItem(item);
			this.updateSummary();
			this.updateApplyAllButton();
		} catch (error) {
			console.error(
				"Audio Notes: could not apply meeting label",
				item.file.path,
				error
			);
			new Notice(`Could not label ${item.title}.`, 6000);
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
		let applied = 0;
		for (const item of ready) {
			try {
				await applyMeetingLabelToFile(
					this.plugin.app,
					item.file,
					item.chosenTag
				);
				this.removeItem(item);
				applied += 1;
			} catch (error) {
				console.error(
					"Audio Notes: could not apply meeting label",
					item.file.path,
					error
				);
			}
		}
		this.updateSummary();
		this.updateApplyAllButton();
		new Notice(`Applied labels to ${applied} meeting notes.`);
	}
}

function formatLabelOptionText(info: MeetingLabelInfo): string {
	return `${info.icon ? `${info.icon} ` : ""}${info.displayName}`;
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
