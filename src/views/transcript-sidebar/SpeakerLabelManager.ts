import { Notice, type App, type TFile } from "obsidian";

export const SPEAKER_LABELS_FIELD = "aan_speaker_labels";

interface SpeakerLabelContext {
	getCurrentMeetingFile(): TFile | null;
	getOverrides(): Record<string, string>;
	setOverrides(overrides: Record<string, string>): void;
}

export class SpeakerLabelManager {
	constructor(
		private readonly app: App,
		private readonly context: SpeakerLabelContext
	) {}

	public static extractOverrides(
		source: Record<string, unknown> | undefined
	): Record<string, string> {
		if (!source) {
			return {};
		}
		const raw = source[SPEAKER_LABELS_FIELD];
		if (!raw || typeof raw !== "object") {
			return {};
		}
		const overrides: Record<string, string> = {};
		for (const [key, value] of Object.entries(
			raw as Record<string, unknown>
		)) {
			if (typeof value === "string") {
				const trimmed = value.trim();
				if (trimmed.length) {
					overrides[key] = trimmed;
				}
			}
		}
		return overrides;
	}

	public async renameSpeaker(
		speakerKey: string,
		newLabel: string
	): Promise<void> {
		const file = this.context.getCurrentMeetingFile();
		if (!file) {
			new Notice("Open a meeting note to rename speakers.", 4000);
			return;
		}
		const trimmed = newLabel?.trim();
		if (!trimmed) {
			new Notice("Enter a speaker name.", 4000);
			return;
		}
		const overrides = this.context.getOverrides();
		if (overrides[speakerKey] === trimmed) {
			return;
		}
		try {
			await this.app.fileManager.processFrontMatter(
				file,
				(frontmatter) => {
					const existing = SpeakerLabelManager.extractOverrides(
						frontmatter as Record<string, unknown>
					);
					existing[speakerKey] = trimmed;
					(frontmatter as Record<string, unknown>)[
						SPEAKER_LABELS_FIELD
					] = existing;
				}
			);
			this.context.setOverrides({
				...overrides,
				[speakerKey]: trimmed,
			});
			new Notice(`Speaker renamed to ${trimmed}`, 3000);
		} catch (error) {
			console.error("Audio Notes: Could not rename speaker.", error);
			new Notice("Could not rename speaker.", 4000);
		}
	}
}

