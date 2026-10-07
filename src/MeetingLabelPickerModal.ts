import type { App } from "obsidian";
import { SuggestModal } from "obsidian";
import type AutomaticAudioNotes from "./main";
import type {
	MeetingLabelInfo,
	NormalizedMeetingLabelCategory,
} from "./meeting-labels";
import {
	buildMeetingLabelInfo,
	buildTagFromCategory,
	setLabelDisplayName,
	findLabelCategoryForTag,
	getEffectiveMeetingLabelCategories,
	getParentTag,
	normalizeTagName,
	resolveLabelColor,
} from "./meeting-labels";
import { collectTags } from "./meeting-events";
export interface MeetingLabelSelection {
	tag: string;
	label: MeetingLabelInfo;
	isNew: boolean;
}

type MeetingLabelSuggestion =
	| {
			kind: "existing";
			tag: string;
			label: MeetingLabelInfo;
			category?: NormalizedMeetingLabelCategory;
			childCount?: number;
			/** Set on the first label of each category when browsing. */
			groupHeading?: string;
	  }
	| {
			kind: "create";
			tag: string;
			label: MeetingLabelInfo;
			category?: NormalizedMeetingLabelCategory;
			rawInput: string;
	  }
	| {
			kind: "create-subtag";
			parentTag: string;
			parentLabel: MeetingLabelInfo;
			category: NormalizedMeetingLabelCategory;
	  }
	| {
			kind: "create-category";
			query: string;
	  };

interface MeetingLabelPickerOptions {
	onCreateCategory?: (query: string) => void;
	currentTags?: string[];
	onRemoveTag?: (tag: string) => void;
}

export class MeetingLabelPickerModal extends SuggestModal<MeetingLabelSuggestion> {
	private categories: NormalizedMeetingLabelCategory[];
	private availableLabels: MeetingLabelInfo[] = [];
	private childrenMap: Map<string, string[]> = new Map();
	/** How many notes use each tag, for ordering and the count badge. */
	private usage: Map<string, number> = new Map();
	private options: MeetingLabelPickerOptions;
	private lastQuery = "";
	private initialQuery = "";
	private selectedTagsContainer: HTMLElement | null = null;

	constructor(
		app: App,
		private plugin: AutomaticAudioNotes,
		private onPick: (selection: MeetingLabelSelection) => void,
		options?: MeetingLabelPickerOptions
	) {
		super(app);
		this.options = options || {};
		this.categories = getEffectiveMeetingLabelCategories(
			this.plugin.settings.meetingLabelCategories
		);
		this.setPlaceholder(
			"Search existing labels or type to create a new meeting tag…"
		);
	}

	public setInitialQuery(query: string) {
		this.initialQuery = query;
	}

	onOpen() {
		// SuggestModal.onOpen() renders the list right away, so load labels first.
		this.availableLabels = this.computeAvailableLabels();
		super.onOpen();
		this.renderSelectedTags();
		if (this.initialQuery) {
			this.inputEl.value = this.initialQuery;
			this.inputEl.dispatchEvent(new Event("input"));
		}
	}

