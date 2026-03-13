#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");

const AUDIO_KEYS = ["media_uri", "audio", "media"];

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printHelp();
		return;
	}

	if (!args.vaultRoot || !args.driveRoot) {
		printHelp("Both --vault-root and --drive-root are required.");
		process.exitCode = 1;
		return;
	}

	const vaultRoot = path.resolve(args.vaultRoot);
	const driveRoot = path.resolve(args.driveRoot);
	const notesRoot = args.notesRoot
		? path.resolve(vaultRoot, args.notesRoot)
		: vaultRoot;
	const sourceAudioRoot = args.sourceAudioRoot
		? path.resolve(vaultRoot, args.sourceAudioRoot)
		: null;
	const apply = Boolean(args.apply);
	const keepMediaUri = Boolean(args.keepMediaUri);
	const mode = args.mode || "move";
	if (mode !== "move" && mode !== "copy") {
		printHelp(`Invalid --mode value: ${mode}`);
		process.exitCode = 1;
		return;
	}

	await assertDirectory(vaultRoot, "--vault-root");
	await assertDirectory(driveRoot, "--drive-root");
	await assertDirectory(notesRoot, "--notes-root");
	if (sourceAudioRoot) {
		await assertDirectory(sourceAudioRoot, "--source-audio-root");
	}

	const markdownFiles = await collectMarkdownFiles(notesRoot);
	const usedTargetPaths = new Set();
	const sourcePlans = new Map();
	const notePlans = [];
	const skipped = [];

	for (const notePath of markdownFiles) {
		const noteText = await fs.readFile(notePath, "utf8");
		const lineEnding = detectLineEnding(noteText);
		const frontmatter = extractFrontmatter(noteText);
		if (!frontmatter) {
			continue;
		}

		const parsed = parseFrontmatter(frontmatter.content);
		const scalarValues = getScalarMap(parsed.entries);
		const audioKey = AUDIO_KEYS.find((key) =>
			Object.prototype.hasOwnProperty.call(scalarValues, key)
		);
		if (!audioKey) {
			continue;
		}

		const audioValue = scalarValues[audioKey];
		if (!audioValue || hasScheme(audioValue)) {
			continue;
		}

		const sourceRelative = normalizeRelativePath(audioValue);
		const sourceAbsolute = path.resolve(vaultRoot, sourceRelative);
		if (!isWithinRoot(vaultRoot, sourceAbsolute)) {
			skipped.push({
				note: path.relative(vaultRoot, notePath),
				reason: `audio path escapes vault: ${audioValue}`,
			});
			continue;
		}

		const sourceStat = await safeStat(sourceAbsolute);
		if (!sourceStat || !sourceStat.isFile()) {
			skipped.push({
				note: path.relative(vaultRoot, notePath),
				reason: `audio file missing: ${audioValue}`,
			});
			continue;
		}

		if (sourceAudioRoot && !isWithinRoot(sourceAudioRoot, sourceAbsolute)) {
			skipped.push({
				note: path.relative(vaultRoot, notePath),
				reason: `audio file is outside --source-audio-root: ${audioValue}`,
			});
			continue;
		}

		let sourcePlan = sourcePlans.get(sourceAbsolute);
		if (!sourcePlan) {
			const preferredRelativeTarget = buildRelativeTargetPath({
				notePath,
				vaultRoot,
				sourceAbsolute,
				sourceAudioRoot,
				scalarValues,
			});
			const targetRelative = ensureUniqueRelativeTarget(
				preferredRelativeTarget,
				usedTargetPaths
			);
			const targetAbsolute = path.join(
				driveRoot,
				...targetRelative.split("/")
			);
			sourcePlan = {
				sourceAbsolute,
				sourceRelative: normalizeRelativePath(
					path.relative(vaultRoot, sourceAbsolute)
				),
				targetAbsolute,
				targetRelative,
				notes: [],
			};
			sourcePlans.set(sourceAbsolute, sourcePlan);
		}

		const updatedEntries = cloneEntries(parsed.entries);
		if (!keepMediaUri) {
			removeEntry(updatedEntries, audioKey);
		}
		setScalarEntry(updatedEntries, "recording_archive", "google-drive");
		setScalarEntry(
			updatedEntries,
			"recording_drive_path",
			sourcePlan.targetRelative
		);
		const updatedFrontmatter = serializeFrontmatter(
			updatedEntries,
			lineEnding,
			parsed.preamble
		);
		const updatedNoteText = replaceFrontmatter(
			noteText,
			updatedFrontmatter,
			frontmatter,
			lineEnding
		);

		const notePlan = {
			noteAbsolute: notePath,
			noteRelative: normalizeRelativePath(path.relative(vaultRoot, notePath)),
			audioKey,
			audioValue,
			updatedNoteText,
			targetRelative: sourcePlan.targetRelative,
		};
		notePlans.push(notePlan);
		sourcePlan.notes.push(notePlan);
	}

	const manifest = {
		applied: apply,
		mode,
		vaultRoot,
		driveRoot,
		sourceAudioRoot,
		keepMediaUri,
		summary: {
			markdownFilesScanned: markdownFiles.length,
			notesToUpdate: notePlans.length,
			audioFilesToArchive: sourcePlans.size,
			skipped: skipped.length,
		},
		files: Array.from(sourcePlans.values()).map((plan) => ({
			source: plan.sourceRelative,
			target: plan.targetRelative,
			notes: plan.notes.map((note) => note.noteRelative),
		})),
		skipped,
	};

	if (args.manifest) {
		const manifestPath = path.resolve(args.manifest);
		await fs.mkdir(path.dirname(manifestPath), { recursive: true });
		await fs.writeFile(
			manifestPath,
			JSON.stringify(manifest, null, 2) + "\n",
			"utf8"
		);
	}

	printSummary(manifest);

	if (!apply) {
		console.log(
			"\nDry run only. Re-run with --apply to move notes and audio."
		);
		return;
	}

	const copiedSources = new Set();
	const notesWritten = new Set();

	for (const sourcePlan of sourcePlans.values()) {
		await fs.mkdir(path.dirname(sourcePlan.targetAbsolute), {
			recursive: true,
		});
		if (!(await sameFile(sourcePlan.sourceAbsolute, sourcePlan.targetAbsolute))) {
			await fs.copyFile(sourcePlan.sourceAbsolute, sourcePlan.targetAbsolute);
		}
		copiedSources.add(sourcePlan.sourceAbsolute);
	}

	for (const notePlan of notePlans) {
		await fs.writeFile(notePlan.noteAbsolute, notePlan.updatedNoteText, "utf8");
		notesWritten.add(notePlan.noteAbsolute);
	}

	if (mode === "move") {
		for (const sourcePlan of sourcePlans.values()) {
			if (
				copiedSources.has(sourcePlan.sourceAbsolute) &&
				sourcePlan.notes.every((note) => notesWritten.has(note.noteAbsolute))
			) {
				if (
					!(
						await sameFile(
							sourcePlan.sourceAbsolute,
							sourcePlan.targetAbsolute
						)
					)
				) {
					await fs.unlink(sourcePlan.sourceAbsolute);
					await pruneEmptyParents(
						path.dirname(sourcePlan.sourceAbsolute),
						sourceAudioRoot || vaultRoot
					);
				}
			}
		}
	}

	console.log("\nMigration applied.");
}

