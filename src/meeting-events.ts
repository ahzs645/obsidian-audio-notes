import type { App, CachedMetadata } from "obsidian";

export interface MeetingEvent {
	path: string;
	title: string;
	start: Date;
	end: Date;
	tags: string[];
	jobTag?: string;
	color: string;
	displayDate: string;
	displayEndDate: string;
}

const DEFAULT_EVENT_COLOR = "var(--interactive-accent)";
const MEETING_TAG = "meeting";

export function collectMeetingEvents(
	app: App,
	colorMap: Record<string, string>
): MeetingEvent[] {
	const files = app.vault.getMarkdownFiles();
	const normalizedColors = normalizeColorMap(colorMap);
	const events: MeetingEvent[] = [];

	for (const file of files) {
		const cache = app.metadataCache.getFileCache(file);
		const event = buildMeetingEvent(cache, file.path, file.basename, normalizedColors);
		if (event) {
			events.push(event);
		}
	}

	return events.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export function localDateKey(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function buildMeetingEvent(
	cache: CachedMetadata | null,
	path: string,
	basename: string,
	colorMap: Map<string, string>
): MeetingEvent | null {
	if (!cache?.frontmatter) {
		return null;
	}
	const { frontmatter } = cache;
	const tags = collectTags(cache);
	const hasMeetingTag = tags.includes(MEETING_TAG) || frontmatter[MEETING_TAG] === true;
	if (!hasMeetingTag) {
		return null;
	}

	const rawStartDate =
		typeof frontmatter.start_date === "string"
			? frontmatter.start_date.trim()
			: undefined;
	const rawEndDate =
		typeof frontmatter.end_date === "string"
			? frontmatter.end_date.trim()
			: undefined;

	const startDate =
		parseDateFromParts(frontmatter.start_date, frontmatter.start_time) ??
		parseISO(frontmatter.start);
	if (!startDate) {
		return null;
	}

	const endDate =
		parseDateFromParts(frontmatter.end_date, frontmatter.end_time) ??
		parseISO(frontmatter.end) ??
		startDate;

	const explicitJob =
		typeof frontmatter.job === "string" && frontmatter.job.trim().length
			? `job/${frontmatter.job.trim().toLowerCase()}`
			: undefined;
	const jobTag = explicitJob ?? tags.find((tag) => tag.startsWith("job/"));

	if (jobTag && !tags.includes(jobTag)) {
		tags.push(jobTag);
	}

	const color =
		(jobTag && getColor(colorMap, jobTag)) ??
		findColorForTags(colorMap, tags) ??
		getColor(colorMap, MEETING_TAG) ??
		DEFAULT_EVENT_COLOR;

		return {
			path,
			title: frontmatter.title || basename,
			start: startDate,
			end: endDate,
			tags,
			jobTag,
			color,
			displayDate: rawStartDate || localDateKey(startDate),
			displayEndDate: rawEndDate || localDateKey(endDate),
		};
	}

function parseDateFromParts(date: unknown, time: unknown): Date | null {
	if (typeof date !== "string" || !date.trim()) {
		return null;
	}
	const [year, month, day] = date.split("-").map((part) => Number(part));
	const [hours = 0, minutes = 0, seconds = 0] =
		typeof time === "string" && time.trim().length
			? time.split(":").map((part) => Number(part))
			: [];
	const value = new Date(
		year ?? 0,
		(month ?? 1) - 1,
		day ?? 1,
		hours ?? 0,
		minutes ?? 0,
		seconds ?? 0
	);
	return Number.isNaN(value.getTime()) ? null : value;
}

function parseISO(value: unknown): Date | null {
	if (typeof value !== "string" || !value.trim()) {
		return null;
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function collectTags(cache: CachedMetadata | null): string[] {
	const frontmatterTags = normalizeTagValue(cache?.frontmatter?.tags);
	const inlineTags =
		cache?.tags?.map((tag) => tag.tag.replace(/^#/, "").trim()).filter(Boolean) ?? [];
	const combined = [...frontmatterTags, ...inlineTags];
	return Array.from(new Set(combined.map((tag) => tag.toLowerCase())));
}

function normalizeTagValue(value: unknown): string[] {
	if (!value) {
		return [];
	}
	if (Array.isArray(value)) {
		return value.flatMap((entry) => normalizeTagValue(entry));
	}
	if (typeof value === "string") {
		return value
			.split(/[, ]+/)
			.map((tag) => tag.replace(/^#/, "").trim())
			.filter(Boolean);
	}
	return [];
}

function normalizeColorMap(colorMap: Record<string, string>): Map<string, string> {
	const map = new Map<string, string>();
	for (const [tag, color] of Object.entries(colorMap || {})) {
		const normalizedTag = tag.trim().toLowerCase();
		const normalizedColor = color.trim();
		if (!normalizedTag || !normalizedColor) {
			continue;
		}
		map.set(normalizedTag, normalizedColor);
	}
	return map;
}

function getColor(map: Map<string, string>, tag: string | undefined): string | undefined {
	if (!tag) return undefined;
	return map.get(tag.toLowerCase());
}

function findColorForTags(map: Map<string, string>, tags: string[]): string | undefined {
	for (const tag of tags) {
		const color = getColor(map, tag);
		if (color) {
			return color;
		}
	}
	return undefined;
}
