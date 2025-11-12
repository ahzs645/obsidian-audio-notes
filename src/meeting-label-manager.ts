import type { App, TFile } from "obsidian";
import { MEETING_TAG } from "./meeting-events";
import { normalizeTagName } from "./meeting-labels";

export async function applyMeetingLabelToFile(
	app: App,
	file: TFile,
	tag?: string
): Promise<string | undefined> {
	const normalizedTag = normalizeTagName(tag);
	await app.fileManager.processFrontMatter(file, (frontmatter) => {
		const tags = new Set(
			coerceFrontmatterTags(frontmatter.tags).map((entry) =>
				normalizeTagName(entry)
			)
		);
		tags.add(MEETING_TAG);
		if (normalizedTag) {
			tags.add(normalizedTag);
			frontmatter.meeting_label = normalizedTag;
		} else {
			delete frontmatter.meeting_label;
		}
		frontmatter.tags = Array.from(tags).filter(Boolean);
	});
	return normalizedTag;
}

export function coerceFrontmatterTags(value: unknown): string[] {
	if (!value) {
		return [];
	}
	if (Array.isArray(value)) {
		return value.flatMap((entry) => coerceFrontmatterTags(entry));
	}
	if (typeof value === "string") {
		return value
			.split(/[, ]+/)
			.map((tag) => tag.replace(/^#/, "").trim())
			.filter(Boolean);
	}
	return [];
}

export function getMeetingLabelFromFrontmatter(
	frontmatter: Record<string, unknown> | undefined
): string | undefined {
	if (
		frontmatter &&
		typeof frontmatter.meeting_label === "string" &&
		frontmatter.meeting_label.trim().length
	) {
		return normalizeTagName(frontmatter.meeting_label);
	}
	return undefined;
}