	private renderSelectedTags() {
		const promptDiv = this.inputEl?.closest(".prompt");
		if (!promptDiv) {
			return;
		}

		if (this.selectedTagsContainer) {
			this.selectedTagsContainer.remove();
			this.selectedTagsContainer = null;
		}

		const currentTags = this.options.currentTags ?? [];
		if (!currentTags.length) {
			return;
		}

		this.selectedTagsContainer = promptDiv.createDiv({
			cls: "aan-selected-tags-container",
		});
		const header = this.selectedTagsContainer.createEl("div", {
			text: "Selected tags",
			cls: "aan-selected-tags-title",
		});
		header.setAttribute("aria-live", "polite");

		const tagsListDiv = this.selectedTagsContainer.createDiv({
			cls: "aan-selected-tags-list",
		});

		for (const tag of currentTags) {
			const labelInfo = buildMeetingLabelInfo(tag, this.categories);
			const tagEl = tagsListDiv.createDiv({
				cls: "aan-selected-tag-item",
			});
			tagEl.style.setProperty("--aan-label-color", this.colorFor(tag));

			if (labelInfo.icon) {
				tagEl.createSpan({
					text: labelInfo.icon,
					cls: "aan-selected-tag-icon",
				});
			}

			tagEl.createSpan({
				text: labelInfo.displayName,
				cls: "aan-selected-tag-name",
			});

			const removeBtn = tagEl.createEl("button", {
				text: "×",
				cls: "aan-selected-tag-remove",
			});

			removeBtn.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.options.onRemoveTag?.(tag);
				tagEl.remove();
				if (
					tagsListDiv.children.length === 0 &&
					this.selectedTagsContainer
				) {
					this.selectedTagsContainer.remove();
					this.selectedTagsContainer = null;
				}
			});
		}

		const promptResults = promptDiv.querySelector(".prompt-results");
		if (promptResults) {
			promptDiv.insertBefore(this.selectedTagsContainer, promptResults);
		} else {
			promptDiv.appendChild(this.selectedTagsContainer);
		}
	}

	getSuggestions(query: string): MeetingLabelSuggestion[] {
		const rawQuery = query.trim();
		this.lastQuery = rawQuery;
		const normalizedQuery = rawQuery.toLowerCase();
		const suggestions: MeetingLabelSuggestion[] = [];
		const matchedParentTags = new Set<string>();

		const categoryOrder = (tag: string) => {
			const category = findLabelCategoryForTag(tag, this.categories);
			const index = category ? this.categories.indexOf(category) : -1;
			return index === -1 ? this.categories.length : index;
		};
		const matches = this.availableLabels.filter(
			(label) =>
				!normalizedQuery ||
				label.displayName.toLowerCase().includes(normalizedQuery) ||
				label.fullName.toLowerCase().includes(normalizedQuery) ||
				label.tag.includes(normalizedQuery)
		);
		// Browsing: grouped by category, most-used first. Searching: names
		// that start with the query first, then by use.
		const startsWith = (label: MeetingLabelInfo) =>
			label.displayName.toLowerCase().startsWith(normalizedQuery) ? 0 : 1;
		matches.sort(
			(a, b) =>
				(normalizedQuery ? startsWith(a) - startsWith(b) : categoryOrder(a.tag) - categoryOrder(b.tag)) ||
				(this.usage.get(b.tag) ?? 0) - (this.usage.get(a.tag) ?? 0) ||
				a.displayName.localeCompare(b.displayName)
		);
		let lastGroup: string | undefined;
		for (const label of matches) {
			const category = findLabelCategoryForTag(label.tag, this.categories);
			const children = this.childrenMap.get(label.tag);
			const group = category?.name ?? "Other";
			suggestions.push({
				kind: "existing",
				tag: label.tag,
				label,
				category,
				childCount: children?.length ?? 0,
				groupHeading: !normalizedQuery && group !== lastGroup ? group : undefined,
			});
			lastGroup = group;
			if (children?.length) {
				matchedParentTags.add(label.tag);
			}
		}

		// Typing an existing label's exact name shouldn't offer to create it again.
		const exactExisting = matches.some(
			(label) => label.displayName.toLowerCase() === normalizedQuery
		);

		if (normalizedQuery) {
			for (const parentTag of matchedParentTags) {
				const category = findLabelCategoryForTag(
					parentTag,
					this.categories
				);
				if (category) {
					const parentLabel = buildMeetingLabelInfo(
						parentTag,
						this.categories
					);
					suggestions.push({
						kind: "create-subtag",
						parentTag,
						parentLabel,
						category,
					});
				}
			}

			for (const category of exactExisting ? [] : this.categories) {
				const tag = buildTagFromCategory(
					category,
					normalizedQuery || category.name || ""
				);
				if (this.availableLabels.some((item) => item.tag === tag)) {
					continue;
				}
				const label = buildMeetingLabelInfo(tag, this.categories);
				suggestions.push({
					kind: "create",
					tag,
					label,
					category,
					rawInput: rawQuery || label.displayName,
				});
			}
		}

		const hasMatchingCategory =
			normalizedQuery &&
			this.categories.some(
				(category) =>
					category.name.toLowerCase().includes(normalizedQuery) ||
					category.tagPrefix.includes(normalizedQuery)
			);

		if (this.options.onCreateCategory) {
			if (normalizedQuery && !hasMatchingCategory) {
				suggestions.push({
					kind: "create-category",
					query: normalizedQuery,
				});
			} else if (!normalizedQuery && !this.categories.length) {
				suggestions.push({
					kind: "create-category",
					query: "",
				});
			}
		}

		if (
			!suggestions.length &&
			this.options.onCreateCategory &&
			!normalizedQuery
		) {
			suggestions.push({
				kind: "create-category",
				query: "",
			});
		}

		return suggestions.slice(0, 40);
	}

	renderSuggestion(suggestion: MeetingLabelSuggestion, el: HTMLElement) {
		el.empty();
		el.addClass("aan-label-picker-item");

		if (suggestion.kind === "create-category") {
			this.renderRow(el, {
				marker: "plus",
				title: suggestion.query ? `Add category “${suggestion.query}”` : "Add a label category",
				meta: "A new group of labels, like Job or Research",
			});
			return;
		}

		if (suggestion.kind === "create-subtag") {
			this.renderRow(el, {
				marker: "plus",
				color: this.colorFor(suggestion.parentTag),
				title: `New label under ${suggestion.parentLabel.displayName}`,
				meta: this.categoryText(suggestion.category, `#${suggestion.parentTag}/…`),
			});
			return;
		}

		if (suggestion.kind === "create") {
			this.renderRow(el, {
				marker: "plus",
				color: this.colorFor(suggestion.tag),
				title: `Create “${(suggestion.rawInput || suggestion.label.displayName).split("/").pop()}”`,
				meta: this.categoryText(suggestion.category, `#${suggestion.tag}`),
			});
			return;
		}

		if (suggestion.groupHeading) {
			el.addClass("has-group-heading");
			el.setAttribute("data-group", suggestion.groupHeading);
		}
		const path = suggestion.label.displayName.split(" › ");
		const name = path.pop() ?? suggestion.label.displayName;
		const count = this.usage.get(suggestion.tag) ?? 0;
		const isCurrent = (this.options.currentTags ?? []).includes(suggestion.tag);
		const subLabels = suggestion.childCount
			? ` · ${suggestion.childCount} sub-label${suggestion.childCount > 1 ? "s" : ""}`
			: "";
		this.renderRow(el, {
			marker: "dot",
			color: this.colorFor(suggestion.tag),
			parent: path.length ? `${path.join(" › ")} › ` : undefined,
			title: name,
			meta: this.categoryText(suggestion.category, `#${suggestion.tag}${subLabels}`),
			badge: isCurrent ? "Current" : undefined,
			count: count || undefined,
		});
		if (isCurrent) el.addClass("is-current");
	}

	private colorFor(tag: string): string {
		return resolveLabelColor(tag, this.plugin.settings.calendarTagColors);
	}

	private categoryText(
		category: NormalizedMeetingLabelCategory | undefined,
		detail: string
	): string {
		const name = category ? `${category.icon ? `${category.icon} ` : ""}${category.name}` : "Label";
		return `${name} · ${detail}`;
	}

	private renderRow(
		el: HTMLElement,
		row: {
			marker: "dot" | "plus";
			color?: string;
			parent?: string;
			title: string;
			meta: string;
			badge?: string;
			count?: number;
		}
	) {
		if (row.color) el.style.setProperty("--aan-label-color", row.color);
		const marker = el.createSpan({
			cls: `aan-label-picker-marker is-${row.marker}`,
			attr: { "aria-hidden": "true" },
		});
		if (row.marker === "plus") marker.setText("+");
		const body = el.createDiv({ cls: "aan-label-picker-body" });
		const title = body.createDiv({ cls: "aan-label-picker-title" });
		if (row.parent) title.createSpan({ cls: "aan-label-picker-parent", text: row.parent });
		title.createSpan({ cls: "aan-label-picker-name", text: row.title });
		body.createDiv({ cls: "aan-label-picker-meta", text: row.meta });
		if (row.badge) el.createSpan({ cls: "aan-label-picker-badge", text: row.badge });
		if (row.count) {
			el.createSpan({
				cls: "aan-label-picker-count",
				text: row.count.toLocaleString(),
				attr: { "aria-label": `${row.count} meeting${row.count === 1 ? "" : "s"}` },
			});
		}
	}

	onChooseSuggestion(suggestion: MeetingLabelSuggestion) {
		if (suggestion.kind === "create-category") {
			this.close();
			const query =
				this.lastQuery.trim() || suggestion.query || "";
			this.options.onCreateCategory?.(query);
			return;
		}
		if (suggestion.kind === "create-subtag") {
			this.close();
			const reopened = new MeetingLabelPickerModal(
				this.app,
				this.plugin,
				this.onPick,
				this.options
			);
			reopened.setInitialQuery(
				suggestion.parentTag.replace(/\/$/, "") + "/"
			);
			reopened.open();
			return;
		}
		let label = suggestion.label;
		if (suggestion.kind === "create") {
			label = this.rememberTypedName(suggestion.tag, suggestion.rawInput) ?? label;
		}
		this.onPick({
			tag: suggestion.tag,
			label,
			isNew: suggestion.kind === "create",
		});
	}

	/**
	 * The tag is a slug ("projects/nhhr"), so keep what was typed ("NHHR")
	 * as the label's display name instead of title-casing the slug later.
	 */
	private rememberTypedName(tag: string, rawInput?: string): MeetingLabelInfo | undefined {
		const typed = (rawInput ?? "").split("/").pop()?.trim();
		if (!typed) return undefined;
		const generated = buildMeetingLabelInfo(tag, this.categories).displayName.split(" › ").pop();
		// An all-lowercase entry is just how people type; only keep deliberate names.
		if (typed === generated || typed === typed.toLowerCase()) return undefined;
		if (!setLabelDisplayName(this.plugin.settings.meetingLabelCategories, tag, typed)) return undefined;
		void this.plugin.saveSettings();
		this.categories = getEffectiveMeetingLabelCategories(this.plugin.settings.meetingLabelCategories);
		return buildMeetingLabelInfo(tag, this.categories);
	}

	private computeAvailableLabels(): MeetingLabelInfo[] {
		const files = this.plugin.app.vault.getMarkdownFiles();
		const results = new Map<string, MeetingLabelInfo>();
		for (const file of files) {
			const cache = this.plugin.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			const tags = collectTags(cache);
			for (const tag of tags) {
				const normalized = normalizeTagName(tag);
				if (!normalized) continue;
				this.usage.set(normalized, (this.usage.get(normalized) ?? 0) + 1);
				if (results.has(normalized)) {
					continue;
				}
				const category = findLabelCategoryForTag(
					normalized,
					this.categories
				);
				if (!category) {
					continue;
				}
				results.set(
					normalized,
					buildMeetingLabelInfo(normalized, this.categories)
				);
			}
		}

		this.childrenMap = new Map();
		for (const tag of results.keys()) {
			const parent = getParentTag(tag);
			if (parent) {
				const children = this.childrenMap.get(parent) ?? [];
				children.push(tag);
				this.childrenMap.set(parent, children);
			}
		}

		return Array.from(results.values());
	}
}
