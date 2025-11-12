<script lang="ts">
import type { Action } from "svelte/action";
import type {
	TranscriptSegmentWithSpeaker,
	TranscriptSearchMatch,
	GroupedTranscript,
	TranscriptHighlightPart,
} from "./types";

const defaultHighlightParts = (text: string): TranscriptHighlightPart[] => [
	{ text, highlight: false },
];
const noopAction: Action<HTMLElement, number> = () => ({});

export let title = "Live Transcript";
export let isTranscribing = false;
export let segments: TranscriptSegmentWithSpeaker[] = [];
export let transcriptDuration: number | null = null;
export let progressMessage: string | null = null;
export let hasSegments = false;
export let collapsed = false;
export let toggleAutoScroll: () => void = () => {};
export let autoScroll = false;
export let isSearching = false;
export let copyTranscript: () => void = () => {};
export let showTranscriptionCta = false;
export let canTranscribeDeepgram = false;
export let canTranscribeScriberr = false;
export let requestTranscription: (provider: "deepgram" | "scriberr") => void = () => {};
export let formatDurationLabel: (duration: number | null) => string = () => "";
export let toggleSearch: () => void = () => {};
export let searchMatches: TranscriptSearchMatch[] = [];
export let currentMatchIndex = 0;
export let goToPreviousMatch: () => void = () => {};
export let goToNextMatch: () => void = () => {};
export let showSearch = false;
export let searchInputEl: HTMLInputElement | null = null;
export let searchQuery = "";
export let clearSearch: () => void = () => {};
export let scrollContainer: HTMLElement | null = null;
export let transcriptText = "";
export let highlightParts: (
	text: string,
	query: string
) => TranscriptHighlightPart[] = (_text, _query) => defaultHighlightParts(_text);
export let currentMatch: TranscriptSearchMatch | null = null;
export let groupedSegments: GroupedTranscript[] = [];
export let activeSegmentIndex: number | null = null;
export let segmentRefAction: Action<HTMLElement, number> = noopAction;
export let jumpToTime: (time: number | undefined) => void = () => {};
export let formatTime: (time: number | null | undefined) => string = () => "";
export let getSpeakerColorClass: (key: string) => string = () => "blue";

$: canTranscribe = canTranscribeDeepgram || canTranscribeScriberr;
</script>

