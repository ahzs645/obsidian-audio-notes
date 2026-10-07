export interface MeetingLabelCategory {
	id: string;
	name: string;
	icon?: string;
	tagPrefix: string;
	/** Friendly names typed for labels in this category, keyed by full tag. */
	labelNames?: Record<string, string>;
}

export interface NormalizedMeetingLabelCategory extends MeetingLabelCategory {
	tagPrefix: string;
	name: string;
	icon?: string;
}

export interface MeetingLabelInfo {
	tag: string;
	displayName: string;
	/** "Job › Northern Health": the display name with its category. */
	fullName: string;
	categoryId?: string;
	categoryName?: string;
	icon?: string;
}

export const DEFAULT_MEETING_LABEL_CATEGORIES: MeetingLabelCategory[] = [
	{ id: "job", name: "Job", icon: "💼", tagPrefix: "job/" },
	{ id: "education", name: "Education", icon: "🎓", tagPrefix: "edu/" },
	{ id: "volunteer", name: "Volunteer", icon: "🤝", tagPrefix: "volunteer/" },
	{ id: "organization", name: "Organization", icon: "🏢", tagPrefix: "org/" },
];

export function normalizeTagName(value: string | undefined): string {
	if (!value) return "";
	return value.replace(/^#/, "").trim().toLowerCase();
}

export function normalizeMeetingLabelCategories(
	categories: MeetingLabelCategory[] = []
): NormalizedMeetingLabelCategory[] {
	const seen = new Set<string>();
	return categories
		.map<NormalizedMeetingLabelCategory | null>((category, index) => {
			const name = category.name?.trim() || `Category ${index + 1}`;
			const icon = category.icon?.trim();
			const prefix = normalizeTagPrefix(category.tagPrefix || category.id || name);
			if (!prefix) {
				return null;
			}
			const id = category.id?.trim() || slugifyId(name);
			if (!id || seen.has(id)) {
				return null;
			}
			seen.add(id);
			const labelNames: Record<string, string> = {};
			for (const [tag, label] of Object.entries(category.labelNames ?? {})) {
				const key = normalizeTagName(tag);
				const value = typeof label === "string" ? label.trim() : "";
				if (key && value) labelNames[key] = value;
			}
			return {
				id,
				name,
				icon,
				tagPrefix: prefix,
				labelNames,
			};
		})
		.filter(
			(category): category is NormalizedMeetingLabelCategory =>
				category !== null
		);
}

export function getEffectiveMeetingLabelCategories(
	categories: MeetingLabelCategory[] | undefined
): NormalizedMeetingLabelCategory[] {
	const source =
		categories && categories.length
			? categories
			: DEFAULT_MEETING_LABEL_CATEGORIES;
	return normalizeMeetingLabelCategories(source);
}

export function normalizeTagPrefix(value: string | undefined): string {
	if (!value) return "";
	let normalized = value.replace(/^#/, "").trim().toLowerCase();
	if (!normalized) return "";
	if (!normalized.endsWith("/")) {
		normalized = `${normalized}/`;
	}
	return normalized;
}

export function buildMeetingLabelInfo(
	tag: string,
	categories: NormalizedMeetingLabelCategory[] = []
): MeetingLabelInfo {
	const normalizedTag = normalizeTagName(tag);
	const category = findLabelCategoryForTag(normalizedTag, categories);
	const displayName = buildLabelDisplay(normalizedTag, categories);
	return {
		tag: normalizedTag,
		displayName,
		fullName: category ? `${category.name} › ${displayName}` : displayName,
		categoryId: category?.id,
		categoryName: category?.name,
		icon: category?.icon,
	};
}

/**
 * Saves (or clears, with an empty name) the friendly name for one label on
 * the raw settings categories. Returns false when no category owns the tag.
 */
export function setLabelDisplayName(
	categories: MeetingLabelCategory[],
	tag: string,
	name: string
): boolean {
	const normalizedTag = normalizeTagName(tag);
	const owner = categories
		.filter((category) => {
			const prefix = normalizeTagPrefix(category.tagPrefix || category.id || category.name);
			return prefix && normalizedTag.startsWith(prefix);
		})
		.sort(
			(a, b) =>
				normalizeTagPrefix(b.tagPrefix || b.id || b.name).length -
				normalizeTagPrefix(a.tagPrefix || a.id || a.name).length
		)[0];
	if (!owner) return false;
	const names = { ...(owner.labelNames ?? {}) };
	const trimmed = name.trim();
	if (trimmed) names[normalizedTag] = trimmed;
	else delete names[normalizedTag];
	owner.labelNames = names;
	return true;
}

export function findLabelCategoryForTag(
	tag: string,
	categories: NormalizedMeetingLabelCategory[]
): NormalizedMeetingLabelCategory | undefined {
	const normalizedTag = normalizeTagName(tag);
	return categories
		.filter((category) => normalizedTag.startsWith(category.tagPrefix))
		.sort((a, b) => b.tagPrefix.length - a.tagPrefix.length)[0];
}

export function buildLabelDisplay(
	tag: string,
	categories?: NormalizedMeetingLabelCategory[]
): string {
	const normalizedTag = normalizeTagName(tag);
	if (categories && categories.length) {
		const category = findLabelCategoryForTag(normalizedTag, categories);
		if (category) {
			const withoutPrefix = normalizedTag
				.slice(category.tagPrefix.length)
				.replace(/^\/+/, "");
			if (withoutPrefix) {
				// Each level uses its typed name when one was saved, so
				// "projects/nhhr" reads "NHHR" rather than "Nhhr".
				let path = category.tagPrefix.replace(/\/+$/, "");
				return withoutPrefix
					.split("/")
					.filter(Boolean)
					.map((seg) => {
						path = `${path}/${seg}`;
						return category.labelNames?.[path] || titleCaseSegment(seg);
					})
					.join(" › ");
			}
		}
	}
	const segment = normalizedTag.split("/").pop() || normalizedTag;
	return titleCaseSegment(segment);
}

function titleCaseSegment(segment: string): string {
	return segment
		.split(/[-_]/)
		.filter(Boolean)
		.map(
			(part) =>
				part.charAt(0).toUpperCase() +
				(part.length > 1 ? part.slice(1) : "")
		)
		.join(" ");
}

export function slugifyTagSegment(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9/_]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[-/]+|[-/]+$/g, "");
	return normalized || "label";
}

