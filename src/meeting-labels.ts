export interface MeetingLabelCategory {
	id: string;
	name: string;
	icon?: string;
	tagPrefix: string;
}

export interface NormalizedMeetingLabelCategory extends MeetingLabelCategory {
	tagPrefix: string;
	name: string;
	icon?: string;
}

export interface MeetingLabelInfo {
	tag: string;
	displayName: string;
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
			return {
				id,
				name,
				icon,
				tagPrefix: prefix,
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
	return {
		tag: normalizedTag,
		displayName: buildLabelDisplay(normalizedTag, categories),
		categoryId: category?.id,
		categoryName: category?.name,
		icon: category?.icon,
	};
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
				return withoutPrefix
					.split("/")
					.filter(Boolean)
					.map((seg) => titleCaseSegment(seg))
					.join(" > ");
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
