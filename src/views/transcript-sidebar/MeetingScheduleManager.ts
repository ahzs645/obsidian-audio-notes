import { Notice, type App, type TFile } from "obsidian";
import type AutomaticAudioNotes from "../../main";
import {
	buildScheduleCallout,
	resolveMeetingContext,
} from "../../MeetingNoteTemplate";
import {
	EditMeetingScheduleModal,
	type MeetingScheduleUpdate,
} from "../../modals/EditMeetingScheduleModal";
import type { MeetingScheduleInfo } from "./MeetingScheduleInfo";
import type { MeetingDateParts } from "./MeetingFileService";

interface MeetingScheduleContext {
	getMode(): "meeting" | "dashboard";
	getCurrentMeetingFile(): TFile | null;
	getCurrentMeetingDateParts(): MeetingDateParts | null;
	setCurrentMeetingDateParts(parts: MeetingDateParts | null): void;
	getCurrentAudioPath(): string | null;
	getCurrentTranscriptPath(): string | null;
	getMeetingTitle(): string;
	getCurrentScheduleInfo(): MeetingScheduleInfo | null;
	setCurrentScheduleInfo(info: MeetingScheduleInfo | null): void;
	updateHeaderSchedule(info: MeetingScheduleInfo | null, canEdit: boolean): void;
	refreshDashboardSchedule(): void;
}

export class MeetingScheduleManager {
	constructor(
		private readonly app: App,
		private readonly plugin: AutomaticAudioNotes,
		private readonly context: MeetingScheduleContext
	) {}

	public updateScheduleSummary(
		frontmatter?: Record<string, unknown> | null
	): void {
		const canEdit =
			this.context.getMode() === "meeting" &&
			Boolean(this.context.getCurrentMeetingFile());
		if (!canEdit) {
			this.context.setCurrentScheduleInfo(null);
			this.context.updateHeaderSchedule(null, false);
			return;
		}
		const source =
			frontmatter ??
			((this.context.getCurrentMeetingFile() &&
				(this.plugin.app.metadataCache.getFileCache(
					this.context.getCurrentMeetingFile()!
				)?.frontmatter as Record<string, unknown> | undefined)) ??
				null);
		const info = this.extractScheduleInfo(source);
		this.context.setCurrentScheduleInfo(info);
		this.context.updateHeaderSchedule(info, true);
	}

	public openScheduleEditor(): void {
		if (
			this.context.getMode() !== "meeting" ||
			!this.context.getCurrentMeetingFile()
		) {
			new Notice("Open a meeting note to edit its schedule.", 4000);
			return;
		}
		const info = this.context.getCurrentScheduleInfo();
		new EditMeetingScheduleModal(this.app, {
			initialStartDate: info?.startDate,
			initialStartTime: info?.startTime,
			initialEndDate: info?.endDate,
			initialEndTime: info?.endTime,
			onSubmit: (update) => {
				void this.applyScheduleUpdate(update);
			},
		}).open();
	}

