import { Notice, type App, type TFile } from "obsidian";
import type AutomaticAudioNotes from "../../main";
import { AttendeePickerModal } from "../../AttendeePickerModal";
import {
	applyAttendeesToFile,
	getAttendeesFromFrontmatter,
	removeAttendeeFromFile,
} from "../../meeting-label-manager";

interface MeetingAttendeeManagerContext {
	getMode(): "meeting" | "dashboard";
	getCurrentMeetingFile(): TFile | null;
	getCurrentAttendees(): string[];
	setCurrentAttendees(attendees: string[]): void;
	refreshAttendeeDisplay(): void;
}

export class MeetingAttendeeManager {
	constructor(
		private readonly app: App,
		private readonly plugin: AutomaticAudioNotes,
		private readonly context: MeetingAttendeeManagerContext
	) {}

	public openAttendeePicker(): void {
		if (this.context.getMode() !== "meeting") {
			new Notice("Open a meeting note to manage attendees.", 4000);
			return;
		}
		const file = this.context.getCurrentMeetingFile();
		if (!file) {
			new Notice("Open a meeting note to manage attendees.", 4000);
			return;
		}

		const cache = this.app.metadataCache.getFileCache(file);
		const currentAttendees = getAttendeesFromFrontmatter(
			(cache?.frontmatter as Record<string, unknown> | undefined) ??
				undefined
		);

		const picker = new AttendeePickerModal(
			this.app,
			this.plugin,
			(name) => {
				void this.addAttendee(name);
			},
			{
				currentAttendees,
				onRemove: (name) => {
					void this.removeAttendee(name);
				},
			}
		);
		picker.open();
	}

	private async addAttendee(name: string): Promise<void> {
		const file = this.context.getCurrentMeetingFile();
		if (!file) return;
		try {
			const current = this.context.getCurrentAttendees();
			const exists = current.some(
				(a) => a.toLowerCase() === name.trim().toLowerCase()
			);
			if (exists) {
				new Notice(`${name} is already listed.`);
				return;
			}
			const updated = [...current, name.trim()];
			await applyAttendeesToFile(this.app, file, updated);
			this.context.setCurrentAttendees(updated);
			this.context.refreshAttendeeDisplay();
			new Notice(`Added attendee: ${name}`);
		} catch (error) {
			console.error(error);
			new Notice("Could not add attendee.", 6000);
		}
	}

	private async removeAttendee(name: string): Promise<void> {
		const file = this.context.getCurrentMeetingFile();
		if (!file) return;
		try {
			const remaining = await removeAttendeeFromFile(
				this.app,
				file,
				name
			);
			this.context.setCurrentAttendees(remaining);
			this.context.refreshAttendeeDisplay();
			new Notice(`Removed attendee: ${name}`);
		} catch (error) {
			console.error(error);
			new Notice("Could not remove attendee.", 6000);
		}
	}
}
