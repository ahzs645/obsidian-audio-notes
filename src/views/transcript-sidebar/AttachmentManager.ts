import { Notice, TFile, TFolder } from "obsidian";
import type AutomaticAudioNotes from "../../main";
import type { SidebarAttachment } from "../../transcript-view/types";
import type { MeetingFileService } from "./MeetingFileService";

export class AttachmentManager {
	private attachmentFolderPath: string | null = null;
	private currentAudioPath: string | null = null;
	private meetingFilePath: string | null = null;
	private attachments: SidebarAttachment[] = [];

	constructor(
		private readonly plugin: AutomaticAudioNotes,
		private readonly fileService: MeetingFileService
	) {}

	async setAttachmentFolder(path: string | null): Promise<void> {
		if (this.attachmentFolderPath === path) {
			return;
		}
		if (
			this.attachmentFolderPath &&
			path &&
			this.attachmentFolderPath !== path
		) {
			await this.migrateAttachments(this.attachmentFolderPath, path);
		}
		this.attachmentFolderPath = path;
	}

	getAttachmentFolder(): string | null {
		return this.attachmentFolderPath;
	}

	setMeetingFilePath(path: string | null) {
		this.meetingFilePath = path;
	}

	setAudioPath(path: string | null) {
		this.currentAudioPath = path;
	}

	reset() {
		this.attachmentFolderPath = null;
		this.currentAudioPath = null;
		this.meetingFilePath = null;
		this.attachments = [];
	}

	hasAttachmentSupport(): boolean {
		return Boolean(this.attachmentFolderPath);
	}

	async refresh(): Promise<SidebarAttachment[]> {
		let attachments: SidebarAttachment[] = [];
		if (this.attachmentFolderPath) {
			const meetingParent =
				this.meetingFilePath?.split("/").slice(0, -1).join("/") || null;
			const skipMarkdownInFolder =
				meetingParent &&
				meetingParent === this.attachmentFolderPath;
			const folder = this.plugin.app.vault.getAbstractFileByPath(
				this.attachmentFolderPath
			);
			if (folder instanceof TFolder) {
				attachments = folder.children
					.filter((child): child is TFile => child instanceof TFile)
					.filter((file) => file.path !== this.currentAudioPath)
					.filter((file) => file.path !== this.meetingFilePath)
					.filter((file) =>
						skipMarkdownInFolder ? file.extension !== "md" : true
					)
					.map((file) => ({
						path: file.path,
						name: file.name,
						extension: file.extension ?? "",
						size: this.formatFileSize(file.stat?.size ?? 0),
					}))
					.sort((a, b) => a.name.localeCompare(b.name));
			}
		}
		this.attachments = attachments;
		return attachments;
	}

	async upload(files: File[]): Promise<void> {
		if (!files?.length) return;
		const folderPath = await this.ensureAttachmentFolderReady();
		if (!folderPath) {
			new Notice(
				"Unable to determine attachment folder for this meeting.",
				4000
			);
			return;
		}
		for (const file of files) {
			try {
				const buffer = await file.arrayBuffer();
				const { path, finalName, renamed } =
					await this.getAvailableAttachmentPath(file.name);
				await this.plugin.app.vault.createBinary(path, buffer);
				if (renamed) {
					new Notice(
						`${file.name} exists. Saved as ${finalName}.`,
						4000
					);
				}
			} catch (error) {
				console.error("Audio Notes: Failed to save attachment", error);
				new Notice(
					`Failed to save ${file.name}. See console for details.`,
					5000
				);
			}
		}
	}

	async open(path: string): Promise<boolean> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice("Attachment no longer exists.", 3000);
			return false;
		}
		try {
			let leaf = this.plugin.app.workspace.getLeaf(false);
			if (!leaf) {
				leaf = this.plugin.app.workspace.getLeaf(true);
			}
			await leaf.openFile(file);
			return true;
		} catch (error) {
			console.error("Audio Notes: Failed to open attachment", error);
			new Notice("Unable to open attachment.", 4000);
			return true;
		}
	}

	async delete(path: string): Promise<boolean> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			return false;
		}
		try {
			await this.plugin.app.vault.delete(file);
			return true;
		} catch (error) {
			console.error("Audio Notes: Failed to delete attachment", error);
			new Notice("Unable to delete attachment.", 4000);
			return false;
		}
	}

	private async ensureAttachmentFolderReady(): Promise<string | null> {
		if (this.attachmentFolderPath) {
			const ready = await this.fileService.ensureFolder(
				this.attachmentFolderPath
			);
			if (ready) {
				return this.attachmentFolderPath;
			}
			this.attachmentFolderPath = null;
		}
		if (!this.currentAudioPath) {
			return null;
		}
		const audioFile =
			this.plugin.app.vault.getAbstractFileByPath(this.currentAudioPath);
		if (audioFile instanceof TFile && audioFile.parent) {
			this.attachmentFolderPath = audioFile.parent.path;
			return this.attachmentFolderPath;
		}
		return null;
	}

	private async getAvailableAttachmentPath(
		fileName: string
	): Promise<{
		path: string;
		finalName: string;
		renamed: boolean;
	}> {
		const folderPath = await this.ensureAttachmentFolderReady();
		if (!folderPath) {
			throw new Error("Attachment folder is not ready");
		}
		const trimmedName = fileName?.trim() || "attachment";
		const dotIndex = trimmedName.lastIndexOf(".");
		const base = dotIndex === -1 ? trimmedName : trimmedName.slice(0, dotIndex);
		const ext = dotIndex === -1 ? "" : trimmedName.slice(dotIndex);
		const safeBase = base || "attachment";
		let finalName = trimmedName;
		let counter = 1;
		while (
			this.plugin.app.vault.getAbstractFileByPath(
				`${folderPath}/${finalName}`
			)
		) {
			finalName = `${safeBase}-${counter}${ext}`;
			counter++;
		}
		return {
			path: `${folderPath}/${finalName}`,
			finalName,
			renamed: finalName !== trimmedName,
		};
	}

	private formatFileSize(bytes: number): string {
		if (!bytes || bytes <= 0) {
			return "0 B";
		}
		const units = ["B", "KB", "MB", "GB", "TB"];
		const index = Math.min(
			Math.floor(Math.log(bytes) / Math.log(1024)),
			units.length - 1
		);
		const value = bytes / Math.pow(1024, index);
		return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${
			units[index]
		}`;
	}

	private async migrateAttachments(
		from: string,
		to: string
	): Promise<void> {
		if (from === to) {
			return;
		}
		const source = this.plugin.app.vault.getAbstractFileByPath(from);
		if (!(source instanceof TFolder)) {
			return;
		}
		const ready = await this.fileService.ensureFolder(to);
		if (!ready) {
			return;
		}
		for (const child of [...source.children]) {
			if (!(child instanceof TFile)) {
				continue;
			}
			if (child.path === this.currentAudioPath) {
				continue;
			}
			if (child.path === this.meetingFilePath) {
				continue;
			}
			const targetPath =
				await this.fileService.getAvailableChildPath(
					to,
					child.name
				);
			await this.plugin.app.fileManager.renameFile(child, targetPath);
		}
	}
}
