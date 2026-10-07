/**
 * Works out which meeting notes point at the wrong recording and how to fix
 * them. Kept free of Obsidian imports so the planning can be tested in Node;
 * the modal supplies file hashing and transcript lookups.
 *
 * The transcript's `audioSha1` (written at import) is the source of truth for
 * which recording belongs to a meeting. Hashing is the slow part, so only
 * suspicious meetings are checked and every search stops at the first match.
 */

export const AUDIO_EXTENSIONS = new Set([
	"m4a",
	"mp3",
	"wav",
	"flac",
	"webm",
	"ogg",
	"aac",
	"aiff",
	"caf",
	"qta",
	"m4b",
]);

const HASHED_FOLDER = /^[a-z0-9]{4}-/;

export interface RepairDateParts {
	year?: string;
	month?: string;
	day?: string;
}

export interface RepairNote {
	path: string;
	title: string;
	/** Vault path from the note's audio field. */
	mediaUri: string;
	fieldKey: string;
	transcriptPath: string | null;
	dateParts: RepairDateParts | null;
}

export interface RepairIO {
	/** The transcript's recorded audio hash and original import path. */
	loadExpected(
		note: RepairNote
	): Promise<{ sha1: string | null; importedPath: string | null }>;
	hashFile(path: string): Promise<string | null>;
	isCancelled?(): boolean;
	onProgress?(message: string): void;
}

export interface RepairRelink {
	note: RepairNote;
	from: string;
	to: string;
}

export interface RepairMove {
	/** Current path of the recording that must leave its shared folder. */
	file: string;
	/** Every note that links (after relinking) to this recording. */
	notes: RepairNote[];
	dateParts: RepairDateParts | null;
}

export interface RepairPlan {
	relinks: RepairRelink[];
	moves: RepairMove[];
	/** Meetings whose recording could not be found anywhere. */
	missing: RepairNote[];
	/** Recordings in touched meeting folders that no meeting links to. */
	unlinked: string[];
	checked: number;
	unverifiable: number;
	cancelled: boolean;
}

export function isAudioPath(path: string): boolean {
	return AUDIO_EXTENSIONS.has(extensionOf(path));
}

export function isHashedFolderPath(folder: string): boolean {
	return HASHED_FOLDER.test(baseName(folder));
}

