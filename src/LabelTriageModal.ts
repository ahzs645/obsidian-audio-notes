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
	type NormalizedMeetingLabelCategory,
} from "./meeting-labels";

const AI_CONTEXT_MAX_CHARS = 4000;

interface TriageItem {
	file: TFile;
	title: string;
	date: string;
	attendees: string[];
	chosenTag?: string;
	source?: "ai" | "manual";
	rowEl?: HTMLElement;
	labelEl?: HTMLElement;
}

export class LabelTriageModal extends Modal {
	private items: TriageItem[] = [];
	private categories: NormalizedMeetingLabelCategory[] = [];
	private listEl?: HTMLElement;
	private summaryEl?: HTMLElement;
	private aiStatusEl?: HTMLElement;
	private suggestButton?: HTMLButtonElement;
	private applyAllButton?: HTMLButtonElement;
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
		this.items = this.collectUnlabeledMeetings();

		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("aan-label-triage");
		contentEl.createEl("h2", { text: "Unlabeled meeting notes" });
		this.summaryEl = contentEl.createEl("p", {
			cls: "aan-label-triage-summary",
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
		this.applyAllButton.addEventListener("click", () => {
			void this.applyAll();
		});
		this.aiStatusEl = contentEl.createEl("p", {
			cls: "aan-label-triage-ai-status",
		});
		void this.refreshAiStatus();

		this.listEl = contentEl.createDiv({ cls: "aan-label-triage-list" });
		for (const item of this.items) {
			this.renderRow(item);
		}
		this.updateSummary();
	}

	onClose() {
		this.closed = true;
		this.contentEl.empty();
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

		const info = row.createDiv({ cls: "aan-label-triage-info" });
		const titleEl = info.createDiv({
			text: item.title,
			cls: "aan-label-triage-title",
		});
		titleEl.addEventListener("click", () => {
			void this.plugin.app.workspace
				.getLeaf(true)
				.openFile(item.file);
			this.close();
		});
		const metaParts = [item.date, item.attendees.join(", ")].filter(
			Boolean
		);
		if (metaParts.length) {
			info.createDiv({
				text: metaParts.join(" • "),
				cls: "aan-label-triage-meta",
			});
		}

		const actions = row.createDiv({ cls: "aan-label-triage-actions" });
		item.labelEl = actions.createDiv({
			text: "No label chosen",
			cls: "aan-label-triage-label",
		});
		const pickButton = actions.createEl("button", { text: "Pick…" });
		pickButton.addEventListener("click", () => {
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
		});
		const applyButton = actions.createEl("button", {
			text: "Apply",
			cls: "mod-cta",
		});
		applyButton.addEventListener("click", () => {
			void this.applyItem(item);
		});

		this.updateRowLabel(item);
	}

	private updateRowLabel(item: TriageItem) {
		if (!item.labelEl) return;
		item.labelEl.replaceChildren();
		if (!item.chosenTag) {
			item.labelEl.setText("No label chosen");
			item.labelEl.removeClass("has-label");
			return;
		}
		const info = buildMeetingLabelInfo(item.chosenTag, this.categories);
		item.labelEl.addClass("has-label");
		item.labelEl.setText(
			`${info.icon ? `${info.icon} ` : ""}${info.displayName}${
				item.source === "ai" ? " (AI)" : ""
			}`
		);
		item.labelEl.setAttribute("title", `#${item.chosenTag}`);
	}

	private updateSummary() {
		if (!this.summaryEl) return;
		this.summaryEl.setText(
			this.items.length
				? `${this.items.length} meeting note${
						this.items.length === 1 ? "" : "s"
				  } without a label.`
				: "All meeting notes have labels. Nice and tidy."
		);
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
		const pending = this.items.filter((item) => !item.chosenTag);
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
			this.items = this.items.filter((entry) => entry !== item);
			item.rowEl?.remove();
			this.updateSummary();
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
				"No labels chosen yet. Use Pick… or the AI suggestions first."
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
				this.items = this.items.filter((entry) => entry !== item);
				item.rowEl?.remove();
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
		new Notice(`Applied labels to ${applied} meeting notes.`);
	}
}
