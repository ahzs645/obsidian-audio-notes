import { Notice, type App, type TFile } from "obsidian";
import type AutomaticAudioNotes from "../../main";
import {
	MeetingLabelPickerModal,
	type MeetingLabelSelection,
} from "../../MeetingLabelPickerModal";
import { MeetingLabelCategoryModal } from "../../settings/MeetingLabelCategoryModal";
import {
	getEffectiveMeetingLabelCategories,
	type MeetingLabelInfo,
	normalizeTagPrefix,
	slugifyTagSegment,
} from "../../meeting-labels";
import { collectTags } from "../../meeting-events";
import {
	applyMeetingLabelToFile,
	getMeetingLabelFromFrontmatter,
} from "../../meeting-label-manager";

interface MeetingLabelManagerContext {
	getMode(): "meeting" | "dashboard";
	getCurrentMeetingFile(): TFile | null;
	getCurrentMeetingLabel(): MeetingLabelInfo | undefined;
	setCurrentMeetingLabel: (label: MeetingLabelInfo | undefined) => void;
	refreshLabelHeader: () => void;
}

export class MeetingLabelManager {
	constructor(
		private readonly app: App,
		private readonly plugin: AutomaticAudioNotes,
		private readonly context: MeetingLabelManagerContext
	) {}

	public openLabelPicker(initialQuery = ""): void {
		if (this.context.getMode() !== "meeting") {
			new Notice("Open a meeting note to assign a label.", 4000);
			return;
		}
		const file = this.context.getCurrentMeetingFile();
		if (!file) {
			new Notice("Open a meeting note to assign a label.", 4000);
			return;
		}

		const cache = this.app.metadataCache.getFileCache(file);
		const categories = getEffectiveMeetingLabelCategories(
			this.plugin.settings.meetingLabelCategories
		);
		const currentTagSet = new Set<string>();
		const frontmatterLabel = getMeetingLabelFromFrontmatter(
			(cache?.frontmatter as Record<string, unknown> | undefined) ??
				undefined
		);
		if (frontmatterLabel) {
			currentTagSet.add(frontmatterLabel);
		}
		if (!currentTagSet.size && cache) {
			for (const tag of collectTags(cache)) {
				if (
					!categories.length ||
					categories.some((cat) => tag.startsWith(cat.tagPrefix))
				) {
					currentTagSet.add(tag);
				}
			}
		}
		const currentMeetingLabel = this.context.getCurrentMeetingLabel();
		if (currentMeetingLabel?.tag) {
			currentTagSet.add(currentMeetingLabel.tag);
		}
		const currentTags = Array.from(currentTagSet);

		const picker = new MeetingLabelPickerModal(
			this.app,
			this.plugin,
			(selection) => {
				void this.applyMeetingLabelSelection(selection);
			},
			{
				onCreateCategory: (query) =>
					this.openCategoryModal(query, true),
				currentTags,
				onRemoveTag: (tag) => {
					void this.removeMeetingTag(tag);
				},
			}
		);
		if (initialQuery) {
			picker.setInitialQuery(initialQuery);
		}
		picker.open();
	}

	private async applyMeetingLabelSelection(
		selection: MeetingLabelSelection
	): Promise<void> {
		const file = this.context.getCurrentMeetingFile();
		if (!file) {
			return;
		}
		try {
			await applyMeetingLabelToFile(this.app, file, selection.tag);
			this.context.setCurrentMeetingLabel(selection.label);
			this.context.refreshLabelHeader();
			new Notice(
				selection.label.displayName
					? `Meeting labeled as ${selection.label.displayName}.`
					: "Meeting label updated."
			);
		} catch (error) {
			console.error(error);
			new Notice("Could not update meeting label.", 6000);
		}
	}

	private async removeMeetingTag(tag: string): Promise<void> {
		const file = this.context.getCurrentMeetingFile();
		if (!file) {
			return;
		}
		try {
			await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
				if (Array.isArray(frontmatter.tags)) {
					frontmatter.tags = frontmatter.tags.filter(
						(t: string) => t !== tag && t !== `#${tag}`
					);
				}
				if (frontmatter.meeting_label === tag) {
					delete frontmatter.meeting_label;
				}
			});
			this.context.refreshLabelHeader();
			new Notice(`Removed tag: ${tag}`);
		} catch (error) {
			console.error(error);
			new Notice("Could not remove tag.", 6000);
		}
	}

	private openCategoryModal(initialQuery?: string, reopenAfter = false) {
		const initialName = this.formatCategoryName(initialQuery);
		const initialPrefix = this.formatCategoryPrefix(initialQuery);
		new MeetingLabelCategoryModal(
			this.app,
			this.plugin,
			{
				initialName,
				initialPrefix,
			},
			() => {
				this.context.refreshLabelHeader();
				if (reopenAfter) {
					setTimeout(
						() => this.openLabelPicker(initialQuery ?? ""),
						100
					);
				}
			}
		).open();
	}

	private formatCategoryName(raw?: string): string {
		const value = raw?.trim();
		if (!value) return "";
		return value
			.split(/[\s/_-]+/)
			.filter(Boolean)
			.map(
				(part) =>
					part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
			)
			.join(" ");
	}

	private formatCategoryPrefix(raw?: string): string {
		if (!raw?.trim()) {
			return "";
		}
		return (
			normalizeTagPrefix(raw) ||
			`${slugifyTagSegment(raw) || "category"}/`
		);
	}
}
