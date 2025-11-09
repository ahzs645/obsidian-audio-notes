import {
	MarkdownRenderer,
	MarkdownRenderChild,
	MarkdownView,
	type MarkdownPostProcessorContext,
} from "obsidian";
import TranscriptDisplay from "../transcript-view/TranscriptDisplay.svelte";
import type { TranscriptSegmentWithSpeaker } from "../transcript-view/types";
import { AudioNote } from "../AudioNotes";
import type { Transcript } from "../Transcript";
import type AutomaticAudioNotes from "../main";

class TranscriptViewRenderChild extends MarkdownRenderChild {
	private destroyed = false;

	constructor(
		containerEl: HTMLElement,
		private component: TranscriptDisplay
	) {
		super(containerEl);
	}

	get isDestroyed(): boolean {
		return this.destroyed;
	}

	public setProps(props: Record<string, unknown>) {
		if (!this.destroyed) {
			this.component.$set(props);
		}
	}

	onunload(): void {
		this.destroyed = true;
		this.component.$destroy();
	}
}

export async function renderAudioNote(
	plugin: AutomaticAudioNotes,
	src: string,
	el: HTMLElement,
	ctx?: MarkdownPostProcessorContext
) {
	try {
		const currentMdFilename =
			typeof ctx == "string"
				? ctx
				: ctx?.sourcePath ??
				  plugin.app.workspace.getActiveFile()?.path ??
				  "";

		const audioNote = AudioNote.fromSrc(src);
		const theDiv = createAudioNoteDiv(
			plugin,
			audioNote,
			currentMdFilename,
			ctx
		);

		el.replaceWith(theDiv);

		const markdownView =
			plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (markdownView) {
			const playersInSource = getAudioHTMLMediaElementsInMode(
				(markdownView as any).modes.source.editorEl
			);
			const playersInReading = getAudioHTMLMediaElementsInMode(
				(markdownView as any).modes.preview.containerEl
			);
			const generatedAudioDiv =
				getAudioHTMLMediaElementsInMode(theDiv);
			const allPlayers = [
				...playersInSource,
				...playersInReading,
				...generatedAudioDiv,
			];
			for (const player of allPlayers) {
				plugin.knownAudioPlayers.add(player);
			}
		}

		plugin.handleFirstRender();
	} catch (error) {
		console.error(`Audio Notes: ${error}`);
		plugin.replaceElementWithError(el, error as Error);
	}
}

function createAudioNoteDiv(
	plugin: AutomaticAudioNotes,
	audioNote: AudioNote,
	currentMdFilename: string,
	ctx?: MarkdownPostProcessorContext
): HTMLElement {
	const calloutDiv = createDiv({
		cls: `callout audio-note ${""}`,
		attr: {
			"data-callout": "quote",
			"data-callout-fold": "",
		},
	});

	const contentEl: HTMLDivElement = calloutDiv.createDiv("callout-content");
	if (audioNote.quote) {
		MarkdownRenderer.renderMarkdown(
			audioNote.quote,
			contentEl,
			currentMdFilename,
			plugin
		);
	}

	const transcriptWrapper = contentEl.createDiv({
		cls: "audio-note-transcript-wrapper",
	});

	const transcriptComponent = new TranscriptDisplay({
		target: transcriptWrapper,
		props: {
			segments: [],
			transcriptText: audioNote.quote ?? "",
			metadataDuration: null,
			isTranscribing: false,
			syncWithAudio: audioNote.liveUpdate,
			onSeekToTime: () => {},
			playerContainer: null,
		},
	});

	let transcriptChild: TranscriptViewRenderChild | undefined = undefined;
	if (ctx) {
		transcriptChild = new TranscriptViewRenderChild(
			transcriptWrapper,
			transcriptComponent
		);
		ctx.addChild(transcriptChild);
	}

	const setTranscriptProps = (props: Record<string, unknown>) => {
		if (transcriptChild) {
			transcriptChild.setProps(props);
		} else {
			transcriptComponent.$set(props);
		}
	};

	if (audioNote.author) {
		const authorEl = calloutDiv.createDiv({ cls: "audio-note-author" });
		let authorStr = audioNote.author;
		if (authorStr.startsWith("-")) {
			authorStr = `\\${authorStr}`;
		}
		const authorInnerEl = authorEl.createDiv("audio-note-author");
		MarkdownRenderer.renderMarkdown(
			authorStr,
			authorInnerEl,
			currentMdFilename,
			plugin
		);
	}

	if (!audioNote.audioFilename.includes("youtube.com")) {
		const [audio, audioDiv] = plugin.createAudioPlayerElements(
			audioNote,
			setTranscriptProps
		);
		if (audioDiv === undefined || audio === undefined) {
			return calloutDiv;
		}
		setTranscriptProps({
			playerContainer: audioDiv,
		});
		plugin.knownAudioPlayers.add(audioDiv);

		plugin.transcriptDatastore
			.getTranscript(audioNote.transcriptFilename)
			.then((transcript: Transcript | undefined) => {
				if (transcript) {
					const transcriptSegments =
						transcript.segments as TranscriptSegmentWithSpeaker[];
					const duration =
						transcriptSegments.length > 0
							? Math.max(
									...transcriptSegments.map((segment) =>
										Number(segment.end ?? segment.start ?? 0)
									)
							  )
							: null;
					setTranscriptProps({
						segments: transcriptSegments,
						transcriptText: transcript.getEntireTranscript(),
						metadataDuration: duration,
					});
				} else if (audioNote.quote) {
					setTranscriptProps({
						transcriptText: audioNote.quote,
					});
				}
			})
			.catch((error) => {
				console.error("Audio Notes: Failed to load transcript", error);
			});
	}

	return calloutDiv;
}

function getAudioHTMLMediaElementsInMode(mode: HTMLElement): HTMLElement[] {
	const _players = mode.getElementsByClassName("audio-player-container");
	const players: HTMLElement[] = [];
	for (let i = 0; i < _players.length; i++) {
		players.push(_players[i] as HTMLElement);
	}
	return players;
}
