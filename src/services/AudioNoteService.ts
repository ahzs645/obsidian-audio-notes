import { MarkdownView, Notice, TFile } from "obsidian";
import type AutomaticAudioNotes from "../main";
import {
	AudioNote,
	AudioNoteWithPositionInfo,
} from "../AudioNotes";
import { Transcript, parseTranscript } from "../Transcript";
import { secondsToTimeString } from "../utils";

export class AudioNoteService {
	constructor(private plugin: AutomaticAudioNotes) {}

	getAudioNoteBlocks(
		fileContents: string,
		limit: number = Infinity
	): AudioNoteWithPositionInfo[] {
		const currentMdContentLines = fileContents.split(/\r?\n/);
		const allAudioNoteCodeBlockStrings: [
			number,
			number,
			number,
			string[]
		][] = [];
		let inAudioCodeBlock = false;
		for (let i = 0; i < currentMdContentLines.length; i++) {
			const line = currentMdContentLines[i];
			if (inAudioCodeBlock) {
				if (line.trim() === "```") {
					inAudioCodeBlock = false;
					allAudioNoteCodeBlockStrings[
						allAudioNoteCodeBlockStrings.length - 1
					][1] = i;
					allAudioNoteCodeBlockStrings[
						allAudioNoteCodeBlockStrings.length - 1
					][2] = currentMdContentLines[i - 1].length;
				} else {
					allAudioNoteCodeBlockStrings[
						allAudioNoteCodeBlockStrings.length - 1
					][3].push(line);
				}
			}
			if (line.trim() === "```audio-note") {
				allAudioNoteCodeBlockStrings.push([
					i,
					undefined as any,
					undefined as any,
					[],
				]);
				inAudioCodeBlock = true;
			}
			if (
				allAudioNoteCodeBlockStrings.length >= limit &&
				!inAudioCodeBlock
			) {
				break;
			}
		}

		const allAudioNotes: AudioNoteWithPositionInfo[] = [];
		for (const [
			startLineNumber,
			endLineNumber,
			endChNumber,
			lines,
		] of allAudioNoteCodeBlockStrings) {
			const audioNote = AudioNote.fromSrc(lines.join("\n"));
			const audioNoteWithPositionInfo =
				AudioNoteWithPositionInfo.fromAudioNote(
					audioNote,
					startLineNumber,
					endLineNumber,
					endChNumber
				);
			allAudioNotes.push(audioNoteWithPositionInfo);
		}

		return allAudioNotes;
	}

	async getFirstAudioNoteInFile(file: TFile): Promise<AudioNote> {
		const fileContents = await this.plugin.app.vault.read(file);
		const audioNotes: AudioNote[] = this.getAudioNoteBlocks(
			fileContents,
			1
		);
		return audioNotes[0];
	}

	async createNewAudioNoteAtEndOfFile(
		view: MarkdownView,
		audioNote: AudioNote
	): Promise<void> {
		let transcript: Transcript | undefined =
			await this.plugin.transcriptDatastore.getTranscript(
				audioNote.transcriptFilename
			);

		const newAudioNoteSrc = audioNote.toSrc(transcript);
		if (newAudioNoteSrc) {
			await this.plugin.app.vault.append(
				view.file,
				"\n```audio-note\n" + newAudioNoteSrc + "\n```\n"
			);
			new Notice("Created new audio note", 3000);
		}
	}

