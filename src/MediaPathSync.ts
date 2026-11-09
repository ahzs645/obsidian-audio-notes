/**
 * Meeting notes point at their recording and transcript with plain-string
 * frontmatter paths. Obsidian rewrites wikilinks on rename but not these, so
 * any move of a recording, a transcript, or a folder holding them (by the
 * sidebar's per-meeting folders, the repair modal, or the user in the file
 * explorer) used to leave every note that linked into it broken.
 */
export const PATH_FIELD_KEYS = [
	"media_uri",
	"audio",
	"media",
	"transcript_uri",
] as const;

/**
 * Where `value` points once `oldPath` has been renamed to `newPath`, or null
 * when it did not point at `oldPath` or anything inside it.
 */
export function remapRenamedPath(
	value: unknown,
	oldPath: string,
	newPath: string
): string | null {
	if (typeof value !== "string" || !oldPath || oldPath === newPath) {
		return null;
	}
	const current = value.trim();
	if (current === oldPath) {
		return newPath;
	}
	if (current.startsWith(`${oldPath}/`)) {
		return `${newPath}${current.slice(oldPath.length)}`;
	}
	return null;
}

/** The path fields of one note's frontmatter that must follow a rename. */
export function planPathFieldUpdates(
	frontmatter: Record<string, unknown> | null | undefined,
	oldPath: string,
	newPath: string
): Record<string, string> {
	const updates: Record<string, string> = {};
	if (!frontmatter) {
		return updates;
	}
	for (const key of PATH_FIELD_KEYS) {
		const next = remapRenamedPath(frontmatter[key], oldPath, newPath);
		if (next !== null) {
			updates[key] = next;
		}
	}
	return updates;
}
