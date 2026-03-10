import { Notice, TFile } from "obsidian";
import type AutomaticAudioNotes from "../../main";
import type { SidebarAttachment } from "../../transcript-view/types";
import { confirmWithModal } from "../../modals/ConfirmModal";

interface MeetingDeletionManagerContext {
	getMode(): "meeting" | "dashboard";
	getCurrentMeetingFile(): TFile | null;
	getCurrentAudioPath(): string | null;
	getCurrentTranscriptPath(): string | null;
	setDeleting(value: boolean): void;
	refreshAttachments(): Promise<SidebarAttachment[]>;
	clearTranscriptCache(path: string): void;
	showDashboard(): Promise<void>;
	scheduleDashboardRefresh(): void;
}

export class MeetingDeletionManager {
	constructor(
		private readonly plugin: AutomaticAudioNotes,
		private readonly context: MeetingDeletionManagerContext
	) {}

	async confirmDeleteCurrentMeeting(): Promise<void> {
		if (
			this.context.getMode() !== "meeting" ||
			!this.context.getCurrentMeetingFile()
		) {
			new Notice("Open a meeting note to delete it.", 4000);
			return;
		}
		const confirmed = await confirmWithModal(this.plugin.app, {
			title: "Delete meeting?",
			message:
				"This will permanently delete the note, linked transcript, audio file, and attachments.",
			confirmText: "Delete meeting",
			cancelText: "Cancel",
		});
		if (!confirmed) {
			return;
		}
		await this.deleteCurrentMeeting();
	}

	private async deleteCurrentMeeting(): Promise<void> {
		const meetingFile = this.context.getCurrentMeetingFile();
		if (!meetingFile) {
			return;
		}
		this.context.setDeleting(true);
		const failures: string[] = [];
		const deleteFileIfExists = async (
			path: string | null | undefined
		): Promise<void> => {
			if (!path || path === meetingFile.path) {
				return;
			}
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) {
				return;
			}
			try {
				await this.plugin.app.vault.delete(file);
			} catch (error) {
				console.error("Audio Notes: Failed to delete file", path, error);
				failures.push(path);
			}
		};
		try {
			let attachmentEntries: SidebarAttachment[] = [];
			try {
				attachmentEntries = await this.context.refreshAttachments();
			} catch (error) {
				console.error(
					"Audio Notes: Failed to refresh attachments prior to delete",
					error
				);
			}
			for (const attachment of attachmentEntries) {
				await deleteFileIfExists(attachment.path);
			}
			await deleteFileIfExists(this.context.getCurrentAudioPath());
			await deleteFileIfExists(this.context.getCurrentTranscriptPath());
			const transcriptPath = this.context.getCurrentTranscriptPath();
			if (transcriptPath) {
				this.context.clearTranscriptCache(transcriptPath);
			}
			await this.plugin.app.vault.delete(meetingFile);
			await this.context.showDashboard();
			this.context.scheduleDashboardRefresh();
			if (failures.length) {
				new Notice(
					`Meeting deleted, but some linked files could not be removed: ${failures.join(
						", "
					)}`,
					6000
				);
			} else {
				new Notice("Meeting deleted.", 4000);
			}
		} catch (error) {
			console.error("Audio Notes: Could not delete meeting", error);
			new Notice("Could not delete meeting.", 6000);
		} finally {
			this.context.setDeleting(false);
		}
	}
}
