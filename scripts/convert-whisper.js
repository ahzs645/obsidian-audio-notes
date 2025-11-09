#!/usr/bin/env node
/**
 * Convert WhisperKit `.whisper` archives into standalone audio + transcript JSON files
 * that Audio Notes (and other Obsidian workflows) can consume.
 *
 * Usage:
 *   node scripts/convert-whisper.js \
 *     --input /path/to/file-or-directory \
 *     --audioDir /path/to/output/audio \
 *     --transcriptDir /path/to/output/transcripts \
 *     [--flat] [--dry-run]
 */

const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

const HELP_TEXT = `
Convert WhisperKit .whisper files into Audio Notes–friendly assets.

Required flags:
  --input <path>          Path to a .whisper file or a directory that contains them.
  --audioDir <path>       Where to write extracted audio files.
  --transcriptDir <path>  Where to write processed transcript JSON files.

Optional flags:
  --flat                  Do not create year/month subfolders (default: false).
  --dry-run               Parse archives and report results without writing files.
  --help                  Show this message.

Example:
  node scripts/convert-whisper.js \\
    --input ~/Desktop/WhisperTranscription \\
    --audioDir ~/Vault/MediaArchive/audio \\
    --transcriptDir ~/Vault/transcripts
`.trim();

function parseArgs(argv) {
    const args = {
        input: undefined,
        audioDir: undefined,
        transcriptDir: undefined,
        flat: false,
        dryRun: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        switch (token) {
            case "--input":
                args.input = argv[++i];
                break;
            case "--audioDir":
                args.audioDir = argv[++i];
                break;
            case "--transcriptDir":
                args.transcriptDir = argv[++i];
                break;
            case "--flat":
                args.flat = true;
                break;
            case "--dry-run":
                args.dryRun = true;
                break;
            case "--help":
                console.log(HELP_TEXT);
                process.exit(0);
            default:
                console.error(`Unknown argument: ${token}`);
                console.log(HELP_TEXT);
                process.exit(1);
        }
    }

    if (!args.input || !args.audioDir || !args.transcriptDir) {
        console.error("Missing required arguments.");
        console.log(HELP_TEXT);
        process.exit(1);
    }

    return args;
}

function ensureDir(dirPath) {
    if (!dirPath) return;
    fs.mkdirSync(dirPath, { recursive: true });
}

function slugify(input) {
    return (input || "")
        .normalize("NFKD")
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .toLowerCase();
}

function msFromOffset(offset) {
    if (!offset) return 0;
    const { hours = 0, minutes = 0, seconds = 0, milliseconds = 0 } = offset;
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

function msToSeconds(value) {
    if (typeof value !== "number" || Number.isNaN(value)) return undefined;
    return value / 1000;
}

function normalizeEpoch(value) {
    if (value === undefined || value === null) return undefined;
    const numeric = typeof value === "string" ? Number(value) : value;
    if (typeof numeric !== "number" || Number.isNaN(numeric)) return undefined;
    const APPLE_EPOCH_OFFSET_SECONDS = 978307200;
    const APPLE_EPOCH_OFFSET_MILLISECONDS = APPLE_EPOCH_OFFSET_SECONDS * 1000;
    const candidates = [
        numeric,
        numeric * 1000,
        (numeric + APPLE_EPOCH_OFFSET_SECONDS) * 1000,
        numeric + APPLE_EPOCH_OFFSET_MILLISECONDS,
    ].filter((ms) => Number.isFinite(ms) && ms > 0);
    if (!candidates.length) return undefined;
    const now = Date.now();
    const inReasonableRange = candidates.filter((ms) => {
        const year = new Date(ms).getUTCFullYear();
        return year >= 2000 && year <= 2100;
    });
    const shortlisted = inReasonableRange.length ? inReasonableRange : candidates;
    shortlisted.sort((a, b) => Math.abs(now - a) - Math.abs(now - b));
    return shortlisted[0];
}

function subfolderFromDate(dateValue) {
    const millis = normalizeEpoch(dateValue);
    if (!millis) return undefined;
    const d = new Date(millis);
    if (Number.isNaN(d.getTime())) return undefined;
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    return path.join(String(year), month);
}

function sanitizeExtension(ext) {
    if (!ext) return undefined;
    return ext.startsWith(".") ? ext.slice(1) : ext;
}

function detectAudioExtension(buffer, fallback = "m4a") {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
        return fallback;
    }
    const header = buffer.toString("ascii", 4, 8);
    const riff = buffer.toString("ascii", 0, 4);
    if (riff === "RIFF") return "wav";
    if (header === "ftyp") return "m4a";
    const id3 = buffer.toString("ascii", 0, 3);
    if (id3 === "ID3") return "mp3";
    return fallback;
}

function resolveUniqueFile(dir, filename) {
    const parsed = path.parse(filename);
    let candidate = filename;
    let counter = 1;
    while (fs.existsSync(path.join(dir, candidate))) {
        candidate = `${parsed.name}-${counter}${parsed.ext}`;
        counter++;
    }
    return path.join(dir, candidate);
}

