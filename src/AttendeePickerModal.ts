import type { App } from "obsidian";
import { SuggestModal } from "obsidian";
import type AutomaticAudioNotes from "./main";

type AttendeeSuggestion =
	| { kind: "existing"; name: string; count: number }
	| { kind: "create"; name: string };

interface AttendeePickerOptions {
	currentAttendees?: string[];
	onRemove?: (name: string) => void;
}

export class AttendeePickerModal extends SuggestModal<AttendeeSuggestion> {
	private knownAttendees: Map<string, { display: string; count: number }> =
		new Map();
	private options: AttendeePickerOptions;
	private selectedContainer: HTMLElement | null = null;

	constructor(
		app: App,
		private plugin: AutomaticAudioNotes,
		private onPick: (name: string) => void,
		options?: AttendeePickerOptions
	) {
		super(app);
		this.options = options || {};
		this.setPlaceholder("Search attendees or type a new name…");
	}

	onOpen() {
		super.onOpen();
		this.knownAttendees = this.computeAvailableAttendees();
		this.renderSelectedAttendees();
	}

	private renderSelectedAttendees() {
		const promptDiv = this.inputEl?.closest(".prompt");
		if (!promptDiv) return;

		if (this.selectedContainer) {
			this.selectedContainer.remove();
			this.selectedContainer = null;
		}

		const current = this.options.currentAttendees ?? [];
		if (!current.length) return;

		this.selectedContainer = promptDiv.createDiv({
			cls: "aan-selected-tags-container",
		});
		const header = this.selectedContainer.createEl("div", {
			text: "Current attendees",
			cls: "aan-selected-tags-title",
		});
		header.setAttribute("aria-live", "polite");

		const listDiv = this.selectedContainer.createDiv({
			cls: "aan-selected-tags-list",
		});

		for (const name of current) {
			const itemEl = listDiv.createDiv({
				cls: "aan-selected-tag-item",
			});
			itemEl.createSpan({
				text: name,
				cls: "aan-selected-tag-name",
			});

			const removeBtn = itemEl.createEl("button", {
				text: "\u00d7",
				cls: "aan-selected-tag-remove",
			});
			removeBtn.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.options.onRemove?.(name);
				itemEl.remove();
				if (
					listDiv.children.length === 0 &&
					this.selectedContainer
				) {
					this.selectedContainer.remove();
					this.selectedContainer = null;
				}
			});
		}

		const promptResults = promptDiv.querySelector(".prompt-results");
		if (promptResults) {
			promptDiv.insertBefore(this.selectedContainer, promptResults);
		} else {
			promptDiv.appendChild(this.selectedContainer);
		}
	}

	getSuggestions(query: string): AttendeeSuggestion[] {
		const rawQuery = query.trim();
		const normalizedQuery = rawQuery.toLowerCase();
		const currentSet = new Set(
			(this.options.currentAttendees ?? []).map((n) => n.toLowerCase())
		);
		const suggestions: AttendeeSuggestion[] = [];
		let hasExactMatch = false;

		const sorted = Array.from(this.knownAttendees.entries()).sort(
			(a, b) => b[1].count - a[1].count
		);

		for (const [key, { display, count }] of sorted) {
			if (currentSet.has(key)) continue;
			if (
				!normalizedQuery ||
				display.toLowerCase().includes(normalizedQuery)
			) {
				suggestions.push({
					kind: "existing",
					name: display,
					count,
				});
				if (display.toLowerCase() === normalizedQuery) {
					hasExactMatch = true;
				}
			}
		}

		if (rawQuery && !hasExactMatch && !currentSet.has(normalizedQuery)) {
			suggestions.push({
				kind: "create",
				name: rawQuery,
			});
		}

		return suggestions.slice(0, 20);
	}

	renderSuggestion(suggestion: AttendeeSuggestion, el: HTMLElement) {
		el.empty();
		el.addClass("aan-label-picker-item");

		const title = el.createDiv("aan-label-picker-title");
		if (suggestion.kind === "existing") {
			title.createSpan("aan-label-picker-icon").setText("👤");
			title.createSpan().setText(suggestion.name);
			el.createDiv("aan-label-picker-meta").setText(
				`Used in ${suggestion.count} meeting${suggestion.count !== 1 ? "s" : ""}`
			);
		} else {
			title.createSpan("aan-label-picker-icon").setText("＋");
			title.createSpan().setText(suggestion.name);
			el.createDiv("aan-label-picker-meta").setText("New attendee");
		}
	}

	onChooseSuggestion(suggestion: AttendeeSuggestion) {
		this.onPick(suggestion.name);
	}

	private computeAvailableAttendees(): Map<
		string,
		{ display: string; count: number }
	> {
		const files = this.plugin.app.vault.getMarkdownFiles();
		const results = new Map<
			string,
			{ display: string; count: number }
		>();
		for (const file of files) {
			const cache = this.plugin.app.metadataCache.getFileCache(file);
			if (!cache?.frontmatter) continue;
			const raw = cache.frontmatter.attendees;
			if (!raw) continue;
			const names: string[] = Array.isArray(raw)
				? raw.flatMap((entry: unknown) =>
						typeof entry === "string" ? [entry.trim()] : []
					)
				: typeof raw === "string"
					? raw
							.split(",")
							.map((s: string) => s.trim())
							.filter(Boolean)
					: [];
			for (const name of names) {
				if (!name) continue;
				const key = name.toLowerCase();
				const existing = results.get(key);
				if (existing) {
					existing.count++;
				} else {
					results.set(key, { display: name, count: 1 });
				}
			}
		}
		return results;
	}
}