<div class="audio-note-transcript-panel">
	{#if showTranscriptionCta}
		<div class="audio-note-transcript-card aan-transcription-card">
			<div class="aan-transcription-cta">
				<div>
					<h3>No transcript yet</h3>
					<p>
						Use your connected transcription services to generate a transcript for this meeting.
					</p>
				</div>
				{#if isTranscribing}
					<p class="aan-transcription-status">
						{progressMessage ?? "Sending audio to your transcription service…"}
					</p>
				{/if}
				<div class="aan-transcription-cta-actions">
					{#if canTranscribeDeepgram}
						<button
							class="aan-transcript-btn"
							type="button"
							on:click={() => requestTranscription("deepgram")}
							disabled={isTranscribing}
						>
							Transcribe via Deepgram
						</button>
					{/if}
					{#if canTranscribeScriberr}
						<button
							class="aan-transcript-btn"
							type="button"
							on:click={() => requestTranscription("scriberr")}
							disabled={isTranscribing}
						>
							Transcribe via Scriberr
						</button>
					{/if}
					{#if !canTranscribe}
						<button class="aan-transcript-btn" type="button" disabled>
							Connect an API to transcribe
						</button>
					{/if}
				</div>
				{#if !canTranscribe}
					<p class="aan-transcription-cta-hint">
						Add your Deepgram or Scriberr API keys in Audio Notes settings to enable transcription.
					</p>
				{/if}
			</div>
		</div>
	{:else}
		<div class="audio-note-transcript-card">
			<header class="audio-note-transcript-header">
				<div>
					<div class="audio-note-transcript-title">
						<span>{title}</span>
						{#if isTranscribing}
							<span class="audio-note-transcript-pill">Transcribing…</span>
						{/if}
					</div>
					<p class="audio-note-transcript-meta">
						{#if hasSegments}
							{segments.length} segments · {formatDurationLabel(transcriptDuration)}
						{:else if (isTranscribing)}
							{progressMessage ?? "Waiting for transcript…"}
						{:else}
							Ready for transcript
						{/if}
					</p>
				</div>
				<div class="audio-note-transcript-actions">
					<button
						class="aan-transcript-btn"
						type="button"
						on:click={() => (collapsed = !collapsed)}
					>
						{collapsed ? "Expand transcript" : "Collapse transcript"}
					</button>
					<button
						class="aan-transcript-btn icon-only"
						class:auto-scroll-active={autoScroll}
						on:click={toggleAutoScroll}
						disabled={isSearching}
						type="button"
						title={autoScroll ? "Disable auto-scroll" : "Enable auto-scroll"}
						aria-label={autoScroll ? "Disable auto-scroll" : "Enable auto-scroll"}
						aria-pressed={autoScroll}
					>
						<svg
							aria-hidden="true"
							viewBox="0 0 24 24"
							focusable="false"
							class="aan-transcript-icon"
						>
							<path
								d="M7 5l5 5 5-5M7 19l5-5 5 5"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
					</button>
					<button
						class="aan-transcript-btn"
						on:click={copyTranscript}
						type="button"
						disabled={!transcriptText}
					>
						Copy all
					</button>
				</div>
			</header>

			{#if !collapsed}
				<section class="audio-note-transcript-toolbar">
					<div class="aan-transcript-search-controls">
						<button
							class="aan-transcript-btn"
							type="button"
							on:click={toggleSearch}
						>
							Search
						</button>
						{#if searchMatches.length}
							<span class="aan-transcript-match-count">
								{currentMatchIndex + 1} / {searchMatches.length}
							</span>
							<div class="aan-transcript-match-nav">
								<button type="button" on:click={goToPreviousMatch}>▲</button>
								<button type="button" on:click={goToNextMatch}>▼</button>
							</div>
						{/if}
					</div>
				</section>

				{#if showSearch}
					<div class="aan-transcript-search-bar">
						<input
							bind:this={searchInputEl}
							type="text"
							placeholder="Search transcript… (Ctrl/Cmd + F)"
							bind:value={searchQuery}
						/>
						{#if searchQuery}
							<button type="button" class="aan-transcript-btn" on:click={clearSearch}>
								Clear
							</button>
						{/if}
						{#if searchQuery && !searchMatches.length}
							<span class="aan-transcript-no-match">No matches</span>
						{/if}
					</div>
				{/if}

				<div
					class="audio-note-transcript-scroll"
					bind:this={scrollContainer}
					aria-live="polite"
				>
					{#if !hasSegments}
						{#if transcriptText}
							<div class="audio-note-transcript-plain-text">
								{#each highlightParts(transcriptText, searchQuery) as part, idx}
									<span
										class:aan-transcript-highlight={part.highlight}
										class:aan-transcript-highlight-current={currentMatch?.type === "plaintext" && part.highlight}
										>{part.text}</span
									>
								{/each}
							</div>
						{:else}
							<p class="audio-note-transcript-empty">
								{#if isTranscribing}
									{progressMessage ?? "Processing audio…"}
								{:else}
									Transcript will appear here once available.
								{/if}
							</p>
						{/if}
					{:else}
						<div class="audio-note-transcript-groups">
							{#each groupedSegments as group (group.id)}
								<div
									class="aan-transcript-group"
									class:is-active={group.segments.some(({ index }) => index === activeSegmentIndex)}
								>
									<div class="aan-transcript-group-header">
										<div
											class={`aan-transcript-speaker-badge speaker-${getSpeakerColorClass(
												group.speakerKey
											)}`}
										>
											{group.label}
										</div>
										<button
											type="button"
											class="aan-transcript-time-button"
											on:click={() => jumpToTime(group.startTime)}
											aria-label={`Jump to ${formatTime(group.startTime)}`}
										>
											<span>{formatTime(group.startTime)}</span>
											{#if group.endTime !== undefined && group.endTime !== null}
												<span class="aan-transcript-time-arrow">→</span>
												<span>{formatTime(group.endTime)}</span>
											{/if}
										</button>
									</div>
									<div class="aan-transcript-group-body">
										{#each group.segments as entry (entry.index)}
											<p
												class="aan-transcript-group-text"
												class:is-active={entry.index === activeSegmentIndex}
												use:segmentRefAction={entry.index}
											>
												{#each highlightParts(entry.segment.text, searchQuery) as part, idx}
													<span
														class:aan-transcript-highlight={part.highlight}
														class:aan-transcript-highlight-current={currentMatch?.segmentIndex === entry.index && part.highlight}
														>{part.text}</span
													>
												{/each}
											</p>
										{/each}
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>
