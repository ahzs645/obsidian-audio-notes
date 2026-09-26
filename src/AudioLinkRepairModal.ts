import { createHash } from "crypto";
import { createReadStream } from "fs";
import { FileSystemAdapter, Modal, Notice, TFile, TFolder } from "obsidian";
import type AutomaticAudioNotes from "./main";
import {
	isAudioPath,
	isHashedFolderPath,
	parentOf,
	planAudioLinkRepair,
	type RepairNote,
	type RepairPlan,
} from "./AudioLinkRepair";
import {
	MEDIA_FIELD_KEYS,
	MeetingFileService,
} from "./views/transcript-sidebar/MeetingFileService";
import { isAbsoluteFilesystemPath } from "./googleDriveArchive";

type HashCache = Record<string, { size: number; mtime: number; sha1: string }>;

/**
 * Finds meeting notes linked to the wrong recording (reused recorder names let
 * the sidebar move one meeting's audio into another's folder) and fixes them
 * after the user reviews the changes.
 */
export class AudioLinkRepairModal extends Modal {
	private readonly files: MeetingFileService;
	private plan: RepairPlan | null = null;
	private emptyFolders: string[] = [];
	private cancelled = false;
	private busy = false;
	private hashCache: HashCache = {};
	private statusEl?: HTMLElement;
	private bodyEl?: HTMLElement;
	private applyButton?: HTMLButtonElement;

	constructor(
		private readonly plugin: AutomaticAudioNotes,
		private readonly focusNote: TFile | null = null
	) {
		super(plugin.app);
		this.files = new MeetingFileService(plugin);
	}

	onOpen() {
		this.cancelled = false;
		this.modalEl.addClass("aan-audio-repair-modal");
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("aan-audio-repair");
		contentEl.createEl("h2", { text: "Repair meeting recordings" });
		contentEl.createEl("p", {
			cls: "aan-audio-repair-intro",
			text: "Checks that each meeting links to the recording its transcript was made from. Nothing changes until you apply.",
		});
		this.statusEl = contentEl.createEl("p", {
			cls: "aan-audio-repair-status",
			attr: { role: "status" },
		});
		this.bodyEl = contentEl.createDiv({ cls: "aan-audio-repair-body" });

		const buttons = contentEl.createDiv("modal-button-container");
		buttons
			.createEl("button", { text: "Close" })
			.addEventListener("click", () => this.close());
		this.applyButton = buttons.createEl("button", {
			text: "Apply fixes",
			cls: "mod-cta",
		});
		this.applyButton.disabled = true;
		this.applyButton.addEventListener("click", () => void this.apply());

		void this.scan();
	}

	onClose() {
		// Stops a scan between files; an apply in progress finishes its step.
		this.cancelled = true;
		this.contentEl.empty();
	}

	private setStatus(text: string) {
		this.statusEl?.setText(text);
	}

	private progressText = "";

	private async scan() {
		this.busy = true;
		this.setStatus("Scanning meeting notes…");
		try {
			await this.loadHashCache();
			const notes = this.collectNotes();
			const audioFiles = this.app.vault
				.getFiles()
				.filter((file) => isAudioPath(file.path))
				.map((file) => file.path);
			this.plan = await planAudioLinkRepair(
				notes,
				audioFiles,
				{
					loadExpected: (note) => this.loadExpected(note),
					hashFile: (path) => this.hashFile(path),
					isCancelled: () => this.cancelled,
					onProgress: (message) => {
						this.progressText = message;
						this.setStatus(message);
					},
				},
				this.focusNote?.path ?? null
			);
			if (this.cancelled) return;
			this.emptyFolders = this.findEmptyMeetingFolders();
			this.renderPlan();
		} catch (error) {
			console.error("Audio Notes: Recording repair scan failed", error);
			this.setStatus("Scan failed. See the console for details.");
		} finally {
			this.busy = false;
		}
	}

	private collectNotes(): RepairNote[] {
		const notes: RepairNote[] = [];
		const { vault, metadataCache } = this.app;
		for (const file of vault.getMarkdownFiles()) {
			const frontmatter = metadataCache.getFileCache(file)?.frontmatter;
			if (!frontmatter) continue;
			const fieldKey = MEDIA_FIELD_KEYS.find(
				(key) => typeof frontmatter[key] === "string"
			);
			const mediaUri = fieldKey
				? String(frontmatter[fieldKey]).trim()
				: "";
			if (
				!fieldKey ||
				!mediaUri ||
				mediaUri.includes("://") ||
				isAbsoluteFilesystemPath(mediaUri)
			) {
				continue;
			}
			const transcript =
				frontmatter["transcript_uri"] ?? frontmatter["transcript"];
			notes.push({
				path: file.path,
				title:
					typeof frontmatter["title"] === "string"
						? frontmatter["title"]
						: file.basename,
				mediaUri,
				fieldKey,
				transcriptPath:
					typeof transcript === "string" ? transcript : null,
				dateParts:
					this.files.extractDatePartsFromFrontmatter(frontmatter) ??
					this.files.deriveDatePartsFromNotePath(file),
			});
		}
		return notes;
	}

