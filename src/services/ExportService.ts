import { type App, TFile } from "obsidian";
import type AutomaticAudioNotes from "../main";
import {
	collectMeetingEvents,
	type MeetingEvent,
} from "../meeting-events";
import type { Transcript } from "../Transcript";
import type { MeetingLabelCategory, MeetingLabelInfo } from "../meeting-labels";

export type ExportFormat = "markdown" | "json" | "text";
export type ExportStructure = "single" | "multiple";
export type ExportContent = "notes" | "transcripts" | "both";

export interface ExportOptions {
	format: ExportFormat;
	structure: ExportStructure;
	content: ExportContent;
	categoryFilter: string | null; // null means all categories
	dateRange: {
		start: Date | null;
		end: Date | null;
	};
	includeMetadata: boolean;
}

export interface ExportedMeeting {
	event: MeetingEvent;
	file: TFile;
	noteContent: string;
	transcript: Transcript | undefined;
}

export interface ExportResult {
	filename: string;
	content: string;
}

export class ExportService {
	constructor(
		private app: App,
		private plugin: AutomaticAudioNotes
	) {}

	async collectMeetingsForExport(options: ExportOptions): Promise<ExportedMeeting[]> {
		const events = collectMeetingEvents(
			this.app,
			this.plugin.settings.calendarTagColors || {},
			this.plugin.settings.meetingLabelCategories
		);

		const filtered = events.filter((event) => {
			// Filter by category
			if (options.categoryFilter !== null) {
				if (!event.label?.tag?.startsWith(options.categoryFilter)) {
					// Also check if category filter is "uncategorized" and event has no label
					if (options.categoryFilter !== "uncategorized" || event.label) {
						return false;
					}
				}
			}

			// Filter by date range
			if (options.dateRange.start && event.start < options.dateRange.start) {
				return false;
			}
			if (options.dateRange.end) {
				const endOfDay = new Date(options.dateRange.end);
				endOfDay.setHours(23, 59, 59, 999);
				if (event.start > endOfDay) {
					return false;
				}
			}

			return true;
		});

		const exportedMeetings: ExportedMeeting[] = [];

		for (const event of filtered) {
			const file = this.app.vault.getAbstractFileByPath(event.path);
			if (file instanceof TFile) {
				const noteContent = await this.app.vault.cachedRead(file);

				// Get transcript if available
				const cache = this.app.metadataCache.getFileCache(file);
				const transcriptUri = cache?.frontmatter?.transcript_uri;
				let transcript: Transcript | undefined;

				if (transcriptUri) {
					transcript = await this.plugin.transcriptDatastore.getTranscript(transcriptUri);
				}

				exportedMeetings.push({
					event,
					file,
					noteContent,
					transcript,
				});
			}
		}

		return exportedMeetings;
	}

	async exportMeetings(
		meetings: ExportedMeeting[],
		options: ExportOptions
	): Promise<ExportResult[]> {
		if (options.structure === "single") {
			return [this.exportAsSingleFile(meetings, options)];
		} else {
			return this.exportAsMultipleFiles(meetings, options);
		}
	}

	private exportAsSingleFile(
		meetings: ExportedMeeting[],
		options: ExportOptions
	): ExportResult {
		const parts: string[] = [];
		const timestamp = this.formatDateForFilename(new Date());

		switch (options.format) {
			case "markdown":
				parts.push(this.generateMarkdownHeader(meetings, options));
				for (const meeting of meetings) {
					parts.push(this.formatMeetingAsMarkdown(meeting, options));
				}
				return {
					filename: `audio-notes-export-${timestamp}.md`,
					content: parts.join("\n\n---\n\n"),
				};

			case "json":
				const jsonData = {
					exportDate: new Date().toISOString(),
					totalMeetings: meetings.length,
					options: {
						content: options.content,
						categoryFilter: options.categoryFilter,
						dateRange: {
							start: options.dateRange.start?.toISOString() || null,
							end: options.dateRange.end?.toISOString() || null,
						},
					},
					meetings: meetings.map((m) => this.formatMeetingAsJson(m, options)),
				};
				return {
					filename: `audio-notes-export-${timestamp}.json`,
					content: JSON.stringify(jsonData, null, 2),
				};

			case "text":
				parts.push(this.generateTextHeader(meetings, options));
				for (const meeting of meetings) {
					parts.push(this.formatMeetingAsText(meeting, options));
				}
				return {
					filename: `audio-notes-export-${timestamp}.txt`,
					content: parts.join("\n\n========================================\n\n"),
				};

			default:
				throw new Error(`Unknown export format: ${options.format}`);
		}
	}

