/**
 * Lossless splitting of uncompressed (LPCM) Core Audio Format files, which
 * older macOS system-audio recordings use. Chromium can't decode CAF, so
 * these are cut by byte range: every chunk before the audio is copied and a
 * new data chunk holds the frames for each part.
 */

import { UnsupportedMp4Error } from "./Mp4AudioCutter";

export class UnsupportedCafError extends UnsupportedMp4Error {}

interface CafLayout {
	header: Uint8Array;
	audio: Uint8Array;
	sampleRate: number;
	bytesPerFrame: number;
}

function typeAt(buf: Uint8Array, at: number): string {
	return String.fromCharCode(buf[at], buf[at + 1], buf[at + 2], buf[at + 3]);
}

function readCaf(buf: Uint8Array): CafLayout {
	if (buf.length < 8 || typeAt(buf, 0) !== "caff") {
		throw new UnsupportedCafError("Not a CAF file.");
	}
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let at = 8;
	let sampleRate = 0;
	let bytesPerFrame = 0;
	while (at + 12 <= buf.length) {
		const type = typeAt(buf, at);
		const high = view.getInt32(at + 4);
		const low = view.getUint32(at + 8);
		const declared = high * 2 ** 32 + low;
		const bodyStart = at + 12;
		if (type === "desc") {
			sampleRate = view.getFloat64(bodyStart);
			const format = typeAt(buf, bodyStart + 8);
			const bytesPerPacket = view.getUint32(bodyStart + 16);
			const framesPerPacket = view.getUint32(bodyStart + 20);
			if (format !== "lpcm" || !bytesPerPacket || framesPerPacket !== 1) {
				throw new UnsupportedCafError(`CAF audio "${format}" can't be cut losslessly.`);
			}
			bytesPerFrame = bytesPerPacket;
		}
		if (type === "data") {
			if (!sampleRate || !bytesPerFrame) throw new UnsupportedCafError("CAF data before its description.");
			// -1 means "until the end of the file" (a recording still being written).
			const end = declared < 0 ? buf.length : Math.min(buf.length, bodyStart + declared);
			return {
				header: buf.subarray(0, at),
				audio: buf.subarray(bodyStart + 4, end),
				sampleRate,
				bytesPerFrame,
			};
		}
		if (declared < 0) break;
		at = bodyStart + declared;
	}
	throw new UnsupportedCafError("CAF file has no audio data.");
}

function writeCaf(header: Uint8Array, audio: Uint8Array): Uint8Array {
	const out = new Uint8Array(header.length + 16 + audio.length);
	out.set(header, 0);
	const view = new DataView(out.buffer);
	let at = header.length;
	for (let i = 0; i < 4; i++) out[at + i] = "data".charCodeAt(i);
	const size = audio.length + 4;
	view.setUint32(at + 4, Math.floor(size / 2 ** 32));
	view.setUint32(at + 8, size >>> 0);
	view.setUint32(at + 12, 0); // edit count
	out.set(audio, at + 16);
	return out;
}

export function splitCafAudio(
	buf: Uint8Array,
	seconds: number
): { first: Uint8Array; second: Uint8Array; splitSec: number } {
	const caf = readCaf(buf);
	const totalFrames = Math.floor(caf.audio.length / caf.bytesPerFrame);
	const frame = Math.round(seconds * caf.sampleRate);
	if (frame <= 0 || frame >= totalFrames) {
		throw new UnsupportedCafError("The split point is outside the recording.");
	}
	const cut = frame * caf.bytesPerFrame;
	return {
		first: writeCaf(caf.header, caf.audio.subarray(0, cut)),
		second: writeCaf(caf.header, caf.audio.subarray(cut, totalFrames * caf.bytesPerFrame)),
		splitSec: frame / caf.sampleRate,
	};
}
