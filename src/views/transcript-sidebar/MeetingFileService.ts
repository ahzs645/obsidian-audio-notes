import { TFile, TFolder } from "obsidian";
import type AutomaticAudioNotes from "../../main";
import { normalizeFolderPath } from "../../AudioNotesUtils";
import { generateRandomString } from "../../utils";

export type MeetingDateParts = {
	year?: string;
	month?: string;
	day?: string;
};

export interface MeetingFolderResult {
	audioPath: string;
	meetingFolder: string | null;
	dateParts: MeetingDateParts;
}

export class MeetingFileService {
	constructor(private readonly plugin: AutomaticAudioNotes) {}

	async ensureMeetingFolderForAudio(
		meetingFile: TFile,
		audioPath: string,
		audioFieldKey: string | null,
		meetingTitle: string
	): Promise<MeetingFolderResult | null> {
		if (!audioPath || audioPath.includes("://")) {
			return { audioPath, meetingFolder: null, dateParts: {} };
		}
		const audioFile =
			this.plugin.app.vault.getAbstractFileByPath(audioPath);
		if (!(audioFile instanceof TFile)) {
			return { audioPath, meetingFolder: null, dateParts: {} };
		}

		const dateParts = this.extractDateParts(audioFile.basename, audioFile);
		const parentFolder = audioFile.parent;
		const currentParentPath = parentFolder?.path ?? "";
		const baseParentPath = this.getMeetingBasePath(audioFile);

		if (baseParentPath) {
			const baseReady = await this.ensureFolder(baseParentPath);
			if (!baseReady) {
				return {
					audioPath: audioFile.path,
					meetingFolder: currentParentPath || null,
					dateParts,
				};
			}
		}

		const parentSegments = currentParentPath
			? currentParentPath.split("/").filter(Boolean)
			: [];
		const baseSegments = baseParentPath
			? baseParentPath.split("/").filter(Boolean)
			: [];
		const hashedFolderRegex = /^[a-z0-9]{4}-/;
		const basePrefix = baseParentPath ? `${baseParentPath}/` : "";
		const hasHashedFolder =
			parentFolder && hashedFolderRegex.test(parentFolder.name);
		const isDirectChildOfBase =
			Boolean(baseParentPath) &&
			currentParentPath.startsWith(basePrefix) &&
			parentSegments.length === baseSegments.length + 1 &&
			hasHashedFolder;
		const isStandaloneHashedParent = !baseParentPath && hasHashedFolder;

		let meetingFolderPath: string;
		if (
			(isDirectChildOfBase || isStandaloneHashedParent) &&
			currentParentPath
		) {
			meetingFolderPath = currentParentPath;
		} else {
			meetingFolderPath = this.buildMeetingFolderPath(
				baseParentPath,
				meetingTitle,
				audioFile.basename
			);
			const folderReady = await this.ensureFolder(meetingFolderPath);
			if (!folderReady) {
				return {
					audioPath: audioFile.path,
					meetingFolder: currentParentPath || null,
					dateParts,
				};
			}
		}

		const originalParentPath = currentParentPath;
		let targetPath = `${meetingFolderPath}/${audioFile.name}`;
		if (audioFile.path !== targetPath) {
			await this.plugin.app.fileManager.renameFile(
				audioFile,
				targetPath
			);
		}

		if (audioFieldKey && targetPath !== audioPath) {
			await this.plugin.app.fileManager.processFrontMatter(
				meetingFile,
				(fm) => {
					fm[audioFieldKey] = targetPath;
				}
			);
		}

		const updatedAudioFile =
			this.plugin.app.vault.getAbstractFileByPath(targetPath);
		if (!(updatedAudioFile instanceof TFile)) {
			targetPath = audioFile.path;
		}

		if (meetingFolderPath !== originalParentPath) {
			await this.cleanupLegacyAudioAncestors(originalParentPath);
		}

		return {
			audioPath: targetPath,
			meetingFolder: meetingFolderPath,
			dateParts,
		};
	}