export function buildTagFromCategory(
	category: NormalizedMeetingLabelCategory,
	value: string
): string {
	const segment = slugifyTagSegment(value);
	return normalizeTagName(`${category.tagPrefix}${segment}`);
}

export function getParentTag(tag: string): string | null {
	const normalized = normalizeTagName(tag);
	const lastSlash = normalized.lastIndexOf("/");
	if (lastSlash <= 0) return null;
	return normalized.slice(0, lastSlash);
}

function slugifyId(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "category";
}

/**
 * Distinct, readable-on-both-themes hues. Labels without a configured color
 * get one picked from their tag, so every label keeps the same color across
 * the sidebar, calendar and exports without any setup.
 */
export const LABEL_COLOR_PALETTE = [
	"#3e7bfa",
	"#e5534b",
	"#2da44e",
	"#d4a72c",
	"#a371f7",
	"#1f9fae",
	"#e0823d",
	"#d35d9e",
	"#6e8b3d",
	"#8a6d5b",
	"#5b6ee1",
	"#c2453d",
];

export function defaultLabelColor(tag: string): string {
	const normalized = normalizeTagName(tag);
	let hash = 2166136261;
	for (let i = 0; i < normalized.length; i++) {
		hash ^= normalized.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return LABEL_COLOR_PALETTE[(hash >>> 0) % LABEL_COLOR_PALETTE.length];
}

/** The configured color for a tag or its nearest parent, else its default. */
export function resolveLabelColor(
	tag: string,
	colorMap: Record<string, string> = {}
): string {
	const lookup = new Map<string, string>();
	for (const [key, value] of Object.entries(colorMap)) {
		const k = normalizeTagName(key);
		if (k && typeof value === "string" && value.trim()) lookup.set(k, value.trim());
	}
	let current: string | null = normalizeTagName(tag);
	while (current) {
		const color = lookup.get(current);
		if (color) return color;
		current = getParentTag(current);
	}
	return defaultLabelColor(tag);
}