export function parentOf(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function extensionOf(path: string): string {
	const name = baseName(path);
	const dot = name.lastIndexOf(".");
	return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function stemOf(path: string): string {
	const name = baseName(path);
	const dot = name.lastIndexOf(".");
	return dot === -1 ? name : name.slice(0, dot);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `candidate` is `original` or a collision-renamed copy of it, e.g.
 * `system-audio-13-1.m4a` for `system-audio-13.m4a`.
 */
export function isSameFileFamily(candidate: string, original: string): boolean {
	if (extensionOf(candidate) !== extensionOf(original)) return false;
	const stem = stemOf(candidate);
	const originalStem = stemOf(original);
	if (stem === originalStem) return true;
	return new RegExp(`^${escapeRegExp(originalStem)}(-\\d+)+$`).test(stem);
}

/** Notes worth hashing: their link is missing, shared, or sits beside other recordings. */
export function findSuspectNotes(
	notes: RepairNote[],
	audioFiles: string[]
): RepairNote[] {
	const fileSet = new Set(audioFiles);
	const refs = groupBy(notes, (note) => note.mediaUri);
	const audioByFolder = groupBy(audioFiles, parentOf);
	const linkedFolders = groupBy(notes, (note) => parentOf(note.mediaUri));

	return notes.filter((note) => {
		if (!fileSet.has(note.mediaUri)) return true;
		const sharing = refs.get(note.mediaUri) ?? [];
		if (
			sharing.some(
				(other) => other.transcriptPath !== note.transcriptPath
			)
		) {
			return true;
		}
		const folder = parentOf(note.mediaUri);
		if (!isHashedFolderPath(folder)) return false;
		if ((audioByFolder.get(folder)?.length ?? 0) > 1) return true;
		return (linkedFolders.get(folder) ?? []).some(
			(other) => other.mediaUri !== note.mediaUri
		);
	});
}

export async function planAudioLinkRepair(
	notes: RepairNote[],
	audioFiles: string[],
	io: RepairIO,
	focusNotePath?: string | null
): Promise<RepairPlan> {
	const plan: RepairPlan = {
		relinks: [],
		moves: [],
		missing: [],
		unlinked: [],
		checked: 0,
		unverifiable: 0,
		cancelled: false,
	};
	const fileSet = new Set(audioFiles);
	const refs = groupBy(notes, (note) => note.mediaUri);
	const audioByFolder = groupBy(audioFiles, parentOf);

	// From a single meeting, start with just that meeting; the checks below
	// pull in any other meeting its fix affects.
	const focusNote = notes.find((note) => note.path === focusNotePath);
	const suspects = new Set(
		focusNote ? [focusNote] : findSuspectNotes(notes, audioFiles)
	);
	const queue = [...suspects];
	const finalLink = new Map<string, string | null>();
	const claimedBy = new Map<string, string>();
	const enqueue = (note: RepairNote) => {
		if (suspects.has(note)) return;
		suspects.add(note);
		queue.push(note);
	};
	const isFreeFor = (file: string) =>
		(refs.get(file) ?? []).every((ref) => suspects.has(ref));
	const linkOf = (note: RepairNote) =>
		finalLink.has(note.path)
			? finalLink.get(note.path) ?? null
			: note.mediaUri;

	let next = 0;
	const drain = async () => {
		for (; next < queue.length; next++) {
			if (io.isCancelled?.()) return;
			const note = queue[next];
			io.onProgress?.(
				`Checking ${next + 1} of ${queue.length}: ${note.title}`
			);
			const expected = await io.loadExpected(note);
			if (!expected.sha1) {
				plan.unverifiable++;
				continue;
			}
			plan.checked++;
			const sha1 = expected.sha1;
			const matches = async (file: string) =>
				(await io.hashFile(file)) === sha1;

			if (fileSet.has(note.mediaUri) && (await matches(note.mediaUri))) {
				finalLink.set(note.path, note.mediaUri);
				claimedBy.set(note.mediaUri, sha1);
				continue;
			}

			const families = [expected.importedPath, note.mediaUri].filter(
				(value): value is string => Boolean(value)
			);
			const folder = parentOf(note.mediaUri);
			// Recordings are filed under their meeting's month and recorder
			// names repeat across months, so that month is searched first.
			// Stale links can also leave a folder under another month, so
			// same-name files nobody else owns are tried everywhere after.
			const monthPrefix = dateMonthSegment(note.dateParts);
			const inMonth = (file: string) =>
				!monthPrefix || `/${file}`.includes(monthPrefix);
			const exactNames = new Set(families.map(baseName));
			const family = audioFiles
				.filter((file) =>
					families.some((name) => isSameFileFamily(file, name))
				)
				.sort(
					(a, b) =>
						Number(exactNames.has(baseName(b))) -
						Number(exactNames.has(baseName(a)))
				);
			const siblings = isHashedFolderPath(folder)
				? audioByFolder.get(folder) ?? []
				: [];
			const candidates = [...siblings, ...family.filter(inMonth)];
			const ordered = uniq([
				...candidates.filter(isFreeFor),
				...candidates.filter((file) => !isFreeFor(file)),
				...family.filter((file) => !inMonth(file) && isFreeFor(file)),
			]).filter(
				(file) =>
					file !== note.mediaUri &&
					(!claimedBy.has(file) || claimedBy.get(file) === sha1)
			);

			// Unclaimed files first; files other meetings link to only if needed.
			let found: string | null = null;
			for (const file of ordered) {
				if (io.isCancelled?.()) return;
				if (await matches(file)) {
					found = file;
					// Its current owners now need checking too.
					(refs.get(file) ?? []).forEach(enqueue);
					break;
				}
			}

			finalLink.set(note.path, found);
			if (found) {
				claimedBy.set(found, sha1);
				plan.relinks.push({ note, from: note.mediaUri, to: found });
			} else {
				plan.missing.push(note);
			}
		}
	};

	const touchedFolders = () =>
		new Set(
			[...suspects]
				.flatMap((note) => [note.mediaUri, linkOf(note) ?? ""])
				.map(parentOf)
				.filter(isHashedFolderPath)
		);
	const linkedFiles = () =>
		new Set(
			notes
				.map(linkOf)
				.filter((link): link is string => Boolean(link))
		);

	for (;;) {
		await drain();
		if (io.isCancelled?.()) {
			plan.cancelled = true;
			return plan;
		}
		// A recording nobody links to, beside the ones just checked, usually
		// belongs to a meeting whose link went stale when a folder was moved.
		const linked = linkedFiles();
		const orphans = [...touchedFolders()]
			.flatMap((folder) => audioByFolder.get(folder) ?? [])
			.filter((file) => !linked.has(file));
		// Folder moves keep file names, so only an exact name match counts.
		const orphanNames = new Set(orphans.map(baseName));
		const before = queue.length;
		for (const note of notes) {
			if (
				!fileSet.has(note.mediaUri) &&
				orphanNames.has(baseName(note.mediaUri))
			) {
				enqueue(note);
			}
		}
		if (queue.length === before) break;
	}

	// Split meeting folders that end up holding more than one meeting's audio.
	const changed = new Set(plan.relinks.map((relink) => relink.note.path));
	const notesByFinal = groupBy(
		notes.filter((note) => {
			const link = linkOf(note);
			return link !== null && fileSet.has(link);
		}),
		(note) => linkOf(note) as string
	);

	for (const folder of touchedFolders()) {
		const files = audioByFolder.get(folder) ?? [];
		const linked = files.filter((file) => notesByFinal.has(file));
		for (const file of files) {
			if (!notesByFinal.has(file)) plan.unlinked.push(file);
		}
		if (linked.length < 2) continue;
		const ownersOf = (file: string) => notesByFinal.get(file) ?? [];
		// Keep whichever recording already belongs here: an untouched link,
		// else the meeting whose date the folder sits under.
		const keeper =
			linked.find((file) =>
				ownersOf(file).every((note) => !changed.has(note.path))
			) ??
			linked.find((file) =>
				ownersOf(file).some((note) => {
					const day = dateDaySegment(note.dateParts);
					return Boolean(day && folder.includes(day));
				})
			) ??
			linked[0];
		for (const file of linked) {
			if (file === keeper) continue;
			const owners = ownersOf(file);
			plan.moves.push({
				file,
				notes: owners,
				dateParts: owners.find((note) => note.dateParts)?.dateParts ?? null,
			});
		}
	}

	return plan;
}

function dateMonthSegment(parts: RepairDateParts | null): string | null {
	if (!parts?.year || !parts.month) return null;
	return `/${parts.year}/${parts.month}/`;
}

function dateDaySegment(parts: RepairDateParts | null): string | null {
	if (!parts?.year || !parts.month || !parts.day) return null;
	return `/${parts.year}/${parts.month}/${parts.day}/`;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
	const map = new Map<string, T[]>();
	for (const item of items) {
		const k = key(item);
		const list = map.get(k);
		if (list) list.push(item);
		else map.set(k, [item]);
	}
	return map;
}

function uniq<T>(items: T[]): T[] {
	return [...new Set(items)];
}
