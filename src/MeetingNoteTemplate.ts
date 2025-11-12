import type { AudioNotesSettings } from "./AudioNotesSettings";

export interface MeetingTemplateData {
	title: string;
	audioPath: string;
	transcriptPath?: string;
	start?: Date;
	end?: Date;
}

interface ResolvedMeetingContext {
	title: string;
	audioPath: string;
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

const TEMPLATE_CSS_CLASS = "aan-meeting-note";
const TEMPLATE_HIDE_PROPERTIES_CLASS = "aan-hide-properties";
const TEMPLATE_HIDE_INLINE_PLAYER_CLASS = "aan-hide-inline-player";

export function generateMeetingNoteContent(
	settings: AudioNotesSettings,
	data: MeetingTemplateData
): string {
	const context = resolveContext(settings, data);
	const frontmatter = buildFrontmatter(settings, context);

	if (!settings.meetingTemplateEnabled) {
		return `${frontmatter}\n\n${buildAudioBlock(context)}`;
	}

	const body = buildTemplateBody(context);
	return `${frontmatter}\n\n${body}`;
}

function resolveContext(
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
	context: ResolvedMeetingContext
): string {
	const lines = [
		"---",
		`title: ${yamlQuote(context.title)}`,
		`date: ${context.startDate}`,
		`media_uri: ${yamlQuote(context.audioPath)}`,
	];
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
	lines.push("---");
	return lines.join("\n");
}

function buildTemplateBody(context: ResolvedMeetingContext): string {
	const sections = [
		buildOverview(context),
		"",
		"## Notes",
		"- Capture decisions, summaries, or paste AI output here.",
	];
	return sections.join("\n");
}

function buildOverview(context: ResolvedMeetingContext): string {
	return [
		"> [!info] Schedule",
		`> - **When:** ${context.dateLabel}`,
		`> - **Time:** ${context.timeLabel}`,
		`> - **Duration:** ${context.durationLabel}`,
		`> - **Timezone:** ${context.timezone}`,
	].join("\n");
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

function formatPeriodicName(date: Date, format: string): string {
	if (!format) {
		return "";
	}
	const year = date.getFullYear();
	const month = (date.getMonth() + 1).toString().padStart(2, "0");
	const day = date.getDate().toString().padStart(2, "0");
	const { isoWeek, isoYear } = getIsoWeek(date);
	const replacements: Record<string, string> = {
		YYYY: year.toString(),
		MM: month,
		DD: day,
		WW: isoWeek,
		ww: isoWeek,
		gggg: isoYear,
	};
	let result = format;
	for (const [token, value] of Object.entries(replacements)) {
		const regex = new RegExp(token, "g");
		result = result.replace(regex, value);
	}
	return result;
}

function getIsoWeek(date: Date): { isoWeek: string; isoYear: string } {
	const temp = new Date(date.getTime());
	const dayNr = (temp.getDay() + 6) % 7;
	temp.setDate(temp.getDate() - dayNr + 3);
	const firstThursday = new Date(temp.getFullYear(), 0, 4);
	const firstThursdayDay = (firstThursday.getDay() + 6) % 7;
	firstThursday.setDate(firstThursday.getDate() - firstThursdayDay + 3);
	const week =
		1 + Math.round((temp.getTime() - firstThursday.getTime()) / 604800000);
	const isoYear = temp.getFullYear();
	return {
		isoWeek: week.toString().padStart(2, "0"),
		isoYear: isoYear.toString(),
	};
}

function yamlQuote(value: string): string {
	const needsQuotes = /[:#,{[\]\s]/.test(value);
	const escaped = value.replace(/"/g, '\\"');
	return needsQuotes ? `"${escaped}"` : escaped;
}