	private exportAsMultipleFiles(
		meetings: ExportedMeeting[],
		options: ExportOptions
	): ExportResult[] {
		return meetings.map((meeting) => {
			const safeName = this.sanitizeFilename(meeting.event.title);
			const date = this.formatDateForFilename(meeting.event.start);

			switch (options.format) {
				case "markdown":
					return {
						filename: `${date}-${safeName}.md`,
						content: this.formatMeetingAsMarkdown(meeting, options),
					};

				case "json":
					return {
						filename: `${date}-${safeName}.json`,
						content: JSON.stringify(
							this.formatMeetingAsJson(meeting, options),
							null,
							2
						),
					};

				case "text":
					return {
						filename: `${date}-${safeName}.txt`,
						content: this.formatMeetingAsText(meeting, options),
					};

				default:
					throw new Error(`Unknown export format: ${options.format}`);
			}
		});
	}

	private formatMeetingAsMarkdown(
		meeting: ExportedMeeting,
		options: ExportOptions
	): string {
		const parts: string[] = [];

		// Header with title
		parts.push(`# ${meeting.event.title}`);

		// Metadata
		if (options.includeMetadata) {
			parts.push("");
			parts.push(`**Date:** ${meeting.event.displayDate}`);
			if (meeting.event.label) {
				parts.push(`**Category:** ${meeting.event.label.displayName}`);
			}
			if (meeting.event.tags.length > 0) {
				parts.push(`**Tags:** ${meeting.event.tags.map(t => `#${t}`).join(", ")}`);
			}
		}

		// Note content
		if (options.content === "notes" || options.content === "both") {
			parts.push("");
			parts.push("## Notes");
			parts.push("");
			// Strip frontmatter from note content
			const noteWithoutFrontmatter = this.stripFrontmatter(meeting.noteContent);
			parts.push(noteWithoutFrontmatter);
		}

		// Transcript
		if ((options.content === "transcripts" || options.content === "both") && meeting.transcript) {
			parts.push("");
			parts.push("## Transcript");
			parts.push("");
			parts.push(this.formatTranscriptAsMarkdown(meeting.transcript));
		}

		return parts.join("\n");
	}

	private formatMeetingAsJson(
		meeting: ExportedMeeting,
		options: ExportOptions
	): Record<string, unknown> {
		const result: Record<string, unknown> = {
			title: meeting.event.title,
			date: meeting.event.start.toISOString(),
			displayDate: meeting.event.displayDate,
			path: meeting.event.path,
		};

		if (options.includeMetadata) {
			result.category = meeting.event.label?.displayName || null;
			result.categoryTag = meeting.event.label?.tag || null;
			result.tags = meeting.event.tags;
		}

		if (options.content === "notes" || options.content === "both") {
			result.notes = this.stripFrontmatter(meeting.noteContent);
		}

		if (options.content === "transcripts" || options.content === "both") {
			if (meeting.transcript) {
				result.transcript = {
					text: meeting.transcript.getEntireTranscript(),
					segments: meeting.transcript.segments.map((s) => ({
						id: s.id,
						start: s.start,
						end: s.end,
						text: s.text,
						speaker: s.speakerName || s.speakerLabel || null,
					})),
				};
			} else {
				result.transcript = null;
			}
		}

		return result;
	}

	private formatMeetingAsText(
		meeting: ExportedMeeting,
		options: ExportOptions
	): string {
		const parts: string[] = [];

		// Header
		parts.push(meeting.event.title.toUpperCase());
		parts.push("=".repeat(meeting.event.title.length));

		// Metadata
		if (options.includeMetadata) {
			parts.push("");
			parts.push(`Date: ${meeting.event.displayDate}`);
			if (meeting.event.label) {
				parts.push(`Category: ${meeting.event.label.displayName}`);
			}
			if (meeting.event.tags.length > 0) {
				parts.push(`Tags: ${meeting.event.tags.join(", ")}`);
			}
		}

		// Note content
		if (options.content === "notes" || options.content === "both") {
			parts.push("");
			parts.push("NOTES");
			parts.push("-----");
			parts.push("");
			// Strip frontmatter and convert markdown to plain text
			const noteWithoutFrontmatter = this.stripFrontmatter(meeting.noteContent);
			parts.push(this.stripMarkdown(noteWithoutFrontmatter));
		}

		// Transcript
		if ((options.content === "transcripts" || options.content === "both") && meeting.transcript) {
			parts.push("");
			parts.push("TRANSCRIPT");
			parts.push("----------");
			parts.push("");
			parts.push(meeting.transcript.getEntireTranscript());
		}

		return parts.join("\n");
	}

	private formatTranscriptAsMarkdown(transcript: Transcript): string {
		const segments = transcript.segments;
		const parts: string[] = [];

		for (const segment of segments) {
			const timestamp = this.formatTimestamp(segment.start);
			const speaker = segment.speakerName || segment.speakerLabel;

			if (speaker) {
				parts.push(`**[${timestamp}] ${speaker}:** ${segment.text}`);
			} else {
				parts.push(`**[${timestamp}]** ${segment.text}`);
			}
		}

		return parts.join("\n\n");
	}

	private generateMarkdownHeader(
		meetings: ExportedMeeting[],
		options: ExportOptions
	): string {
		const lines: string[] = [];
		lines.push("# Audio Notes Export");
		lines.push("");
		lines.push(`**Export Date:** ${new Date().toLocaleDateString()}`);
		lines.push(`**Total Meetings:** ${meetings.length}`);

		if (options.categoryFilter) {
			lines.push(`**Category Filter:** ${options.categoryFilter}`);
		}

		if (options.dateRange.start || options.dateRange.end) {
			const start = options.dateRange.start?.toLocaleDateString() || "Any";
			const end = options.dateRange.end?.toLocaleDateString() || "Any";
			lines.push(`**Date Range:** ${start} to ${end}`);
		}

		lines.push(`**Content:** ${options.content}`);

		return lines.join("\n");
	}

	private generateTextHeader(
		meetings: ExportedMeeting[],
		options: ExportOptions
	): string {
		const lines: string[] = [];
		lines.push("AUDIO NOTES EXPORT");
		lines.push("==================");
		lines.push("");
		lines.push(`Export Date: ${new Date().toLocaleDateString()}`);
		lines.push(`Total Meetings: ${meetings.length}`);

		if (options.categoryFilter) {
			lines.push(`Category Filter: ${options.categoryFilter}`);
		}

		if (options.dateRange.start || options.dateRange.end) {
			const start = options.dateRange.start?.toLocaleDateString() || "Any";
			const end = options.dateRange.end?.toLocaleDateString() || "Any";
			lines.push(`Date Range: ${start} to ${end}`);
		}

		lines.push(`Content: ${options.content}`);

		return lines.join("\n");
	}

	private stripFrontmatter(content: string): string {
		const frontmatterRegex = /^---\n[\s\S]*?\n---\n*/;
		return content.replace(frontmatterRegex, "").trim();
	}

	private stripMarkdown(content: string): string {
		return content
			// Remove headers
			.replace(/^#{1,6}\s+/gm, "")
			// Remove bold/italic
			.replace(/\*\*([^*]+)\*\*/g, "$1")
			.replace(/\*([^*]+)\*/g, "$1")
			.replace(/__([^_]+)__/g, "$1")
			.replace(/_([^_]+)_/g, "$1")
			// Remove links but keep text
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
			// Remove images
			.replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
			// Remove code blocks
			.replace(/```[\s\S]*?```/g, "")
			.replace(/`([^`]+)`/g, "$1")
			// Remove blockquotes
			.replace(/^>\s+/gm, "")
			// Remove horizontal rules
			.replace(/^---+$/gm, "")
			// Clean up extra whitespace
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	}

	private formatTimestamp(seconds: number): string {
		const mins = Math.floor(seconds / 60);
		const secs = Math.floor(seconds % 60);
		return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
	}

	private formatDateForFilename(date: Date): string {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		return `${year}-${month}-${day}`;
	}

	private sanitizeFilename(name: string): string {
		return name
			.replace(/[<>:"/\\|?*]/g, "-")
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.substring(0, 50);
	}

	getAvailableCategories(): Array<{ id: string; name: string; tagPrefix: string }> {
		const categories = this.plugin.settings.meetingLabelCategories || [];
		return [
			{ id: "all", name: "All Categories", tagPrefix: "" },
			{ id: "uncategorized", name: "Uncategorized", tagPrefix: "uncategorized" },
			...categories.map((c) => ({
				id: c.id,
				name: c.name,
				tagPrefix: c.tagPrefix,
			})),
		];
	}
}