	private async applyScheduleUpdate(
		update: MeetingScheduleUpdate
	): Promise<void> {
		const file = this.context.getCurrentMeetingFile();
		if (this.context.getMode() !== "meeting" || !file) {
			new Notice("Open a meeting note to edit its schedule.", 4000);
			return;
		}
		const start = this.combineDateAndTime(
			update.startDate,
			update.startTime
		);
		if (!start) {
			new Notice("Invalid start date or time.", 4000);
			return;
		}
		const endInput = this.combineDateAndTime(
			update.endDate || update.startDate,
			update.endTime || update.startTime
		);
		const end =
			endInput && endInput.getTime() >= start.getTime()
				? endInput
				: new Date(start.getTime() + 60 * 60 * 1000);
		const startDateStr = this.formatFrontmatterDate(start);
		const endDateStr = this.formatFrontmatterDate(end);
		const startTimeStr = this.formatFrontmatterTime(start);
		const endTimeStr = this.formatFrontmatterTime(end);
		try {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				fm.start = start.toISOString();
				fm.end = end.toISOString();
				fm.start_date = startDateStr;
				fm.start_time = startTimeStr;
				fm.end_date = endDateStr;
				fm.end_time = endTimeStr;
				fm.date = startDateStr;
			});
			this.context.setCurrentMeetingDateParts({
				year: startDateStr.slice(0, 4),
				month: startDateStr.slice(5, 7),
				day: startDateStr.slice(8, 10),
			});
			const updatedFrontmatter = {
				start_date: startDateStr,
				start_time: startTimeStr,
				end_date: endDateStr,
				end_time: endTimeStr,
				start: start.toISOString(),
				end: end.toISOString(),
			};
			this.updateScheduleSummary(updatedFrontmatter);
			await this.refreshScheduleCallout(start, end);
			this.context.refreshDashboardSchedule();
			new Notice("Meeting schedule updated.", 4000);
		} catch (error) {
			console.error(
				"Audio Notes: Could not update meeting schedule.",
				error
			);
			new Notice("Could not update meeting schedule.", 6000);
		}
	}

	private extractScheduleInfo(
		frontmatter?: Record<string, unknown> | null
	): MeetingScheduleInfo | null {
		if (!frontmatter) {
			return null;
		}
		const start =
			this.parseDateTime(
				this.normalizeDateValue(frontmatter["start_date"]),
				this.normalizeTimeValue(frontmatter["start_time"])
			) ?? this.parseIsoDate(frontmatter["start"]);
		if (!start) {
			return null;
		}
		const end =
			this.parseDateTime(
				this.normalizeDateValue(
					frontmatter["end_date"] ?? frontmatter["start_date"]
				),
				this.normalizeTimeValue(
					frontmatter["end_time"] ?? frontmatter["start_time"]
				)
			) ?? this.parseIsoDate(frontmatter["end"]) ?? start;
		const context = resolveMeetingContext(this.plugin.settings, {
			title: this.context.getMeetingTitle(),
			audioPath: this.context.getCurrentAudioPath() ?? "",
			transcriptPath: this.context.getCurrentTranscriptPath() ?? undefined,
			start,
			end,
		});
		return {
			start,
			end,
			startDate: context.startDate,
			startTime: context.startTime,
			endDate: context.endDate,
			endTime: context.endTime,
			dateLabel: context.dateLabel,
			timeLabel: context.timeLabel,
		};
	}

	private normalizeDateValue(value: unknown): string | null {
		if (typeof value === "string" && value.trim().length) {
			return value.trim();
		}
		return null;
	}

	private normalizeTimeValue(value: unknown): string | null {
		if (typeof value === "string" && value.trim().length) {
			return value.trim();
		}
		return null;
	}

	private parseDateTime(
		dateStr?: string | null,
		timeStr?: string | null
	): Date | null {
		if (!dateStr) {
			return null;
		}
		const timePart =
			timeStr && timeStr.trim().length ? timeStr.trim() : "00:00";
		const iso = `${dateStr}T${timePart}`;
		const parsed = new Date(iso);
		return Number.isNaN(parsed.getTime()) ? null : parsed;
	}

	private parseIsoDate(value: unknown): Date | null {
		if (typeof value !== "string" || !value.trim().length) {
			return null;
		}
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? null : parsed;
	}

	private combineDateAndTime(
		dateStr?: string,
		timeStr?: string
	): Date | null {
		if (!dateStr) {
			return null;
		}
		const timePart =
			timeStr && timeStr.trim().length ? timeStr.trim() : "00:00";
		const iso = `${dateStr}T${timePart}`;
		const parsed = new Date(iso);
		return Number.isNaN(parsed.getTime()) ? null : parsed;
	}

	private formatFrontmatterDate(date: Date): string {
		const year = date.getFullYear().toString().padStart(4, "0");
		const month = (date.getMonth() + 1).toString().padStart(2, "0");
		const day = date.getDate().toString().padStart(2, "0");
		return `${year}-${month}-${day}`;
	}

	private formatFrontmatterTime(date: Date): string {
		const hours = date.getHours().toString().padStart(2, "0");
		const minutes = date.getMinutes().toString().padStart(2, "0");
		return `${hours}:${minutes}`;
	}

	private async refreshScheduleCallout(
		start: Date,
		end: Date
	): Promise<void> {
		const file = this.context.getCurrentMeetingFile();
		if (!file) {
			return;
		}
		try {
			const content = await this.app.vault.read(file);
			const lines = content.split("\n");
			const scheduleIndex = lines.findIndex((line) =>
				line.trim().startsWith("> [!info] Schedule")
			);
			if (scheduleIndex === -1) {
				return;
			}
			let endIndex = scheduleIndex + 1;
			while (
				endIndex < lines.length &&
				lines[endIndex].trim().startsWith(">")
			) {
				endIndex += 1;
			}
			const context = resolveMeetingContext(this.plugin.settings, {
				title: file.basename,
				audioPath: this.context.getCurrentAudioPath() ?? "",
				transcriptPath: this.context.getCurrentTranscriptPath() ?? undefined,
				start,
				end,
			});
			const replacement = buildScheduleCallout(context).split("\n");
			lines.splice(
				scheduleIndex,
				Math.max(endIndex - scheduleIndex, 1),
				...replacement
			);
			await this.app.vault.modify(file, lines.join("\n"));
		} catch (error) {
			console.error(
				"Audio Notes: Could not refresh schedule callout.",
				error
			);
		}
	}
}
