/**
 * Audio trimming utilities using Web Audio API.
 * Decodes any supported audio format, slices the PCM buffer,
 * and re-encodes as WAV for reliable output.
 */

export interface TrimRange {
	startSec: number;
	endSec: number;
}

/**
 * Decode an audio buffer, slice it to the given time range,
 * and return a WAV-encoded ArrayBuffer.
 */
export async function trimAudioToWav(
	audioData: ArrayBuffer,
	range: TrimRange
): Promise<ArrayBuffer> {
	const audioCtx = new AudioContext();
	try {
		const decoded = await audioCtx.decodeAudioData(audioData.slice(0));
		const sampleRate = decoded.sampleRate;
		const startSample = Math.max(
			0,
			Math.floor(range.startSec * sampleRate)
		);
		const endSample = Math.min(
			decoded.length,
			Math.ceil(range.endSec * sampleRate)
		);
		const length = endSample - startSample;
		if (length <= 0) {
			throw new Error("Trim range is empty — no audio samples to keep.");
		}
		const trimmed = audioCtx.createBuffer(
			decoded.numberOfChannels,
			length,
			sampleRate
		);
		for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
			const source = decoded.getChannelData(ch);
			trimmed.copyToChannel(source.subarray(startSample, endSample), ch);
		}
		return encodeWav(trimmed);
	} finally {
		await audioCtx.close();
	}
}

/** Encode an AudioBuffer as a WAV file (PCM 16-bit). */
function encodeWav(buffer: AudioBuffer): ArrayBuffer {
	const numChannels = buffer.numberOfChannels;
	const sampleRate = buffer.sampleRate;
	const bitsPerSample = 16;
	const bytesPerSample = bitsPerSample / 8;
	const blockAlign = numChannels * bytesPerSample;
	const numSamples = buffer.length;
	const dataSize = numSamples * blockAlign;
	const headerSize = 44;
	const totalSize = headerSize + dataSize;

	const arrayBuffer = new ArrayBuffer(totalSize);
	const view = new DataView(arrayBuffer);

	// RIFF header
	writeString(view, 0, "RIFF");
	view.setUint32(4, totalSize - 8, true);
	writeString(view, 8, "WAVE");

	// fmt sub-chunk
	writeString(view, 12, "fmt ");
	view.setUint32(16, 16, true); // sub-chunk size
	view.setUint16(20, 1, true); // PCM format
	view.setUint16(22, numChannels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * blockAlign, true); // byte rate
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, bitsPerSample, true);

	// data sub-chunk
	writeString(view, 36, "data");
	view.setUint32(40, dataSize, true);

	// Interleave channel data and convert float32 → int16
	const channels: Float32Array[] = [];
	for (let ch = 0; ch < numChannels; ch++) {
		channels.push(buffer.getChannelData(ch));
	}
	let offset = headerSize;
	for (let i = 0; i < numSamples; i++) {
		for (let ch = 0; ch < numChannels; ch++) {
			const sample = Math.max(-1, Math.min(1, channels[ch][i]));
			const int16 =
				sample < 0
					? Math.round(sample * 0x8000)
					: Math.round(sample * 0x7fff);
			view.setInt16(offset, int16, true);
			offset += 2;
		}
	}

	return arrayBuffer;
}

function writeString(view: DataView, offset: number, value: string) {
	for (let i = 0; i < value.length; i++) {
		view.setUint8(offset + i, value.charCodeAt(i));
	}
}