	getFullAudioSrcPath(audioNote: AudioNote): string | undefined {
		let audioSrcPath: string | undefined = undefined;
		if (
			audioNote.audioFilename.startsWith("https") ||
			audioNote.audioFilename.startsWith("http")
		) {
			audioSrcPath = audioNote.audioFilename;
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

	async regenerateAllAudioNotes(view: MarkdownView) {
		new Notice("Regenerating All Audio Notes...");

		const currentMdFilename = view.file.path;
		const fileContents = await this.plugin.loadFiles([currentMdFilename]);
		const currentMdFileContents = fileContents.get(currentMdFilename);
		if (currentMdFileContents === undefined) {
			console.error(
				`Audio Notes: Could not find current .md: ${currentMdFilename}...? This should be impossible.`
			);
			return;
		}
		const audioNotes = this.getAudioNoteBlocks(currentMdFileContents);

		const translationFilenames: string[] = [];
		for (const audioNote of audioNotes) {
			if (!audioNote.transcriptFilename) {
				continue;
			}
			if (
				audioNote.needsToBeUpdated &&
				!translationFilenames.includes(audioNote.transcriptFilename)
			) {
				translationFilenames.push(audioNote.transcriptFilename);
			}
		}
		const transcriptContents = await this.plugin.loadFiles(
			translationFilenames
		);
		const transcripts: Map<string, Transcript> = new Map();
		for (const [filename, contents] of transcriptContents.entries()) {
			transcripts.set(filename, parseTranscript(contents));
		}

		audioNotes.reverse();
		for (const audioNote of audioNotes) {
			if (audioNote.needsToBeUpdated) {
				if (!audioNote.transcriptFilename) {
					new Notice(
						"No transcript file defined for audio note.",
						10000
					);
					continue;
				}
				let transcript = transcripts.get(audioNote.transcriptFilename);
				if (!transcript) {
					transcript =
						await this.plugin.transcriptDatastore.getTranscript(
							audioNote.transcriptFilename
						);
				}
				const newAudioNoteSrc = audioNote.toSrc(transcript);
				if (!newAudioNoteSrc) continue;
				const [srcStart, srcEnd] =
					this.getAudioNoteStartAndEndPositionInEditor(audioNote);
				if (srcStart && srcEnd) {
					view.editor.replaceRange(newAudioNoteSrc, srcStart, srcEnd);
				}
			}
		}

		new Notice("Audio Notes regeneration complete!");
	}

	async regenerateCurrentAudioNote(view: MarkdownView) {
		new Notice("Regenerating Current Audio Note...");

		const currentMdFilename = view.file.path;
		const fileContents = await this.plugin.loadFiles([currentMdFilename]);
		const currentMdFileContents = fileContents.get(currentMdFilename);
		if (currentMdFileContents === undefined) {
			console.error(
				`Audio Notes: Could not find current .md: ${currentMdFilename}...? This should be impossible.`
			);
			return;
		}
		const audioNotes = this.getAudioNoteBlocks(currentMdFileContents);

		const from = view.editor.getCursor("from");
		const to = view.editor.getCursor("to");

		let audioNote: AudioNoteWithPositionInfo | undefined = undefined;
		for (const note of audioNotes) {
			if (
				from.line >= note.startLineNumber &&
				from.ch >= 0 &&
				to.line <= note.endLineNumber &&
				to.ch <= note.endChNumber
			) {
				audioNote = note;
				break;
			}
		}
		if (!audioNote) {
			new Notice(
				"Please place your cursor inside the Audio Note you want to generate",
				10000
			);
			return;
		}
		if (audioNote.quote) {
			new Notice(
				"Please delete the quote for the audio note before regenerating it",
				10000
			);
			return;
		}

		if (!audioNote.transcriptFilename) {
			return;
		}
		let transcript: Transcript | undefined =
			await this.plugin.transcriptDatastore.getTranscript(
				audioNote.transcriptFilename
			);

		const newAudioNoteSrc = audioNote.toSrc(transcript);
		if (newAudioNoteSrc) {
			const [srcStart, srcEnd] =
				this.getAudioNoteStartAndEndPositionInEditor(audioNote);
			if (srcStart && srcEnd) {
				view.editor.replaceRange(newAudioNoteSrc, srcStart, srcEnd);
			}
			new Notice("Created new audio note", 3000);
		}

		new Notice("Audio Note generation complete!");
	}

	private getAudioNoteStartAndEndPositionInEditor(
		audioNote: AudioNoteWithPositionInfo
	):
		| [{ line: number; ch: number }, { line: number; ch: number }]
		| [undefined, undefined] {
		if (
			audioNote.startLineNumber === undefined ||
			audioNote.endLineNumber === undefined ||
			audioNote.endChNumber === undefined
		) {
			console.error(
				`Audio Notes: Could not find line numbers of audio-note...? This should be impossible.`
			);
			return [undefined, undefined];
		}

		const startLine = audioNote.startLineNumber + 1;
		const startCh = 0;
		const endLine = audioNote.endLineNumber - 1;
		const endCh = audioNote.endChNumber;
		return [
			{ line: startLine, ch: startCh },
			{ line: endLine, ch: endCh },
		];
	}
}