	async ensureMeetingNoteFolder(
		meetingFile: TFile,
		dateParts: MeetingDateParts
	): Promise<TFile | null> {
		const { year, month, day } = dateParts;
		if (!year || !month || !day) {
			return null;
		}
		const parentPath = meetingFile.parent?.path ?? "";
		if (!parentPath) {
			return null;
		}
		const segments = parentPath.split("/").filter(Boolean);
		if (!segments.length) {
			return null;
		}

		const lastThreeAreDate =
			segments.length >= 3 &&
			/^\d{4}$/.test(segments[segments.length - 3]) &&
			/^\d{2}$/.test(segments[segments.length - 2]) &&
			/^\d{2}$/.test(segments[segments.length - 1]);
		const baseSegments = lastThreeAreDate
			? segments.slice(0, -3)
			: segments;
		if (!baseSegments.length) {
			return null;
		}
		const basePath = baseSegments.join("/");
		const desiredParent = `${basePath}/${year}/${month}/${day}`;
		if (parentPath === desiredParent) {
			return null;
		}
		const ready = await this.ensureFolder(desiredParent);
		if (!ready) {
			return null;
		}
		const targetPath = `${desiredParent}/${meetingFile.name}`;
		await this.plugin.app.fileManager.renameFile(meetingFile, targetPath);
		const updatedFile = this.plugin.app.vault.getAbstractFileByPath(
			targetPath
		);
		return updatedFile instanceof TFile ? updatedFile : meetingFile;
	}

	extractDatePartsFromFrontmatter(
		frontmatter: Record<string, unknown>
	): MeetingDateParts | null {
		const startDate = frontmatter["start_date"];
		if (typeof startDate === "string") {
			const match = startDate.match(/(\d{4})-(\d{2})-(\d{2})/);
			if (match) {
				return {
					year: match[1],
					month: match[2],
					day: match[3],
				};
			}
		}
		return null;
	}

	deriveDatePartsFromNotePath(file: TFile): MeetingDateParts | null {
		const parentPath = file.parent?.path;
		if (!parentPath) return null;
		const segments = parentPath.split("/").filter(Boolean);
		const lastThree = segments.slice(-3);
		if (
			lastThree.length === 3 &&
			/^\d{4}$/.test(lastThree[0]) &&
			/^\d{2}$/.test(lastThree[1]) &&
			/^\d{2}$/.test(lastThree[2])
		) {
			return {
				year: lastThree[0],
				month: lastThree[1],
				day: lastThree[2],
			};
		}
		return null;
	}

	async saveUploadedAudioFile(
		file: File,
		dateParts: MeetingDateParts,
		meetingTitle: string
	): Promise<{ audioPath: string; meetingFolder: string }> {
		const root = this.getAudioLibraryRoot();
		const segments = [
			root,
			dateParts.year,
			dateParts.month,
			dateParts.day,
		].filter(Boolean) as string[];
		const basePath = segments.join("/");
		await this.ensureFolder(basePath);
		const fallbackSlug = file.name.replace(/\.[^.]+$/, "");
		const meetingFolder = this.buildMeetingFolderPath(
			basePath,
			meetingTitle,
			fallbackSlug
		);
		await this.ensureFolder(meetingFolder);
		const targetName = await this.getAvailableChildPath(
			meetingFolder,
			this.sanitizeFilename(file.name)
		);
		const buffer = await file.arrayBuffer();
		await this.plugin.app.vault.createBinary(targetName, buffer);
		return {
			audioPath: targetName,
			meetingFolder,
		};
	}

	getAudioLibraryRoot(): string {
		const configured = normalizeFolderPath(
			this.plugin.settings.whisperAudioFolder,
			"MediaArchive/audio"
		);
		const segments = configured.split("/").filter(Boolean);
		if (segments[segments.length - 1] === "audio") {
			segments.pop();
		}
		return segments.join("/") || configured;
	}

	async ensureFolder(path: string): Promise<boolean> {
		const { app } = this.plugin;
		if (!path) return false;
		const normalizedPath = path.replace(/^\/+|\/+$/g, "");
		if (!normalizedPath.length) return false;
		const existingFile =
			app.vault.getAbstractFileByPath(normalizedPath);
		if (existingFile instanceof TFolder) {
			return true;
		}
		if (existingFile instanceof TFile) {
			console.warn(
				`Audio Notes: Folder path ${normalizedPath} already exists as a file`
			);
			return false;
		}
		const parentPath = normalizedPath
			.split("/")
			.slice(0, -1)
			.join("/");
		if (parentPath && !(await this.ensureFolder(parentPath))) {
			return false;
		}
		try {
			await app.vault.createFolder(normalizedPath);
			return true;
		} catch (error) {
			const retry =
				app.vault.getAbstractFileByPath(normalizedPath);
			if (retry instanceof TFolder) {
				return true;
			}
			console.error("Audio Notes: Failed to create folder", error);
			return false;
		}
	}

