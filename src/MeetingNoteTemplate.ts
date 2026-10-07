import { moment } from "obsidian";
import type { AudioNotesSettings } from "./AudioNotesSettings";

export interface MeetingTemplateData {
	title: string;
	audioPath?: string;
	transcriptPath?: string;
	start?: Date;
	end?: Date;
	extraFrontmatter?: Record<string, unknown>;
}

export interface ResolvedMeetingContext {
	title: string;
	audioPath?: string;
	transcriptPath?: string;
	start: Date;
	end: Date;
	startIso: string;
	endIso: string;
	startDate: string;
	endDate: string;
	startTime: string;
	endTime: string;
	dateLabel: string;
	timeLabel: string;
	durationLabel: string;
	timezone: string;
	periodicDaily?: string;
	periodicWeekly?: string;
}

export const NOTES_PLACEHOLDER_LINE =
	"- Capture decisions, summaries, or paste AI output here.";

const TEMPLATE_CSS_CLASS = "aan-meeting-note";
const TEMPLATE_HIDE_PROPERTIES_CLASS = "aan-hide-properties";
const TEMPLATE_HIDE_INLINE_PLAYER_CLASS = "aan-hide-inline-player";

export function generateMeetingNoteContent(
	settings: AudioNotesSettings,
	data: MeetingTemplateData
): string {
	const context = resolveMeetingContext(settings, data);
	const frontmatter = buildFrontmatter(
		settings,
		context,
		data.extraFrontmatter
	);

	if (!settings.meetingTemplateEnabled) {
		const audioBlock = buildAudioBlock(context);
		return audioBlock ? `${frontmatter}\n\n${audioBlock}` : frontmatter;
	}

	const body = buildTemplateBody(context);
	return `${frontmatter}\n\n${body}`;
}

export function resolveMeetingContext(
	settings: AudioNotesSettings,
	data: MeetingTemplateData
): ResolvedMeetingContext {
	const start = data.start ? new Date(data.start) : new Date();
	const endCandidate = data.end ? new Date(data.end) : new Date(start);
	const end = endCandidate.getTime() >= start.getTime() ? endCandidate : start;

	const startIso = start.toISOString();
	const endIso = end.toISOString();
	const timezone =
		Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	const startParts = formatDateTimeParts(start, timezone);
	const endParts = formatDateTimeParts(end, timezone);
	const startDate = startParts.date;
	const endDate = endParts.date;
	const startTime = startParts.time;
	const endTime = endParts.time;
	const dateFormatter = new Intl.DateTimeFormat(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: timezone,
	});
	const sameDay = startDate === endDate;
	const dateLabel = sameDay
		? dateFormatter.format(start)
		: `${dateFormatter.format(start)} → ${dateFormatter.format(end)}`;
	const timeLabel = formatTimeRange(start, end, timezone);
	const durationLabel = formatDuration(end.getTime() - start.getTime());
	const periodicDaily = settings.periodicDailyNoteEnabled
		? formatPeriodicName(start, settings.periodicDailyNoteFormat)
		: undefined;
	const periodicWeekly = settings.periodicWeeklyNoteEnabled
		? formatPeriodicName(start, settings.periodicWeeklyNoteFormat)
		: undefined;

	return {
		title: data.title,
		audioPath: data.audioPath,
		transcriptPath: data.transcriptPath,
		start,
		end,
		startIso,
		endIso,
		startDate,
		endDate,
		startTime,
		endTime,
		dateLabel,
		timeLabel,
		durationLabel,
		timezone,
		periodicDaily,
		periodicWeekly,
	};
}

function buildFrontmatter(
	settings: AudioNotesSettings,
	context: ResolvedMeetingContext,
	extra?: Record<string, unknown>
): string {
	const lines = [
		"---",
		`title: ${yamlQuote(context.title)}`,
		`date: ${context.startDate}`,
	];
	if (context.audioPath) {
		lines.push(`media_uri: ${yamlQuote(context.audioPath)}`);
	}
	if (context.transcriptPath) {
		lines.push(`transcript_uri: ${yamlQuote(context.transcriptPath)}`);
	}
	lines.push(
		`start: ${context.startIso}`,
		`end: ${context.endIso}`,
		`start_date: ${context.startDate}`,
		`start_time: ${context.startTime}`,
		`end_date: ${context.endDate}`,
		`end_time: ${context.endTime}`,
		"tags: [meeting]"
	);

	if (settings.meetingTemplateEnabled) {
		lines.push("cssclasses:");
		lines.push(`  - ${TEMPLATE_CSS_CLASS}`);
		lines.push(`  - ${TEMPLATE_HIDE_PROPERTIES_CLASS}`);
		lines.push(`  - ${TEMPLATE_HIDE_INLINE_PLAYER_CLASS}`);
	}
	if (context.periodicDaily) {
		lines.push(`daily_note: ${yamlQuote(context.periodicDaily)}`);
	}
	if (context.periodicWeekly) {
		lines.push(`weekly_note: ${yamlQuote(context.periodicWeekly)}`);
	}
	if (extra) {
		for (const [key, value] of Object.entries(extra)) {
			if (!key) continue;
			if (typeof value === "string") {
				lines.push(`${key}: ${yamlQuote(value)}`);
			} else if (
				typeof value === "number" ||
				typeof value === "boolean"
			) {
				lines.push(`${key}: ${value}`);
			} else if (value === null) {
				lines.push(`${key}: null`);
			}
		}
	}
	lines.push("---");
	return lines.join("\n");
}

