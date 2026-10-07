import { splitAudioToWav } from "../AudioTrimmer";
import { splitCafAudio } from "./CafAudioCutter";
import { isMp4AudioExtension, splitMp4Audio, UnsupportedMp4Error } from "./Mp4AudioCutter";

export interface AudioSplit {
	first: Uint8Array;
	second: Uint8Array;
	/** Where the cut actually landed (snapped to a frame). */
	splitSec: number;
	extension: string;
	/** True when the parts are re-encoded WAV rather than copied frames. */
	reencoded: boolean;
}

/**
 * Cuts a recording in two, losslessly when the container allows it (M4A/MP4
 * and uncompressed CAF), otherwise by decoding and writing WAV.
 */
export async function splitAudio(
	data: Uint8Array,
	extension: string,
	splitSec: number
): Promise<AudioSplit> {
	const ext = extension.toLowerCase();
	try {
		if (isMp4AudioExtension(ext)) {
			return { ...splitMp4Audio(data, splitSec), extension: ext === "mov" ? "m4a" : ext, reencoded: false };
		}
		if (ext === "caf") {
			return { ...splitCafAudio(data, splitSec), extension: ext, reencoded: false };
		}
	} catch (error) {
		if (!(error instanceof UnsupportedMp4Error)) throw error;
		console.warn("Audio Notes: lossless split unavailable, re-encoding as WAV.", error);
	}
	const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
	const wav = await splitAudioToWav(copy, splitSec);
	return {
		first: new Uint8Array(wav.first),
		second: new Uint8Array(wav.second),
		splitSec: wav.splitSec,
		extension: "wav",
		reencoded: true,
	};
}
