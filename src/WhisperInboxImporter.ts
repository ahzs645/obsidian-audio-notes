import {
	Notice,
	normalizePath,
	TAbstractFile,
	TFile,
} from "obsidian";
import type AutomaticAudioNotes from "./main";
import {
	importWhisperArchive,
	WhisperDuplicateError,
} from "./WhisperImporter";

const IMPORT_DEBOUNCE_MS = 1500;
const IMPORT_RETRY_DELAYS_MS = [0, 1500, 4000];

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, ms);
	});
}

export class WhisperInboxImporter {
	private readonly scheduledImports = new Map<string, number>();
	private readonly inFlightImports = new Set<string>();

	constructor(private readonly plugin: AutomaticAudioNotes) {}

	destroy(): void {
		for (const timeout of this.scheduledImports.values()) {
			window.clearTimeout(timeout);
		}
		this.scheduledImports.clear();
		this.inFlightImports.clear();
	}

	scheduleAbstractFile(file: TAbstractFile | null | undefined): void {
		if (!(file instanceof TFile)) {
			return;
		}
		this.schedulePath(file.path);
	}

	private schedulePath(path: string): void {
		const normalizedPath = normalizePath(path);
		if (!this.shouldProcessPath(normalizedPath)) {
			return;
		}
		const existing = this.scheduledImports.get(normalizedPath);
		if (existing) {
			window.clearTimeout(existing);
		}
		const timeout = window.setTimeout(() => {
			this.scheduledImports.delete(normalizedPath);
			void this.importPath(normalizedPath);
		}, IMPORT_DEBOUNCE_MS);
		this.scheduledImports.set(normalizedPath, timeout);
	}

	private getInboxRoot(): string {
		const configured = this.plugin.settings.whisperInboxFolder?.trim();
		return configured ? normalizePath(configured).replace(/\/+$/, "") : "";
	}

	private shouldProcessPath(path: string): boolean {
		if (!this.plugin.settings.whisperAutoImportInbox) {
			return false;
		}
		const root = this.getInboxRoot();
		if (!root) {
			return false;
		}
		const normalizedPath = normalizePath(path);
		if (!normalizedPath.toLowerCase().endsWith(".whisper")) {
			return false;
		}
		return (
			normalizedPath === root ||
			normalizedPath.startsWith(`${root}/`)
		);
	}

	private async importPath(path: string): Promise<void> {
		if (this.inFlightImports.has(path)) {
			return;
		}
		const current = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(current instanceof TFile) || !this.shouldProcessPath(current.path)) {
			return;
		}
		this.inFlightImports.add(path);
		try {
			await this.importWithRetries(current);
		} finally {
			this.inFlightImports.delete(path);
		}
	}

	private async importWithRetries(file: TFile): Promise<void> {
		let lastError: unknown = null;
		for (const delay of IMPORT_RETRY_DELAYS_MS) {
			if (delay > 0) {
				await wait(delay);
			}
			const refreshed =
				this.plugin.app.vault.getAbstractFileByPath(file.path);
			if (!(refreshed instanceof TFile)) {
				return;
			}
			try {
				const archive = await this.plugin.app.vault.adapter.readBinary(
					refreshed.path
				);
				const result = await importWhisperArchive(
					this.plugin,
					archive,
					refreshed.name
				);
				new Notice(
					result.notePath
						? `Imported ${refreshed.name} from Whisper inbox.`
						: `Imported ${refreshed.name} from Whisper inbox without creating a note.`,
					5000
				);
				return;
			} catch (error) {
				if (error instanceof WhisperDuplicateError) {
					new Notice(
						`Skipped ${refreshed.name}: already imported.`,
						5000
					);
					return;
				}
				lastError = error;
			}
		}
		console.error(
			"Audio Notes: Whisper inbox auto-import failed",
			file.path,
			lastError
		);
		new Notice(`Could not auto-import ${file.name}.`, 6000);
	}
}