function buildTemplateBody(context: ResolvedMeetingContext): string {
	const sections = [
		buildScheduleCallout(context),
		"",
		"## Notes",
		NOTES_PLACEHOLDER_LINE,
	];
	return sections.join("\n");
}

export function buildScheduleCallout(
	context: ResolvedMeetingContext
): string {
	return [
		"> [!info] Schedule",
		`> - **When:** ${context.dateLabel}`,
		`> - **Time:** ${context.timeLabel}`,
		`> - **Duration:** ${context.durationLabel}`,
		`> - **Timezone:** ${context.timezone}`,
	].join("\n");
}

/**
 * Swaps the body's "> [!info] Schedule" callout for a new one. Only the
 * callout's own bullets are replaced, so a quote right after it survives.
 * Returns the content unchanged when the note has no schedule callout.
 */
export function replaceScheduleCallout(content: string, callout: string): string {
	const lines = content.split("\n");
	const index = lines.findIndex((line) => line.trim().startsWith("> [!info] Schedule"));
	if (index === -1) return content;
	let end = index + 1;
	while (
		end < lines.length &&
		/^>\s*-\s+\*\*(When|Time|Duration|Timezone):\*\*/.test(lines[end].trim())
	) {
		end += 1;
	}
	lines.splice(index, end - index, ...callout.split("\n"));
	return lines.join("\n");
}

function formatTimeRange(
	start: Date,
	end: Date,
	timezone: string
): string {
	const formatter = new Intl.DateTimeFormat(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		timeZone: timezone,
	});
	const startLabel = formatter.format(start);
	const endLabel = formatter.format(end);
	const tzAbbr = formatTimezoneAbbreviation(timezone, start);
	return tzAbbr
		? `${startLabel} → ${endLabel} (${tzAbbr})`
		: `${startLabel} → ${endLabel}`;
}

function formatTimezoneAbbreviation(
	timezone: string,
	reference: Date
): string | undefined {
	try {
		const formatter = new Intl.DateTimeFormat(undefined, {
			timeZone: timezone,
			hour: "2-digit",
			minute: "2-digit",
			timeZoneName: "short",
		});
		const parts = formatter.formatToParts(reference);
		return parts.find((part) => part.type === "timeZoneName")?.value;
	} catch {
		return undefined;
	}
}

function formatDateTimeParts(
	date: Date,
	timezone: string
): { date: string; time: string } {
	try {
		const dateFormatter = new Intl.DateTimeFormat("en-CA", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		});
		const timeFormatter = new Intl.DateTimeFormat("en-CA", {
			timeZone: timezone,
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		});
		const dateParts = dateFormatter.formatToParts(date);
		const timeParts = timeFormatter.formatToParts(date);
		const year =
			dateParts.find((part) => part.type === "year")?.value ?? "0000";
		const month =
			dateParts.find((part) => part.type === "month")?.value ?? "00";
		const day =
			dateParts.find((part) => part.type === "day")?.value ?? "00";
		const hour =
			timeParts.find((part) => part.type === "hour")?.value ?? "00";
		const minute =
			timeParts.find((part) => part.type === "minute")?.value ?? "00";
		const second =
			timeParts.find((part) => part.type === "second")?.value ?? "00";
		return {
			date: `${year}-${month}-${day}`,
			time: `${hour}:${minute}:${second}`,
		};
	} catch {
		const iso = date.toISOString();
		return {
			date: iso.slice(0, 10),
			time: iso.slice(11, 19),
		};
	}
}

function buildAudioBlock(context: ResolvedMeetingContext): string {
	if (!context.audioPath) {
		return "";
	}
	const lines = [
		"```audio-note",
		`title: ${context.title}`,
		`audio: ${context.audioPath}`,
	];
	if (context.transcriptPath) {
		lines.push(`transcript: ${context.transcriptPath}`);
	}
	lines.push("liveUpdate: true", "---", "```");
	return lines.join("\n");
}

function formatDuration(durationMs: number): string {
	if (!Number.isFinite(durationMs) || durationMs <= 0) {
		return "—";
	}
	const totalMinutes = Math.round(durationMs / 60000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (!hours) {
		return `${minutes}m`;
	}
	if (!minutes) {
		return `${hours}h`;
	}
	return `${hours}h ${minutes}m`;
}

/**
 * Formats a periodic-note name with moment, as Periodic Notes does. Older
 * settings quoted literals the SQL way ("gggg-'W'WW"), which moment prints
 * verbatim, so those quotes become moment's [W] brackets first.
 */
export function formatPeriodicName(date: Date, format: string): string {
	if (!format) {
		return "";
	}
	// Obsidian's typings export the moment namespace; the value is callable.
	const callMoment = moment as unknown as (input: Date) => { format(pattern: string): string };
	return callMoment(date).format(normalizePeriodicFormat(format));
}

export function normalizePeriodicFormat(format: string): string {
	return format.replace(/'([^']*)'/g, "[$1]");
}

/**
 * Leaves plain words bare and double-quotes anything YAML would read as a
 * number, boolean, null, date or syntax ("4" must stay the string "4").
 */
export function yamlQuote(value: string): string {
	const plain =
		/^[A-Za-z_][\w ./()+&'-]*$/.test(value) &&
		!/^(true|false|yes|no|on|off|null|~)$/i.test(value) &&
		!/\s$/.test(value);
	return plain ? value : JSON.stringify(value);
}
