/**
 * Finds and fixes stale bookkeeping fields in meeting notes:
 *
 * - `title` still holding the recorder's file name ("4", "Mar 3 11.20.59 AM
 *   System Audio") after the note was renamed to the real meeting name. A
 *   numeric title is a YAML number, which the rename sync skipped.
 * - `daily_note` / `weekly_note` written by the old formatter, which printed
 *   quoted literals verbatim ("2025-'W'49").
 *
 * Planning is pure so it can be tested; applying goes through
 * processFrontMatter one note at a time.
 */

export interface MetadataRepairInput {
	path: string;
	basename: string;
	frontmatter: Record<string, unknown>;
}

export interface MetadataRepairChange {
	path: string;
	updates: Record<string, string>;
}

export interface PeriodicFormatter {
	daily?: (start: Date) => string;
	weekly?: (start: Date) => string;
}

function looseText(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

/** Letters and digits only, for matching a title against a file slug. */
function slugKey(value: string): string {
	return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function stem(path: unknown): string {
	if (typeof path !== "string" || !path.trim()) return "";
	const name = path.split("/").pop() ?? "";
	return name.replace(/\.[^.]+$/, "");
}

export function meetingStart(fm: Record<string, unknown>): Date | null {
	const date = typeof fm.start_date === "string" ? fm.start_date.trim() : "";
	if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		const time = typeof fm.start_time === "string" && fm.start_time.trim() ? fm.start_time.trim() : "00:00";
		const parsed = new Date(`${date}T${time}`);
		if (!Number.isNaN(parsed.getTime())) return parsed;
	}
	if (typeof fm.start === "string") {
		const parsed = new Date(fm.start);
		if (!Number.isNaN(parsed.getTime())) return parsed;
	}
	return null;
}

export function planMetadataRepair(
	notes: MetadataRepairInput[],
	periodic: PeriodicFormatter
): MetadataRepairChange[] {
	const changes: MetadataRepairChange[] = [];
	for (const note of notes) {
		const fm = note.frontmatter;
		const updates: Record<string, string> = {};

		const title = fm.title;
		if (title !== undefined && title !== null) {
			const text = String(title);
			const recorderNames = [stem(fm.media_uri), stem(fm.audio), stem(fm.media), stem(fm.transcript_uri)]
				.filter(Boolean)
				.map(slugKey);
			const isRecorderName =
				typeof title !== "string" ||
				recorderNames.includes(slugKey(text)) ||
				looseText(text) === looseText(note.basename);
			if (isRecorderName && text !== note.basename) {
				updates.title = note.basename;
			}
		}

		const start = meetingStart(fm);
		if (start) {
			if (periodic.daily && typeof fm.daily_note === "string") {
				const daily = periodic.daily(start);
				if (daily && daily !== fm.daily_note) updates.daily_note = daily;
			}
			if (periodic.weekly && typeof fm.weekly_note === "string") {
				const weekly = periodic.weekly(start);
				if (weekly && weekly !== fm.weekly_note) updates.weekly_note = weekly;
			}
		}

		if (Object.keys(updates).length) changes.push({ path: note.path, updates });
	}
	return changes;
}

export function summarizeRepair(changes: MetadataRepairChange[]): string {
	const count = (key: string) => changes.filter((c) => key in c.updates).length;
	const parts = [
		[count("title"), "titles reset to the note's name"],
		[count("weekly_note"), "weekly note references"],
		[count("daily_note"), "daily note references"],
	]
		.filter(([n]) => (n as number) > 0)
		.map(([n, text]) => `${n} ${text}`);
	return parts.join(", ");
}
