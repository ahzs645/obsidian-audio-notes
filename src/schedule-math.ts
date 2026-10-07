/**
 * Date/time arithmetic for the schedule editors. Dates are "YYYY-MM-DD" and
 * times "HH:mm" or "HH:mm:ss", both local, matching meeting frontmatter.
 *
 * The editors treat a meeting as a start plus a length: moving the start
 * carries the end along, so changing 11:30 → 12:00 on a 30 minute meeting
 * gives 12:00 → 12:30 instead of leaving the old end behind.
 */

export interface ScheduleFields {
	startDate: string;
	startTime: string;
	endDate: string;
	endTime: string;
}

const DEFAULT_LENGTH_MS = 60 * 60 * 1000;

export function combineLocal(date: string, time: string): Date | null {
	const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec((date ?? "").trim());
	if (!dateMatch) return null;
	const timeMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec((time ?? "").trim() || "00:00");
	if (!timeMatch) return null;
	const value = new Date(
		Number(dateMatch[1]),
		Number(dateMatch[2]) - 1,
		Number(dateMatch[3]),
		Number(timeMatch[1]),
		Number(timeMatch[2]),
		Number(timeMatch[3] ?? 0)
	);
	return Number.isNaN(value.getTime()) ? null : value;
}

export function splitLocal(value: Date): { date: string; time: string } {
	const pad = (n: number) => String(n).padStart(2, "0");
	const date = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
	const seconds = value.getSeconds();
	const time = `${pad(value.getHours())}:${pad(value.getMinutes())}${seconds ? `:${pad(seconds)}` : ""}`;
	return { date, time };
}

/** Length in ms, or null when either end is unparseable. May be ≤ 0. */
export function scheduleLengthMs(fields: ScheduleFields): number | null {
	const start = combineLocal(fields.startDate, fields.startTime);
	const end = combineLocal(fields.endDate || fields.startDate, fields.endTime);
	if (!start || !end) return null;
	return end.getTime() - start.getTime();
}

function withEnd(fields: ScheduleFields, start: Date, lengthMs: number): ScheduleFields {
	const end = splitLocal(new Date(start.getTime() + lengthMs));
	const begin = splitLocal(start);
	return {
		startDate: begin.date,
		startTime: fields.startTime && /:\d{2}:\d{2}/.test(fields.startTime) ? fields.startTime : begin.time,
		endDate: end.date,
		endTime: end.time,
	};
}

/**
 * Applies a new start date and/or time, keeping the meeting's length.
 * A meeting with no usable length (end missing or before start) gets an hour.
 */
export function moveStart(
	fields: ScheduleFields,
	next: { startDate?: string; startTime?: string }
): ScheduleFields {
	const length = scheduleLengthMs(fields);
	const updated = { ...fields, ...next };
	const start = combineLocal(updated.startDate, updated.startTime);
	if (!start) return updated;
	return withEnd(updated, start, length && length > 0 ? length : DEFAULT_LENGTH_MS);
}

/**
 * Applies a new end. On a same-day meeting the end date follows the start
 * date; a multi-day meeting keeps whatever end date was chosen.
 */
export function setEnd(
	fields: ScheduleFields,
	next: { endDate?: string; endTime?: string },
	multiDay: boolean
): ScheduleFields {
	const updated = { ...fields, ...next };
	if (!multiDay) updated.endDate = updated.startDate;
	return updated;
}

/** Sets the end to start + minutes (may cross midnight). */
export function setLengthMinutes(fields: ScheduleFields, minutes: number): ScheduleFields {
	const start = combineLocal(fields.startDate, fields.startTime);
	if (!start || !(minutes > 0)) return fields;
	return withEnd(fields, start, minutes * 60_000);
}

/** A reason the schedule can't be saved, or null when it's fine. */
export function validateSchedule(fields: ScheduleFields): string | null {
	if (!combineLocal(fields.startDate, fields.startTime)) return "Pick a start date and time.";
	const length = scheduleLengthMs(fields);
	if (length === null) return "Pick an end time.";
	if (length <= 0) return "The meeting ends before it starts.";
	return null;
}

export function formatLength(ms: number | null): string {
	if (ms === null || !(ms > 0)) return "";
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours}h ${rest}m` : `${hours}h`;
}