function collectSources(inputPath) {
    const stats = fs.statSync(inputPath);
    if (stats.isDirectory()) {
        const results = [];
        const items = fs.readdirSync(inputPath);
        for (const item of items) {
            const fullPath = path.join(inputPath, item);
            const childStats = fs.statSync(fullPath);
            if (childStats.isDirectory()) {
                results.push(...collectSources(fullPath));
            } else if (childStats.isFile() && item.toLowerCase().endsWith(".whisper")) {
                results.push(fullPath);
            }
        }
        return results;
    }
    if (stats.isFile() && inputPath.toLowerCase().endsWith(".whisper")) {
        return [inputPath];
    }
    return [];
}

function convertWhisperArchive(filePath, options) {
    const zip = new AdmZip(filePath);
    const metadataEntry = zip.getEntry("metadata.json");
    if (!metadataEntry) {
        throw new Error("metadata.json not found in archive.");
    }
    const metadata = JSON.parse(metadataEntry.getData().toString("utf8"));
    const audioEntry = zip.getEntry("originalAudio");
    if (!audioEntry) {
        throw new Error("originalAudio payload missing from archive.");
    }

    const offsetMs = msFromOffset(metadata.startTimeOffset);
    const transcripts = Array.isArray(metadata.transcripts) ? metadata.transcripts : [];

    const segments = transcripts
        .map((segment, index) => {
            const startMs = typeof segment.start === "number" ? segment.start + offsetMs : undefined;
            const endMs = typeof segment.end === "number" ? segment.end + offsetMs : undefined;
            if (startMs === undefined || endMs === undefined) {
                return undefined;
            }
            const words = Array.isArray(segment.words)
                ? segment.words
                    .map((word) => {
                        if (typeof word.startTime !== "number" || typeof word.endTime !== "number") {
                            return undefined;
                        }
                        return {
                            text: word.text || "",
                            start: msToSeconds(word.startTime + offsetMs),
                            end: msToSeconds(word.endTime + offsetMs),
                        };
                    })
                    .filter(Boolean)
                : [];

            return {
                id: segment.id || index,
                start: msToSeconds(startMs),
                end: msToSeconds(endMs),
                text: (segment.text || "").trim(),
                speakerId: segment.speaker?.id ?? null,
                speakerName: segment.speaker?.name ?? null,
                words,
            };
        })
        .filter(Boolean);

    const payload = {
        source: "whisperkit",
        model: metadata.modelQualityID ?? metadata.modelEngine ?? "unknown",
        createdAt: metadata.dateCreated ?? null,
        updatedAt: metadata.dateUpdated ?? null,
        speakers: Array.isArray(metadata.speakers) ? metadata.speakers : [],
        segments,
    };

    const baseName =
        slugify(metadata.originalMediaFilename) ||
        slugify(path.basename(filePath, path.extname(filePath))) ||
        `whisper-${Date.now()}`;

    const audioExt = sanitizeExtension(metadata.originalMediaExtension) || detectAudioExtension(audioEntry.getData());
    const transcriptFileName = `${baseName}.json`;
    const audioFileName = `${baseName}.${audioExt}`;
    const subfolder = options.flat ? "" : subfolderFromDate(metadata.dateCreated) || "unsorted";

    const audioDir = subfolder ? path.join(options.audioDir, subfolder) : options.audioDir;
    const transcriptDir = subfolder ? path.join(options.transcriptDir, subfolder) : options.transcriptDir;

    if (!options.dryRun) {
        ensureDir(audioDir);
        ensureDir(transcriptDir);
    }

    const audioFullPath = subfolder
        ? resolveUniqueFile(audioDir, audioFileName)
        : resolveUniqueFile(audioDir, audioFileName);
    const transcriptFullPath = subfolder
        ? resolveUniqueFile(transcriptDir, transcriptFileName)
        : resolveUniqueFile(transcriptDir, transcriptFileName);

    if (!options.dryRun) {
        fs.writeFileSync(audioFullPath, audioEntry.getData());
        fs.writeFileSync(transcriptFullPath, JSON.stringify(payload, null, 2));
    }

    return {
        source: filePath,
        audioPath: audioFullPath,
        transcriptPath: transcriptFullPath,
        segmentCount: segments.length,
        durationSeconds: segments.length ? segments[segments.length - 1].end - segments[0].start : 0,
    };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const sources = collectSources(path.resolve(args.input));
    if (!sources.length) {
        console.error("No .whisper files found at the provided path.");
        process.exit(1);
    }

    console.log(`Found ${sources.length} .whisper file(s). Starting conversion...`);
    const summaries = [];
    let failures = 0;

    for (const file of sources) {
        try {
            const summary = convertWhisperArchive(file, {
                audioDir: path.resolve(args.audioDir),
                transcriptDir: path.resolve(args.transcriptDir),
                flat: args.flat,
                dryRun: args.dryRun,
            });
            summaries.push(summary);
            console.log(`✓ ${path.basename(file)} → ${path.relative(process.cwd(), summary.transcriptPath)}`);
        } catch (error) {
            failures += 1;
            console.error(`✗ Failed to convert ${file}: ${(error && error.message) || error}`);
        }
    }

    console.log("\nConversion summary:");
    summaries.forEach((summary) => {
        console.log(
            `• Audio: ${summary.audioPath}\n  Transcript: ${summary.transcriptPath}\n  Segments: ${summary.segmentCount}`
        );
    });
    if (failures) {
        console.error(`\nCompleted with ${failures} failure(s).`);
        process.exit(1);
    } else {
        console.log("\nAll archives converted successfully.");
    }
}

main();
