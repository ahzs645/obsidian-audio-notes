/**
 * Lossless cutting of single-track audio MP4/M4A files (what macOS and most
 * recorders produce). The encoded AAC frames are copied, not re-encoded, so
 * a cut is instant, keeps the original quality, and stays the same size per
 * minute — unlike decoding to WAV, which turns an hour into hundreds of MB.
 *
 * The output is a "fast start" file: ftyp, a rebuilt moov, then mdat.
 * Edit lists and gapless/iTunes metadata are dropped because they describe
 * the original timeline; the cost is up to one AAC frame (~21 ms) of encoder
 * priming at the start of the first part.
 */

interface Box {
	type: string;
	start: number;
	size: number;
	headerSize: number;
	children?: Box[];
}

export interface SampleTable {
	timescale: number;
	offsets: number[];
	sizes: number[];
	durations: number[];
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "dinf"]);
const SAMPLES_PER_CHUNK = 64;

export class UnsupportedMp4Error extends Error {}

function u32(buf: Uint8Array, at: number): number {
	return ((buf[at] << 24) >>> 0) + (buf[at + 1] << 16) + (buf[at + 2] << 8) + buf[at + 3];
}

function u64(buf: Uint8Array, at: number): number {
	return u32(buf, at) * 2 ** 32 + u32(buf, at + 4);
}

function typeAt(buf: Uint8Array, at: number): string {
	return String.fromCharCode(buf[at], buf[at + 1], buf[at + 2], buf[at + 3]);
}

function parseBoxes(buf: Uint8Array, start: number, end: number): Box[] {
	const boxes: Box[] = [];
	let at = start;
	while (at + 8 <= end) {
		let size = u32(buf, at);
		const type = typeAt(buf, at + 4);
		let headerSize = 8;
		if (size === 1) {
			size = u64(buf, at + 8);
			headerSize = 16;
		} else if (size === 0) {
			size = end - at;
		}
		if (size < headerSize || at + size > end) {
			throw new UnsupportedMp4Error(`Corrupt MP4 box "${type}" at ${at}.`);
		}
		const box: Box = { type, start: at, size, headerSize };
		if (CONTAINERS.has(type)) {
			box.children = parseBoxes(buf, at + headerSize, at + size);
		}
		boxes.push(box);
		at += size;
	}
	return boxes;
}

function child(box: Box | undefined, type: string): Box | undefined {
	return box?.children?.find((entry) => entry.type === type);
}

function payload(buf: Uint8Array, box: Box): Uint8Array {
	return buf.subarray(box.start + box.headerSize, box.start + box.size);
}

function raw(buf: Uint8Array, box: Box): Uint8Array {
	return buf.subarray(box.start, box.start + box.size);
}

