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
	findLabelCategoryForTag,
	getEffectiveMeetingLabelCategories,
	normalizeTagName,
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
	  }
	| {
			kind: "create";
			tag: string;
			label: MeetingLabelInfo;
			category?: NormalizedMeetingLabelCategory;
			rawInput: string;
	  }
	| {
			kind: "create-category";
			query: string;
	  };

interface MeetingLabelPickerOptions {
	onCreateCategory?: (query: string) => void;
}

export class MeetingLabelPickerModal extends SuggestModal<MeetingLabelSuggestion> {
	private categories: NormalizedMeetingLabelCategory[];
	private availableLabels: MeetingLabelInfo[] = [];
	private options: MeetingLabelPickerOptions;
	private lastQuery = "";
	private initialQuery = "";

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
		this.availableLabels = this.computeAvailableLabels();
		if (this.initialQuery) {
			this.inputEl.value = this.initialQuery;
			this.inputEl.dispatchEvent(new Event("input"));
		}
	}

	getSuggestions(query: string): MeetingLabelSuggestion[] {
		const rawQuery = query.trim();
		this.lastQuery = rawQuery;
		const normalizedQuery = rawQuery.toLowerCase();
		const suggestions: MeetingLabelSuggestion[] = [];
		for (const label of this.availableLabels) {
			if (
				!normalizedQuery ||
				label.displayName.toLowerCase().includes(normalizedQuery) ||
				label.tag.includes(normalizedQuery)
			) {
				const category = findLabelCategoryForTag(
					label.tag,
					this.categories
				);
				suggestions.push({
					kind: "existing",
					tag: label.tag,
					label,
					category,
				});
			}
		}

		if (normalizedQuery) {
			for (const category of this.categories) {
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

		return suggestions.slice(0, 20);
	}

	renderSuggestion(suggestion: MeetingLabelSuggestion, el: HTMLElement) {
		el.empty();
		el.addClass("aan-label-picker-item");

		if (suggestion.kind === "create-category") {
			const title = el.createDiv("aan-label-picker-title");
			title
				.createSpan("aan-label-picker-icon")
				.setText("➕");
			title
				.createSpan()
				.setText(
					suggestion.query
						? `Add category “${suggestion.query}”`
						: "Add meeting label category"
				);
			el.createDiv("aan-label-picker-meta").setText(
				"Create a new label prefix"
			);
			return;
		}

		const title = el.createDiv("aan-label-picker-title");
		if (suggestion.kind === "existing" && suggestion.label.icon) {
			title
				.createSpan("aan-label-picker-icon")
				.setText(suggestion.label.icon);
		} else if (suggestion.kind === "create") {
			title
				.createSpan("aan-label-picker-icon")
				.setText("＋");
		}
		const labelText =
			suggestion.kind === "create"
				? suggestion.rawInput || suggestion.label.displayName
				: suggestion.label.displayName;
		title.createSpan().setText(labelText);

		const meta = el.createDiv("aan-label-picker-meta");
		const categoryLabel =
			suggestion.category?.name ||
			suggestion.label.categoryName ||
			"Label";
		if (suggestion.kind === "existing") {
			meta.setText(`${categoryLabel} • #${suggestion.tag}`);
		} else {
			meta.setText(`Create under ${categoryLabel}`);
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
		this.onPick({
			tag: suggestion.tag,
			label: suggestion.label,
			isNew: suggestion.kind === "create",
		});
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
				if (!normalized || results.has(normalized)) {
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
		return Array.from(results.values());
	}
}
