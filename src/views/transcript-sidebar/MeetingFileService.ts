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
		meetingTitle: string,
		preferredDateParts?: MeetingDateParts
	): Promise<MeetingFolderResult | null> {
		if (!audioPath || audioPath.includes("://")) {
			return { audioPath, meetingFolder: null, dateParts: {} };
		}
		let audioFile =
			this.plugin.app.vault.getAbstractFileByPath(audioPath);
		if (!(audioFile instanceof TFile)) {
			audioFile = this.findAudioFileByName(audioPath);
		}
		if (!(audioFile instanceof TFile)) {
			return { audioPath, meetingFolder: null, dateParts: {} };
		}

		const dateParts = this.resolveDateParts(
			preferredDateParts,
			this.extractDateParts(audioFile.basename, audioFile)
		);
		let parentFolder = this.findHashedAncestor(audioFile) ?? audioFile.parent;
		let currentParentPath = parentFolder?.path ?? audioFile.parent?.path ?? "";
		const configuredRoot = this.getAudioLibraryRoot();
		const baseParentPath = this.buildDatedBasePath(
			configuredRoot,
			dateParts
		);
		const baseReady = await this.ensureFolder(baseParentPath);
		if (!baseReady) {
			return {
				audioPath: audioFile.path,
				meetingFolder: currentParentPath || null,
				dateParts,
			};
		}

		const hashedFolderRegex = /^[a-z0-9]{4}-/;
		const hasHashedFolder =
			parentFolder && hashedFolderRegex.test(parentFolder.name);
		const reuseExistingFolder =
			hasHashedFolder && currentParentPath !== baseParentPath;

		let meetingFolderPath: string;
		if (reuseExistingFolder && parentFolder) {
			meetingFolderPath = `${baseParentPath}/${parentFolder.name}`;
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
		const shouldMoveFolder =
			parentFolder instanceof TFolder &&
			hasHashedFolder &&
			currentParentPath &&
			currentParentPath !== meetingFolderPath;

		if (shouldMoveFolder && parentFolder) {
			try {
				await this.plugin.app.fileManager.renameFile(
					parentFolder,
					meetingFolderPath
				);
				currentParentPath = meetingFolderPath;
				const updatedFolder =
					this.plugin.app.vault.getAbstractFileByPath(
						meetingFolderPath
					);
				if (updatedFolder instanceof TFolder) {
					parentFolder = updatedFolder;
				}
				const updatedAudio =
					this.plugin.app.vault.getAbstractFileByPath(
						`${meetingFolderPath}/${audioFile.name}`
					);
				if (updatedAudio instanceof TFile) {
					audioFile = updatedAudio;
				}
				targetPath = audioFile.path;
			} catch (error) {
				console.error(
					"Audio Notes: Failed to relocate meeting folder",
					error
				);
			}
		}

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

		await this.flattenNestedDateFolders(meetingFolderPath, dateParts);

		if (meetingFolderPath !== originalParentPath) {
			await this.cleanupEmptyAncestors(
				originalParentPath,
				this.getAudioLibraryRoot()
			);
		}

		return {
			audioPath: targetPath,
			meetingFolder: meetingFolderPath,
			dateParts,
		};
	}

	async ensureMeetingNoteFolder(
		meetingFile: TFile,
		dateParts: MeetingDateParts,
		preferredRoot?: string
	): Promise<TFile | null> {
		const { year, month, day } = dateParts;
		if (!year || !month || !day) {
			return null;
		}
		const currentParentPath = meetingFile.parent?.path ?? "";
		let basePath: string | null = null;
		if (preferredRoot) {
			basePath = normalizeFolderPath(preferredRoot, preferredRoot);
		} else {
			if (!currentParentPath) {
				return null;
			}
			const segments = currentParentPath.split("/").filter(Boolean);
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
			basePath = baseSegments.join("/");
		}
		if (!basePath) {
			return null;
		}
		const desiredParent = `${basePath}/${year}/${month}/${day}`;
		if (currentParentPath === desiredParent) {
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
		if (currentParentPath && currentParentPath !== desiredParent) {
			await this.cleanupEmptyAncestors(
				currentParentPath,
				this.getMeetingNoteRoot()
			);
		}
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
		const normalizedDateParts = this.resolveDateParts(dateParts);
		const root = this.getAudioLibraryRoot();
		const basePath = this.buildDatedBasePath(root, normalizedDateParts);
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

	async saveUploadedTranscriptFile(file: File): Promise<string> {
		const folder = normalizeFolderPath(
			this.plugin.settings.DGTranscriptFolder,
			"transcripts"
		);
		await this.ensureFolder(folder);
		const baseName = file.name?.trim() || "transcript.vtt";
		const filename = this.sanitizeFilename(
			baseName.includes(".") ? baseName : `${baseName}.vtt`
		);
		const targetPath = await this.getAvailableChildPath(folder, filename);
		const contents = await file.text();
		await this.plugin.app.vault.create(targetPath, contents);
		return targetPath;
	}

	getAudioLibraryRoot(): string {
		return normalizeFolderPath(
			this.plugin.settings.whisperAudioFolder,
			"MediaArchive/audio"
		);
	}

	getMeetingNoteRoot(): string {
		return normalizeFolderPath(
			this.plugin.settings.whisperNoteFolder || "meetings",
			"meetings"
		);
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

	private resolveDateParts(
		preferred?: MeetingDateParts,
		fallback?: MeetingDateParts
	): MeetingDateParts {
		const now = new Date();
		return {
			year:
				preferred?.year ??
				fallback?.year ??
				now.getFullYear().toString(),
			month:
				preferred?.month ??
				fallback?.month ??
				(now.getMonth() + 1).toString().padStart(2, "0"),
			day:
				preferred?.day ??
				fallback?.day ??
				now.getDate().toString().padStart(2, "0"),
		};
	}

	private buildDatedBasePath(
		rootPath: string,
		dateParts: MeetingDateParts
	): string {
		const segments = rootPath.split("/").filter(Boolean);

		// Build expected date path components
		const datePath: string[] = [];
		if (dateParts.year) datePath.push(dateParts.year);
		if (dateParts.month) datePath.push(dateParts.month);
		if (dateParts.day) datePath.push(dateParts.day);

		// Check if the path already ends with the complete date pattern
		if (datePath.length > 0) {
			const endSegments = segments.slice(-datePath.length);
			const alreadyComplete =
				endSegments.length === datePath.length &&
				endSegments.every((seg, idx) => seg === datePath[idx]);

			if (!alreadyComplete) {
				// Append all date components
				segments.push(...datePath);
			}
		}

		return segments.join("/");
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

	private findAudioFileByName(audioPath: string): TFile | null {
		const filename = audioPath.split("/").pop();
		if (!filename) {
			return null;
		}
		const searchQueue = [];
		const parentPath = audioPath.split("/").slice(0, -1).join("/");
		if (parentPath) {
			searchQueue.push(parentPath);
			const grandParent = parentPath.split("/").slice(0, -1).join("/");
			if (grandParent && grandParent !== parentPath) {
				searchQueue.push(grandParent);
			}
		}
		const root = this.getAudioLibraryRoot();
		if (root) {
			searchQueue.push(root);
		}
		for (const folderPath of searchQueue) {
			const found = this.searchFolderForFile(folderPath, filename);
			if (found) {
				return found;
			}
		}
		return null;
	}

	private searchFolderForFile(
		folderPath: string,
		filename: string
	): TFile | null {
		const folder =
			this.plugin.app.vault.getAbstractFileByPath(folderPath);
		if (!(folder instanceof TFolder)) {
			return null;
		}
		for (const child of folder.children) {
			if (child instanceof TFile && child.name === filename) {
				return child;
			}
			if (child instanceof TFolder) {
				const found = this.searchFolderForFile(child.path, filename);
				if (found) {
					return found;
				}
			}
		}
		return null;
	}

	private findHashedAncestor(file: TFile): TFolder | null {
		const hashedRegex = /^[a-z0-9]{4}-/;
		let current: TFile | TFolder | null = file;
		while (current) {
			const parent: TFolder | TFile | null = current.parent;
			if (!parent) {
				break;
			}
			if (parent instanceof TFolder && hashedRegex.test(parent.name)) {
				return parent;
			}
			current = parent;
		}
		return null;
	}

	public async removeEmptyFoldersUnder(rootPath: string): Promise<void> {
		await this.removeEmptyFoldersRecursive(
			normalizeFolderPath(rootPath, rootPath)
		);
	}

	private async removeEmptyFoldersRecursive(path: string): Promise<boolean> {
		const folder =
			this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(folder instanceof TFolder)) {
			return false;
		}
		let hasContent = false;
		for (const child of [...folder.children]) {
			if (child instanceof TFolder) {
				const childHasContent = await this.removeEmptyFoldersRecursive(
					child.path
				);
				hasContent = hasContent || childHasContent;
			} else {
				hasContent = true;
			}
		}
		if (!hasContent) {
			await this.plugin.app.vault.delete(folder);
		}
		return hasContent;
	}

	private async flattenNestedDateFolders(
		folderPath: string,
		dateParts: MeetingDateParts
	): Promise<void> {
		if (!dateParts.year || !dateParts.month || !dateParts.day) {
			return;
		}
		const nestedPath = `${folderPath}/${dateParts.year}/${dateParts.month}/${dateParts.day}`;
		const nestedFolder = this.plugin.app.vault.getAbstractFileByPath(
			nestedPath
		);
		if (!(nestedFolder instanceof TFolder)) {
			return;
		}
		for (const child of [...nestedFolder.children]) {
			const target = `${folderPath}/${child.name}`;
			await this.plugin.app.fileManager.renameFile(child, target);
		}
		await this.cleanupEmptyAncestors(nestedPath, folderPath);
	}

	private async cleanupEmptyAncestors(
		path: string | null,
		stopAtPath: string
	) {
		const normalizedStop = normalizeFolderPath(stopAtPath, stopAtPath);
		let current = path;
		while (current) {
			const folder =
				this.plugin.app.vault.getAbstractFileByPath(current);
			if (!(folder instanceof TFolder)) break;
			if (folder.children.length > 0) break;
			if (current === normalizedStop) break;
			await this.plugin.app.vault.delete(folder);
			const segments = current.split("/").filter(Boolean);
			if (!segments.length) break;
			segments.pop();
			if (!segments.length) break;
			current = segments.join("/");
		}
	}
}