	async getAvailableChildPath(
		folder: string,
		filename: string
	): Promise<string> {
		const adapter = this.plugin.app.vault.adapter;
		const dotIndex = filename.lastIndexOf(".");
		const base = dotIndex === -1 ? filename : filename.slice(0, dotIndex);
		const extension = dotIndex === -1 ? "" : filename.slice(dotIndex);
		let candidate = `${folder}/${filename}`.replace(/\/+/g, "/");
		let counter = 1;
		while (await adapter.exists(candidate)) {
			candidate = `${folder}/${base}-${counter}${extension}`.replace(
				/\/+/g,
				"/"
			);
			counter += 1;
		}
		return candidate;
	}

	sanitizeFilename(name: string): string {
		const sanitized = name
			.normalize("NFKD")
			.replace(/[^\w.\-]+/g, "-")
			.replace(/-+/g, "-");
		return sanitized || "audio.m4a";
	}

	private getMeetingBasePath(audioFile: TFile): string {
		const segments = audioFile.path.split("/").filter(Boolean);
		const audioIndex = segments.indexOf("audio");
		const dateParts = this.extractDateParts(
			audioFile.basename,
			audioFile
		);
		let baseSegments: string[] =
			audioIndex === -1
				? audioFile.parent?.path?.split("/").filter(Boolean) ?? []
				: segments.slice(0, audioIndex);
		if (audioIndex === -1 && baseSegments.length) {
			const last = baseSegments[baseSegments.length - 1];
			if (/^[a-z0-9]{4}-/.test(last)) {
				baseSegments = baseSegments.slice(0, -1);
			}
		}

		const pushSegment = (value?: string) => {
			if (!value) return;
			if (baseSegments[baseSegments.length - 1] === value) return;
			if (baseSegments.includes(value)) return;
			baseSegments.push(value);
		};

		if (audioIndex !== -1) {
			const yearSegment = segments[audioIndex + 1] ?? dateParts.year;
			const monthSegment = segments[audioIndex + 2] ?? dateParts.month;
			pushSegment(yearSegment);
			pushSegment(monthSegment);
		} else {
			pushSegment(dateParts.year);
			pushSegment(dateParts.month);
		}

		pushSegment(dateParts.day);

		return baseSegments.join("/");
	}

	private buildMeetingFolderPath(
		baseParentPath: string,
		meetingTitle: string,
		fallback: string
	): string {
		const slugBase = meetingTitle?.trim() || fallback || "meeting";
		const slug = slugBase
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 20) || "meeting";
		let folderName = "";
		let fullPath = "";
		do {
			const hash = generateRandomString(4).toLowerCase();
			folderName = `${hash}-${slug}`;
			fullPath = baseParentPath
				? `${baseParentPath}/${folderName}`
				: folderName;
		} while (
			this.plugin.app.vault.getAbstractFileByPath(fullPath) instanceof
			TFolder
		);
		return fullPath;
	}

	private extractDateParts(value: string, file?: TFile): MeetingDateParts {
		const match = value.match(/(\d{4})-(\d{2})-(\d{2})/);
		if (match) {
			return {
				year: match[1],
				month: match[2],
				day: match[3],
			};
		}
		const timestamp = file?.stat?.ctime ?? file?.stat?.mtime ?? Date.now();
		const date = new Date(timestamp);
		if (isNaN(date.getTime())) {
			return {};
		}
		const year = date.getFullYear().toString();
		const month = (date.getMonth() + 1).toString().padStart(2, "0");
		const day = date.getDate().toString().padStart(2, "0");
		return { year, month, day };
	}

	private async cleanupLegacyAudioAncestors(path: string | null) {
		let current = path;
		while (current) {
			const folder =
				this.plugin.app.vault.getAbstractFileByPath(current);
			if (!(folder instanceof TFolder)) break;
			if (folder.children.length > 0) break;
			const segments = current.split("/").filter(Boolean);
			if (!segments.length) break;
			const removedSegment = segments[segments.length - 1];
			await this.plugin.app.vault.delete(folder);
			segments.pop();
			if (!segments.length) break;
			if (removedSegment === "audio") {
				break;
			}
			current = segments.join("/");
		}
	}
}