function parseArgs(argv) {
	const args = {
		mode: "move",
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--help":
			case "-h":
				args.help = true;
				break;
			case "--apply":
				args.apply = true;
				break;
			case "--keep-media-uri":
				args.keepMediaUri = true;
				break;
			case "--vault-root":
			case "--drive-root":
			case "--notes-root":
			case "--source-audio-root":
			case "--mode":
			case "--manifest": {
				const value = argv[index + 1];
				if (!value || value.startsWith("--")) {
					throw new Error(`Missing value for ${arg}`);
				}
				args[toCamelCase(arg.slice(2))] = value;
				index += 1;
				break;
			}
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return args;
}

function printHelp(error) {
	if (error) {
		console.error(error);
		console.error("");
	}
	console.log(`Usage:
  node scripts/migrate-google-drive-audio.js \\
    --vault-root "/path/to/vault" \\
    --drive-root "/path/to/google-drive/Meetings" \\
    [--notes-root "meetings"] \\
    [--source-audio-root "MediaArchive/audio"] \\
    [--mode move|copy] \\
    [--keep-media-uri] \\
    [--manifest "/tmp/archive-report.json"] \\
    [--apply]

Behavior:
  - Scans Markdown notes for media_uri/audio/media frontmatter
  - Moves or copies vault audio into the Google Drive local sync folder
  - Rewrites notes to use:
      recording_archive: google-drive
      recording_drive_path: <path relative to --drive-root>
  - Removes media_uri by default so the vault stops syncing archived audio

Notes:
  - Run without --apply first to review the dry-run output
  - Default mode is move
  - recording_url is not generated automatically because Google Drive links are not path-derived
`);
}

function toCamelCase(value) {
	return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

async function assertDirectory(targetPath, label) {
	const stat = await safeStat(targetPath);
	if (!stat || !stat.isDirectory()) {
		throw new Error(`${label} is not a directory: ${targetPath}`);
	}
}

async function safeStat(targetPath) {
	try {
		return await fs.stat(targetPath);
	} catch (error) {
		if (error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

async function collectMarkdownFiles(rootPath) {
	const entries = await fs.readdir(rootPath, { withFileTypes: true });
	const results = [];
	for (const entry of entries) {
		if (entry.name === ".obsidian") {
			continue;
		}
		const absolutePath = path.join(rootPath, entry.name);
		if (entry.isDirectory()) {
			results.push(...(await collectMarkdownFiles(absolutePath)));
			continue;
		}
		if (entry.isFile() && absolutePath.toLowerCase().endsWith(".md")) {
			results.push(absolutePath);
		}
	}
	return results.sort();
}

function detectLineEnding(text) {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

function extractFrontmatter(text) {
	const lineEnding = detectLineEnding(text);
	const lines = text.split(/\r?\n/);
	if (lines[0] !== "---") {
		return null;
	}
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index] === "---") {
			return {
				startLine: 0,
				endLine: index,
				content: lines.slice(1, index).join(lineEnding),
			};
		}
	}
	return null;
}

function parseFrontmatter(content) {
	const lines = content ? content.split(/\r?\n/) : [];
	const entries = [];
	const preamble = [];
	let currentEntry = null;

	for (const line of lines) {
		if (/^[A-Za-z0-9_-]+:/.test(line)) {
			currentEntry = {
				key: line.slice(0, line.indexOf(":")),
				lines: [line],
			};
			entries.push(currentEntry);
			continue;
		}
		if (currentEntry) {
			currentEntry.lines.push(line);
		} else {
			preamble.push(line);
		}
	}

	return { preamble, entries };
}

function getScalarMap(entries) {
	const values = {};
	for (const entry of entries) {
		if (!entry.lines.length) continue;
		const firstLine = entry.lines[0];
		const value = firstLine.slice(firstLine.indexOf(":") + 1).trim();
		values[entry.key] = unquoteYamlScalar(value);
	}
	return values;
}

function unquoteYamlScalar(value) {
	if (!value) return "";
	if (
		(value.startsWith("'") && value.endsWith("'")) ||
		(value.startsWith('"') && value.endsWith('"'))
	) {
		const unwrapped = value.slice(1, -1);
		return value.startsWith("'")
			? unwrapped.replace(/''/g, "'")
			: unwrapped.replace(/\\"/g, '"');
	}
	return value;
}

function hasScheme(value) {
	return /^[a-z]+:\/\//i.test(value);
}

function normalizeRelativePath(value) {
	return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function isWithinRoot(rootPath, targetPath) {
	const relative = path.relative(rootPath, targetPath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function buildRelativeTargetPath({
	notePath,
	vaultRoot,
	sourceAbsolute,
	sourceAudioRoot,
	scalarValues,
}) {
	if (sourceAudioRoot) {
		return normalizeRelativePath(path.relative(sourceAudioRoot, sourceAbsolute));
	}

	const noteRelative = normalizeRelativePath(path.relative(vaultRoot, notePath));
	const dateParts = resolveDateParts(scalarValues, noteRelative);
	const noteSlug = slugify(
		scalarValues.title || path.basename(notePath, path.extname(notePath))
	);
	const filename = path.basename(sourceAbsolute);
	return [...dateParts, noteSlug, filename]
		.filter(Boolean)
		.join("/");
}

function resolveDateParts(scalarValues, noteRelative) {
	const candidates = [
		scalarValues.start_date,
		scalarValues.date,
		scalarValues.start,
	];
	for (const candidate of candidates) {
		const parts = parseDateParts(candidate);
		if (parts) {
			return parts;
		}
	}

	const notePathMatch = noteRelative.match(/(^|\/)(\d{4})\/(\d{2})\/(\d{2})(\/|$)/);
	if (notePathMatch) {
		return [notePathMatch[2], notePathMatch[3], notePathMatch[4]];
	}

	return ["undated"];
}

function parseDateParts(value) {
	if (!value) return null;
	const match = String(value).match(/(\d{4})-(\d{2})-(\d{2})/);
	return match ? [match[1], match[2], match[3]] : null;
}

function slugify(value) {
	return (
		String(value)
			.normalize("NFKD")
			.replace(/[^\w.\- ]+/g, "")
			.trim()
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-+|-+$/g, "")
			.toLowerCase() || "meeting"
	);
}

function ensureUniqueRelativeTarget(targetRelative, usedTargetPaths) {
	const normalized = normalizeRelativePath(targetRelative);
	if (!usedTargetPaths.has(normalized)) {
		usedTargetPaths.add(normalized);
		return normalized;
	}

	const ext = path.posix.extname(normalized);
	const base = ext ? normalized.slice(0, -ext.length) : normalized;
	let counter = 1;
	while (usedTargetPaths.has(`${base}-${counter}${ext}`)) {
		counter += 1;
	}
	const unique = `${base}-${counter}${ext}`;
	usedTargetPaths.add(unique);
	return unique;
}

function cloneEntries(entries) {
	return entries.map((entry) => ({
		key: entry.key,
		lines: [...entry.lines],
	}));
}

function removeEntry(entries, key) {
	const index = entries.findIndex((entry) => entry.key === key);
	if (index !== -1) {
		entries.splice(index, 1);
	}
}

function setScalarEntry(entries, key, value) {
	const rendered = `${key}: ${yamlQuote(value)}`;
	const existing = entries.find((entry) => entry.key === key);
	if (existing) {
		existing.lines = [rendered];
		return;
	}
	entries.push({ key, lines: [rendered] });
}

function yamlQuote(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}

function serializeFrontmatter(entries, lineEnding, preamble) {
	const blocks = [];
	if (preamble.length) {
		blocks.push(...preamble);
	}
	for (const entry of entries) {
		blocks.push(...entry.lines);
	}
	return blocks.join(lineEnding);
}

function replaceFrontmatter(text, updatedFrontmatter, frontmatter, lineEnding) {
	const lines = text.split(/\r?\n/);
	const before = lines.slice(0, frontmatter.startLine);
	const after = lines.slice(frontmatter.endLine + 1);
	const rebuilt = [
		...before,
		"---",
		...updatedFrontmatter.split(/\r?\n/),
		"---",
		...after,
	];
	return rebuilt.join(lineEnding);
}

function printSummary(manifest) {
	console.log(`Scanned Markdown files: ${manifest.summary.markdownFilesScanned}`);
	console.log(`Notes to update: ${manifest.summary.notesToUpdate}`);
	console.log(`Audio files to archive: ${manifest.summary.audioFilesToArchive}`);
	console.log(`Skipped notes: ${manifest.summary.skipped}`);

	if (manifest.files.length) {
		console.log("\nPlanned archive moves:");
		for (const file of manifest.files.slice(0, 20)) {
			console.log(`- ${file.source} -> ${file.target}`);
			for (const note of file.notes) {
				console.log(`  note: ${note}`);
			}
		}
		if (manifest.files.length > 20) {
			console.log(`- ... ${manifest.files.length - 20} more`);
		}
	}

	if (manifest.skipped.length) {
		console.log("\nSkipped:");
		for (const item of manifest.skipped.slice(0, 20)) {
			console.log(`- ${item.note}: ${item.reason}`);
		}
		if (manifest.skipped.length > 20) {
			console.log(`- ... ${manifest.skipped.length - 20} more`);
		}
	}
}

async function sameFile(leftPath, rightPath) {
	try {
		const [leftReal, rightReal] = await Promise.all([
			fs.realpath(leftPath),
			fs.realpath(rightPath),
		]);
		return leftReal === rightReal;
	} catch (error) {
		if (error && error.code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

async function pruneEmptyParents(startPath, stopPath) {
	let currentPath = startPath;
	while (isWithinRoot(stopPath, currentPath) && currentPath !== stopPath) {
		const entries = await fs.readdir(currentPath);
		if (entries.length > 0) {
			return;
		}
		await fs.rmdir(currentPath);
		currentPath = path.dirname(currentPath);
	}
}

main().catch((error) => {
	console.error(error.message || error);
	process.exitCode = 1;
});
