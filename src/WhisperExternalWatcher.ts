import { promises as fs } from "fs";
import path from "path";
import { Notice } from "obsidian";
import type AutomaticAudioNotes from "./main";
import { isDesktopEnvironment } from "./googleDriveArchive";
import {
	importWhisperArchive,
	isWhisperArchiveName,
	WhisperDuplicateError,
} from "./WhisperImporter";

const SCAN_INTERVAL_MS = 60_000;
// Skip archives modified very recently: they may still be downloading/syncing.
const MIN_FILE_AGE_MS = 5_000;
const IMPORTED_SUBFOLDER = "imported";

export class WhisperExternalWatcher {
	private scanning = false;

	constructor(private readonly plugin: AutomaticAudioNotes) {}

	start(): void {
		if (!isDesktopEnvironment()) {
			return;
		}
		this.plugin.registerInterval(
			window.setInterval(() => {
				void this.scan();
			}, SCAN_INTERVAL_MS)
		);
		void this.scan();
	}

	async scan(options?: { manual?: boolean }): Promise<void> {
		if (this.scanning || !isDesktopEnvironment()) {
			return;
		}
		const folder = this.plugin.settings.whisperExternalWatchFolder;
		if (!folder) {
			if (options?.manual) {
				new Notice(
					"Set the external Whisper watch folder in Audio Notes settings first.",
					6000
				);
			}
			return;
		}
		if (!this.plugin.settings.whisperExternalWatchEnabled && !options?.manual) {
			return;
		}
		this.scanning = true;
		try {
			const entries = await fs.readdir(folder, { withFileTypes: true });
			const archives = entries.filter(
				(entry) => entry.isFile() && isWhisperArchiveName(entry.name)
			);
			let imported = 0;
			let pendingChecks = 0;
			let duplicates = 0;
			let failed = 0;
			for (const entry of archives) {
				const fullPath = path.join(folder, entry.name);
				try {
					const stat = await fs.stat(fullPath);
					if (Date.now() - stat.mtimeMs < MIN_FILE_AGE_MS) {
						continue;
					}
					const buffer = await fs.readFile(fullPath);
					const data = buffer.buffer.slice(
						buffer.byteOffset,
						buffer.byteOffset + buffer.byteLength
					);
					const result = await importWhisperArchive(this.plugin, data, entry.name);
					if (result.duplicateCheckPending) pendingChecks += 1;
					imported += 1;
					await this.moveToImported(folder, fullPath, entry.name);
				} catch (error) {
					if (error instanceof WhisperDuplicateError) {
						duplicates += 1;
						await this.moveToImported(folder, fullPath, entry.name);
					} else {
						failed += 1;
						console.error(
							"Audio Notes: external watch folder import failed",
							fullPath,
							error
						);
					}
				}
			}
			if (imported || failed || options?.manual) {
				const parts = [`${imported} imported`];
				if (pendingChecks) parts.push(`${pendingChecks} duplicate checks pending`);
				if (duplicates) {
					parts.push(`${duplicates} already imported`);
				}
				if (failed) {
					parts.push(`${failed} failed (see console)`);
				}
				new Notice(`Whisper watch folder: ${parts.join(", ")}.`, 6000);
			}
		} catch (error) {
			console.error(
				"Audio Notes: could not scan external Whisper watch folder",
				folder,
				error
			);
			if (options?.manual) {
				new Notice(
					"Could not scan the external watch folder. Check the path in settings.",
					6000
				);
			}
		} finally {
			this.scanning = false;
		}
	}

	private async moveToImported(
		folder: string,
		fullPath: string,
		fileName: string
	): Promise<void> {
		try {
			const destinationFolder = path.join(folder, IMPORTED_SUBFOLDER);
			await fs.mkdir(destinationFolder, { recursive: true });
			let target = path.join(destinationFolder, fileName);
			let counter = 1;
			while (await this.exists(target)) {
				target = path.join(destinationFolder, `${counter}-${fileName}`);
				counter += 1;
			}
			await fs.rename(fullPath, target);
		} catch (error) {
			console.error(
				"Audio Notes: could not move processed Whisper archive",
				fullPath,
				error
			);
		}
	}

	private async exists(targetPath: string): Promise<boolean> {
		try {
			await fs.access(targetPath);
			return true;
		} catch {
			return false;
		}
	}
}
