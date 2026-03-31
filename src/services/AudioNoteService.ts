import type { TFile } from "obsidian";
import type AutomaticAudioNotes from "../main";
import type { AudioNote } from "../AudioNotes";
import {
	isAbsoluteFilesystemPath,
	toAudioSrcUrl,
} from "../googleDriveArchive";
import { secondsToTimeString } from "../utils";

export class AudioNoteService {
	constructor(private plugin: AutomaticAudioNotes) {}

	getFullAudioSrcPath(audioNote: AudioNote): string | undefined {
		let audioSrcPath: string | undefined = undefined;
		if (
			audioNote.audioFilename.startsWith("https") ||
			audioNote.audioFilename.startsWith("http")
		) {
			audioSrcPath = audioNote.audioFilename;
		} else if (isAbsoluteFilesystemPath(audioNote.audioFilename)) {
			audioSrcPath = toAudioSrcUrl(audioNote.audioFilename);
		} else {
			const tfile = this.plugin.app.vault.getAbstractFileByPath(
				audioNote.audioFilename
			);
			if (!tfile) {
				console.error(
					`AudioNotes: Could not find audio file: ${audioNote.audioFilename}`
				);
				return undefined;
			}
			audioSrcPath = this.plugin.app.vault.getResourcePath(tfile as TFile);
		}
		if (audioSrcPath.includes("?")) {
			audioSrcPath = audioSrcPath.slice(0, audioSrcPath.indexOf("?"));
		}
		audioSrcPath += `#t=${secondsToTimeString(audioNote.start, false)}`;
		if (audioNote.end !== Infinity) {
			audioSrcPath += `,${secondsToTimeString(audioNote.end, false)}`;
		}
		return audioSrcPath;
	}
}
