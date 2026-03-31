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

export function getAttendeesFromFrontmatter(
	frontmatter: Record<string, unknown> | undefined
): string[] {
	if (!frontmatter) return [];
	return coerceAttendees(frontmatter.attendees);
}

export async function applyAttendeesToFile(
	app: App,
	file: TFile,
	attendees: string[]
): Promise<string[]> {
	const normalized = deduplicateAttendees(attendees);
	await app.fileManager.processFrontMatter(file, (frontmatter) => {
		if (normalized.length) {
			frontmatter.attendees = normalized;
		} else {
			delete frontmatter.attendees;
		}
	});
	return normalized;
}

export async function removeAttendeeFromFile(
	app: App,
	file: TFile,
	name: string
): Promise<string[]> {
	const trimmed = name.trim().toLowerCase();
	let remaining: string[] = [];
	await app.fileManager.processFrontMatter(file, (frontmatter) => {
		const current = coerceAttendees(frontmatter.attendees);
		remaining = current.filter((a) => a.toLowerCase() !== trimmed);
		if (remaining.length) {
			frontmatter.attendees = remaining;
		} else {
			delete frontmatter.attendees;
		}
	});
	return remaining;
}

function coerceAttendees(value: unknown): string[] {
	if (!value) return [];
	if (Array.isArray(value)) {
		return value
			.flatMap((entry) =>
				typeof entry === "string" ? [entry.trim()] : []
			)
			.filter(Boolean);
	}
	if (typeof value === "string") {
		return value
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	return [];
}

function deduplicateAttendees(attendees: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const name of attendees) {
		const trimmed = name.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			result.push(trimmed);
		}
	}
	return result;
}