function concat(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

function makeBox(type: string, ...parts: Uint8Array[]): Uint8Array {
	const body = concat(parts);
	const out = new Uint8Array(8 + body.length);
	new DataView(out.buffer).setUint32(0, out.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(body, 8);
	return out;
}

function u32Bytes(values: number[]): Uint8Array {
	const out = new Uint8Array(values.length * 4);
	const view = new DataView(out.buffer);
	values.forEach((value, i) => view.setUint32(i * 4, value));
	return out;
}

/** Reads the track's per-sample file offsets, sizes and durations. */
export function readSampleTable(buf: Uint8Array): SampleTable {
	const top = parseBoxes(buf, 0, buf.length);
	const moov = top.find((box) => box.type === "moov");
	if (!moov) throw new UnsupportedMp4Error("No moov box; not an MP4 file.");
	const traks = moov.children?.filter((box) => box.type === "trak") ?? [];
	if (traks.length !== 1) {
		throw new UnsupportedMp4Error(`Expected one track, found ${traks.length}.`);
	}
	const mdia = child(traks[0], "mdia");
	const mdhd = child(mdia, "mdhd");
	const stbl = child(child(mdia, "minf"), "stbl");
	if (!mdhd || !stbl) throw new UnsupportedMp4Error("Missing sample tables.");

	const mdhdBody = payload(buf, mdhd);
	const timescale = mdhdBody[0] === 1 ? u32(mdhdBody, 20) : u32(mdhdBody, 12);

	const stts = child(stbl, "stts");
	const stsz = child(stbl, "stsz");
	const stsc = child(stbl, "stsc");
	const stco = child(stbl, "stco") ?? child(stbl, "co64");
	if (!stts || !stsz || !stsc || !stco) {
		throw new UnsupportedMp4Error("Incomplete sample tables.");
	}
	if (child(stbl, "ctts")) {
		throw new UnsupportedMp4Error("Composition offsets are not supported.");
	}

	const durations: number[] = [];
	const sttsBody = payload(buf, stts);
	for (let i = 0, n = u32(sttsBody, 4); i < n; i++) {
		const count = u32(sttsBody, 8 + i * 8);
		const delta = u32(sttsBody, 12 + i * 8);
		for (let k = 0; k < count; k++) durations.push(delta);
	}

	const sizes: number[] = [];
	const stszBody = payload(buf, stsz);
	const uniform = u32(stszBody, 4);
	const sampleCount = u32(stszBody, 8);
	for (let i = 0; i < sampleCount; i++) {
		sizes.push(uniform || u32(stszBody, 12 + i * 4));
	}

	const chunkOffsets: number[] = [];
	const coBody = payload(buf, stco);
	const wide = stco.type === "co64";
	for (let i = 0, n = u32(coBody, 4); i < n; i++) {
		chunkOffsets.push(wide ? u64(coBody, 8 + i * 8) : u32(coBody, 8 + i * 4));
	}

	const stscBody = payload(buf, stsc);
	const runs: { firstChunk: number; perChunk: number }[] = [];
	for (let i = 0, n = u32(stscBody, 4); i < n; i++) {
		runs.push({ firstChunk: u32(stscBody, 8 + i * 12), perChunk: u32(stscBody, 12 + i * 12) });
	}

	const offsets: number[] = [];
	let sample = 0;
	for (let chunk = 0; chunk < chunkOffsets.length && sample < sampleCount; chunk++) {
		const run = [...runs].reverse().find((entry) => entry.firstChunk <= chunk + 1);
		const perChunk = run?.perChunk ?? 1;
		let at = chunkOffsets[chunk];
		for (let k = 0; k < perChunk && sample < sampleCount; k++, sample++) {
			offsets.push(at);
			at += sizes[sample];
		}
	}
	if (offsets.length !== sampleCount || durations.length < sampleCount) {
		throw new UnsupportedMp4Error("Sample tables disagree.");
	}
	durations.length = sampleCount;
	return { timescale, offsets, sizes, durations };
}

/** Index of the first sample at or after `seconds` (nearest frame boundary). */
export function sampleIndexAt(table: SampleTable, seconds: number): number {
	const target = seconds * table.timescale;
	let time = 0;
	for (let i = 0; i < table.durations.length; i++) {
		if (time + table.durations[i] / 2 > target) return i;
		time += table.durations[i];
	}
	return table.durations.length;
}

/** Media time (seconds) where sample `index` starts. */
export function sampleTime(table: SampleTable, index: number): number {
	let time = 0;
	for (let i = 0; i < index && i < table.durations.length; i++) time += table.durations[i];
	return time / table.timescale;
}

function patchDuration(body: Uint8Array, value: number, offsetV0: number, offsetV1: number): Uint8Array {
	const copy = body.slice();
	const view = new DataView(copy.buffer);
	if (copy[0] === 1) {
		view.setUint32(offsetV1, Math.floor(value / 2 ** 32));
		view.setUint32(offsetV1 + 4, value >>> 0);
	} else {
		view.setUint32(offsetV0, Math.min(value, 0xffffffff));
	}
	return copy;
}

/**
 * Copies samples [from, to) into a new, self-contained M4A file.
 */
export function cutMp4Audio(buf: Uint8Array, from: number, to: number): Uint8Array {
	const table = readSampleTable(buf);
	const first = Math.max(0, Math.min(from, table.sizes.length));
	const last = Math.max(first, Math.min(to, table.sizes.length));
	if (last === first) throw new UnsupportedMp4Error("The cut contains no audio.");

	const top = parseBoxes(buf, 0, buf.length);
	const ftyp = top.find((box) => box.type === "ftyp");
	const moov = top.find((box) => box.type === "moov")!;
	const mvhd = child(moov, "mvhd");
	const trak = moov.children!.find((box) => box.type === "trak")!;
	const tkhd = child(trak, "tkhd");
	const mdia = child(trak, "mdia")!;
	const mdhd = child(mdia, "mdhd")!;
	const minf = child(mdia, "minf")!;
	const stbl = child(minf, "stbl")!;
	const stsd = child(stbl, "stsd");
	if (!mvhd || !tkhd || !stsd) throw new UnsupportedMp4Error("Missing headers.");

	const sizes = table.sizes.slice(first, last);
	const durations = table.durations.slice(first, last);
	const mediaDuration = durations.reduce((sum, d) => sum + d, 0);
	const mvhdBody = payload(buf, mvhd);
	const movieTimescale = mvhdBody[0] === 1 ? u32(mvhdBody, 20) : u32(mvhdBody, 12);
	const movieDuration = Math.round((mediaDuration * movieTimescale) / table.timescale);

	// stts: run-length encoded durations.
	const sttsRuns: number[] = [];
	for (const duration of durations) {
		const n = sttsRuns.length;
		if (n && sttsRuns[n - 1] === duration) sttsRuns[n - 2] += 1;
		else sttsRuns.push(1, duration);
	}
	const stts = makeBox("stts", u32Bytes([0, sttsRuns.length / 2, ...sttsRuns]));
	const stsz = makeBox("stsz", u32Bytes([0, 0, sizes.length, ...sizes]));
	const chunkCount = Math.ceil(sizes.length / SAMPLES_PER_CHUNK);
	const tail = sizes.length % SAMPLES_PER_CHUNK;
	const stscEntries = [1, SAMPLES_PER_CHUNK, 1];
	if (tail && chunkCount > 1) stscEntries.push(chunkCount, tail, 1);
	if (tail && chunkCount === 1) stscEntries[1] = tail;
	const stsc = makeBox("stsc", u32Bytes([0, stscEntries.length / 3, ...stscEntries]));

	const buildMoov = (chunkOffsets: number[]) => {
		const stco = makeBox("stco", u32Bytes([0, chunkOffsets.length, ...chunkOffsets]));
		const newStbl = makeBox("stbl", raw(buf, stsd), stts, stsc, stsz, stco);
		const newMinf = makeBox(
			"minf",
			...minf.children!.map((box) => (box === stbl ? newStbl : raw(buf, box)))
		);
		const newMdia = makeBox(
			"mdia",
			...mdia.children!.map((box) => {
				if (box === minf) return newMinf;
				if (box === mdhd) return makeBox("mdhd", patchDuration(payload(buf, mdhd), mediaDuration, 16, 24));
				return raw(buf, box);
			})
		);
		const newTrak = makeBox(
			"trak",
			...trak.children!
				.filter((box) => box.type !== "edts")
				.map((box) => {
					if (box === mdia) return newMdia;
					if (box === tkhd) return makeBox("tkhd", patchDuration(payload(buf, tkhd), movieDuration, 20, 28));
					return raw(buf, box);
				})
		);
		return makeBox(
			"moov",
			...moov.children!
				.filter((box) => box.type !== "udta" && box.type !== "meta")
				.map((box) => {
					if (box === trak) return newTrak;
					if (box === mvhd) return makeBox("mvhd", patchDuration(mvhdBody, movieDuration, 16, 24));
					return raw(buf, box);
				})
		);
	};

	const ftypBytes = ftyp ? raw(buf, ftyp) : new Uint8Array(0);
	// The moov's size doesn't depend on the offset values, so size it once.
	const moovSize = buildMoov(new Array(chunkCount).fill(0)).length;
	const dataStart = ftypBytes.length + moovSize + 8;
	const chunkOffsets: number[] = [];
	let cursor = dataStart;
	for (let i = 0; i < sizes.length; i++) {
		if (i % SAMPLES_PER_CHUNK === 0) chunkOffsets.push(cursor);
		cursor += sizes[i];
	}
	const mdatParts: Uint8Array[] = [];
	for (let i = first; i < last; i++) {
		mdatParts.push(buf.subarray(table.offsets[i], table.offsets[i] + table.sizes[i]));
	}
	return concat([ftypBytes, buildMoov(chunkOffsets), makeBox("mdat", ...mdatParts)]);
}

/**
 * Splits at `seconds` into two files. Returns the actual split time, which is
 * snapped to the nearest frame (AAC frames are ~21 ms).
 */
export function splitMp4Audio(
	buf: Uint8Array,
	seconds: number
): { first: Uint8Array; second: Uint8Array; splitSec: number } {
	const table = readSampleTable(buf);
	const index = sampleIndexAt(table, seconds);
	if (index <= 0 || index >= table.sizes.length) {
		throw new UnsupportedMp4Error("The split point is outside the recording.");
	}
	return {
		first: cutMp4Audio(buf, 0, index),
		second: cutMp4Audio(buf, index, table.sizes.length),
		splitSec: sampleTime(table, index),
	};
}

export function isMp4AudioExtension(extension: string): boolean {
	return ["m4a", "mp4", "m4b", "aac", "mov"].includes(extension.toLowerCase());
}