	private async loadExpected(note: RepairNote) {
		const empty = { sha1: null, importedPath: null };
		if (!note.transcriptPath) return empty;
		try {
			const data = JSON.parse(
				await this.app.vault.adapter.read(note.transcriptPath)
			);
			return {
				sha1: typeof data?.audioSha1 === "string" ? data.audioSha1 : null,
				importedPath:
					typeof data?.audioPath === "string" ? data.audioPath : null,
			};
		} catch {
			return empty;
		}
	}

	private async hashFile(path: string): Promise<string | null> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return null;
		const cached = this.hashCache[path];
		if (
			cached &&
			cached.size === file.stat.size &&
			Math.abs(cached.mtime - file.stat.mtime) < 1
		) {
			return cached.sha1;
		}
		this.setStatus(
			`${this.progressText}\nReading ${file.name}. Recordings not yet downloaded from Google Drive can take a minute each; closing keeps what was read.`
		);
		try {
			const sha1 = await this.computeSha1(file);
			this.hashCache[path] = {
				size: file.stat.size,
				mtime: file.stat.mtime,
				sha1,
			};
			await this.saveHashCache();
			return sha1;
		} catch (error) {
			console.warn(`Audio Notes: Could not hash ${path}`, error);
			return null;
		}
	}

	private async computeSha1(file: TFile): Promise<string> {
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			// Streamed so hour-long recordings are never held in memory whole.
			const hash = createHash("sha1");
			await new Promise<void>((resolve, reject) => {
				createReadStream(adapter.getFullPath(file.path))
					.on("data", (chunk) => hash.update(chunk))
					.on("end", () => resolve())
					.on("error", reject);
			});
			return hash.digest("hex");
		}
		const digest = await crypto.subtle.digest(
			"SHA-1",
			await this.app.vault.readBinary(file)
		);
		return Array.from(new Uint8Array(digest))
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
	}

	private get hashCachePath(): string {
		return `${this.plugin.manifest.dir}/audio-hash-cache.json`;
	}

	private async loadHashCache() {
		try {
			this.hashCache = JSON.parse(
				await this.app.vault.adapter.read(this.hashCachePath)
			);
		} catch {
			this.hashCache = {};
		}
	}

	private async saveHashCache() {
		try {
			await this.app.vault.adapter.write(
				this.hashCachePath,
				JSON.stringify(this.hashCache)
			);
		} catch (error) {
			console.warn("Audio Notes: Could not save recording hashes", error);
		}
	}

	/** Hashed meeting folders under the audio library that hold nothing. */
	private findEmptyMeetingFolders(): string[] {
		const root = this.app.vault.getAbstractFileByPath(
			this.files.getAudioLibraryRoot()
		);
		if (!(root instanceof TFolder)) return [];
		const empty: string[] = [];
		const walk = (folder: TFolder) => {
			for (const child of folder.children) {
				if (!(child instanceof TFolder)) continue;
				if (isHashedFolderPath(child.path) && !child.children.length) {
					empty.push(child.path);
				} else {
					walk(child);
				}
			}
		};
		walk(root);
		return empty;
	}

	private renderPlan() {
		const plan = this.plan;
		const body = this.bodyEl;
		if (!plan || !body) return;
		body.empty();

		const fixCount = plan.relinks.length + plan.moves.length;
		const summary = [
			`Checked ${plan.checked} meeting${plan.checked === 1 ? "" : "s"}`,
			plan.unverifiable
				? `${plan.unverifiable} without a recording fingerprint skipped`
				: "",
		]
			.filter(Boolean)
			.join(" · ");
		this.setStatus(
			fixCount || this.emptyFolders.length
				? `${summary}.`
				: `${summary}. Every checked meeting links to the right recording.`
		);

		this.renderSection(
			body,
			"Link to the right recording",
			plan.relinks.map((relink) => ({
				note: relink.note,
				lines: [`Now: ${relink.from}`, `Fix: ${relink.to}`],
			}))
		);
		this.renderSection(
			body,
			"Give recordings their own folder",
			plan.moves.map((move) => ({
				note: move.notes[0],
				lines: [
					`${move.file} shares a folder with another meeting's recording`,
				],
			}))
		);
		this.renderSection(
			body,
			"Recording not found",
			plan.missing.map((note) => ({
				note,
				lines: [`Links to ${note.mediaUri}; no file matches its transcript. Left unchanged.`],
			}))
		);
		this.renderSection(
			body,
			"Recordings no meeting links to",
			plan.unlinked.map((path) => ({
				note: null,
				lines: [`${path} (kept)`],
			}))
		);
		if (this.emptyFolders.length) {
			this.renderSection(body, "Remove empty meeting folders", [
				{
					note: null,
					lines: [
						`${this.emptyFolders.length} empty folder${
							this.emptyFolders.length === 1 ? "" : "s"
						} under ${this.files.getAudioLibraryRoot()}`,
					],
				},
			]);
		}

		if (this.applyButton) {
			this.applyButton.disabled = !(fixCount || this.emptyFolders.length);
		}
	}

	private renderSection(
		parent: HTMLElement,
		title: string,
		rows: { note: RepairNote | null; lines: string[] }[]
	) {
		if (!rows.length) return;
		const section = parent.createDiv({ cls: "aan-audio-repair-section" });
		section.createEl("h3", { text: `${title} (${rows.length})` });
		for (const row of rows) {
			const rowEl = section.createDiv({ cls: "aan-audio-repair-row" });
			if (row.note) {
				const note = row.note;
				const titleEl = rowEl.createEl("a", {
					cls: "aan-audio-repair-title",
					text: note.title,
					attr: { href: "#", title: note.path },
				});
				if (note.path === this.focusNote?.path) {
					rowEl.addClass("is-current");
				}
				titleEl.addEventListener("click", (event) => {
					event.preventDefault();
					void this.app.workspace.openLinkText(note.path, "", false);
				});
			}
			for (const line of row.lines) {
				rowEl.createDiv({ cls: "aan-audio-repair-path", text: line });
			}
		}
	}

	private async apply() {
		const plan = this.plan;
		if (!plan || this.busy) return;
		this.busy = true;
		if (this.applyButton) this.applyButton.disabled = true;
		this.setStatus("Applying fixes…");
		const { vault, fileManager } = this.app;
		const root = this.files.getAudioLibraryRoot();
		const newLink = new Map<string, string>();
		const movedTo = new Map<string, string>();
		let failed = 0;

		for (const relink of plan.relinks) {
			newLink.set(relink.note.path, relink.to);
		}
		for (const move of plan.moves) {
			const file = vault.getAbstractFileByPath(move.file);
			if (!(file instanceof TFile)) {
				failed++;
				continue;
			}
			try {
				const base = move.dateParts?.day
					? this.files.buildDatedBasePath(root, move.dateParts)
					: parentOf(parentOf(move.file));
				const folder = this.files.buildMeetingFolderPath(
					base,
					move.notes[0]?.title ?? "",
					file.basename
				);
				if (!(await this.files.ensureFolder(folder))) {
					throw new Error(`Could not create ${folder}`);
				}
				const target = `${folder}/${file.name}`;
				await fileManager.renameFile(file, target);
				movedTo.set(move.file, target);
				for (const note of move.notes) {
					newLink.set(note.path, target);
				}
			} catch (error) {
				console.error(`Audio Notes: Could not move ${move.file}`, error);
				failed++;
			}
		}

		let relinked = 0;
		for (const [notePath, link] of newLink) {
			const note = vault.getAbstractFileByPath(notePath);
			const planned =
				plan.relinks.find((relink) => relink.note.path === notePath)
					?.note ??
				plan.moves
					.flatMap((move) => move.notes)
					.find((item) => item.path === notePath);
			if (!(note instanceof TFile) || !planned) {
				failed++;
				continue;
			}
			const finalLink = movedTo.get(link) ?? link;
			try {
				await fileManager.processFrontMatter(note, (fm) => {
					fm[planned.fieldKey] = finalLink;
				});
				relinked++;
			} catch (error) {
				console.error(`Audio Notes: Could not update ${notePath}`, error);
				failed++;
			}
		}

		let removed = 0;
		for (const path of this.findEmptyMeetingFolders()) {
			const folder = vault.getAbstractFileByPath(path);
			if (!(folder instanceof TFolder) || folder.children.length) continue;
			try {
				await vault.delete(folder);
				removed++;
			} catch (error) {
				console.warn(`Audio Notes: Could not remove ${path}`, error);
			}
		}

		const message = [
			`Updated ${relinked} meeting${relinked === 1 ? "" : "s"}`,
			movedTo.size ? `moved ${movedTo.size} recording${movedTo.size === 1 ? "" : "s"}` : "",
			removed ? `removed ${removed} empty folder${removed === 1 ? "" : "s"}` : "",
			failed ? `${failed} failed (see console)` : "",
		]
			.filter(Boolean)
			.join(", ");
		new Notice(`Recording repair: ${message}.`, 8000);
		this.busy = false;
		this.plan = null;
		this.bodyEl?.empty();
		this.setStatus(`${message}.`);
	}
}
