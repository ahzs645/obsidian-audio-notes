<script lang="ts">
	import { Notice } from "obsidian";
	import { onMount, onDestroy, tick } from "svelte";
import type {
	TranscriptSegmentWithSpeaker,
	TranscriptSearchMatch,
	SidebarAttachment,
} from "./types";

	export let segments: TranscriptSegmentWithSpeaker[] = [];
	export let transcriptText = "";
	export let metadataDuration: number | null = null;
	export let isTranscribing = false;
	export let progressMessage: string | null = null;
	export let currentTime: number | null = null;
	export let syncWithAudio = false;
	export let onSeekToTime: (time: number) => void = () => {};
	export let title = "Live Transcript";
	export let playerContainer: HTMLElement | null = null;
	export let attachments: SidebarAttachment[] = [];
	export let attachmentsEnabled = false;
	export let onUploadAttachments: (files: File[]) => Promise<void> = async () =>
		Promise.resolve();
	export let onOpenAttachment: (path: string) => Promise<void> = async () =>
		Promise.resolve();
	export let onDeleteAttachment: (path: string) => Promise<void> = async () =>
		Promise.resolve();

	const speakerColorAssignments = new Map<string, string>();
	const speakerColorClasses = [
		"blue",
		"green",
		"purple",
		"orange",
		"pink",
		"cyan",
	];

	let autoScroll = true;
let showSearch = false;
	let searchQuery = "";
	let currentMatchIndex = 0;
	let scrollContainer: HTMLElement | null = null;
	let searchInputEl: HTMLInputElement | null = null;
	const segmentRefs = new Map<number, HTMLElement>();
	let lastAutoScrollIndex: number | null = null;
let collapsed = false;
	let playerHost: HTMLDivElement | null = null;
	let mountedPlayerEl: HTMLElement | null = null;
	let dragActive = false;
	let dragCounter = 0;
	let isUploadingAttachments = false;
	let filePicker: HTMLInputElement | null = null;
	type GroupedTranscript = {
		id: string;
		speakerKey: string;
		label: string;
		startTime: number;
		endTime: number;
		segments: { segment: TranscriptSegmentWithSpeaker; index: number }[];
	};

	$: hasSegments = segments?.length > 0;

	$: transcriptDuration =
		metadataDuration ??
		(hasSegments
			? Math.max(
					...segments.map((segment) =>
						Number(segment.end ?? segment.start ?? 0)
					)
			  )
			: null);

	$: groupedSegments = buildGroups(segments);

	$: searchMatches = computeSearchMatches(
		segments,
		transcriptText,
		searchQuery
	);

	$: {
		const maxIndex = Math.max(searchMatches.length - 1, 0);
		if (currentMatchIndex > maxIndex) {
			currentMatchIndex = maxIndex;
		}
	}

	$: currentMatch = searchMatches[currentMatchIndex] ?? null;

	$: isSearching = Boolean(searchQuery.trim().length);

	$: activeSegmentIndex = syncWithAudio
		? findActiveSegmentIndex(segments, currentTime ?? null)
		: null;

	$: if (!attachmentsEnabled && dragActive) {
		dragActive = false;
		dragCounter = 0;
	}

	$: attachmentStatusText = attachmentsEnabled
		? dragActive
			? "Release to upload"
			: "Drag files here or click Add files"
		: "Add a recording to enable attachments";

	$: if (playerHost && mountedPlayerEl !== playerContainer) {
		while (playerHost.firstChild) {
			playerHost.removeChild(playerHost.firstChild);
		}
		mountedPlayerEl = null;
		if (playerContainer) {
			playerHost.appendChild(playerContainer);
			mountedPlayerEl = playerContainer;
		}
	}

	$: if (
		autoScroll &&
		!isSearching &&
		activeSegmentIndex !== null &&
		activeSegmentIndex !== undefined
	) {
		if (activeSegmentIndex !== lastAutoScrollIndex) {
			scrollToSegment(activeSegmentIndex);
			lastAutoScrollIndex = activeSegmentIndex;
		}
	}

	$: if (currentMatch && currentMatch.segmentIndex !== undefined) {
		scrollToSegment(currentMatch.segmentIndex, true);
	}

	$: if (showSearch) {
		tick().then(() => {
			searchInputEl?.focus();
		});
	}

	onMount(() => {
		const handler = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
				event.preventDefault();
				showSearch = true;
			}
			if (event.key === "Escape" && showSearch) {
				event.preventDefault();
				clearSearch();
			}
			if (event.key === "Enter" && showSearch && searchMatches.length) {
				event.preventDefault();
				if (event.shiftKey) {
					goToPreviousMatch();
				} else {
					goToNextMatch();
				}
			}
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	});

	onDestroy(() => {
		segmentRefs.clear();
	});

	function registerSegmentRef(index: number, el: HTMLElement | null) {
		if (el) {
			segmentRefs.set(index, el);
		} else {
			segmentRefs.delete(index);
		}
	}

	function segmentRefAction(node: HTMLElement, index: number) {
		registerSegmentRef(index, node);
		let currentIndex = index;
		return {
			update(newIndex: number) {
				if (newIndex !== currentIndex) {
					registerSegmentRef(currentIndex, null);
					currentIndex = newIndex;
					registerSegmentRef(currentIndex, node);
				}
			},
			destroy() {
				registerSegmentRef(currentIndex, null);
			},
		};
	}

	async function scrollToSegment(index: number, force = false) {
		await tick();
		if (!scrollContainer) return;
		const el = segmentRefs.get(index);
		if (!el) return;
		const containerRect = scrollContainer.getBoundingClientRect();
		const elementRect = el.getBoundingClientRect();
		const above = elementRect.top < containerRect.top;
		const below = elementRect.bottom > containerRect.bottom;
		if (!force && !above && !below) {
			return;
		}
		const offset =
			el.offsetTop -
			scrollContainer.clientHeight / 2 +
			el.clientHeight / 2;
		scrollContainer.scrollTo({
			top: Math.max(offset, 0),
			behavior: "smooth",
		});
	}

	function toggleAutoScroll() {
		autoScroll = !autoScroll;
	}

	function formatAttachmentType(ext: string): string {
		return (ext ? ext.slice(0, 4) : "FILE").toUpperCase();
	}

	async function uploadFiles(files: File[]) {
		if (!attachmentsEnabled || !files?.length) {
			return;
		}
		isUploadingAttachments = true;
		try {
			await onUploadAttachments(files);
		} catch (error) {
			console.error("Audio Notes: Failed to upload attachments", error);
		} finally {
			isUploadingAttachments = false;
			if (filePicker) {
				filePicker.value = "";
			}
		}
	}

	function handleFileInput(event: Event) {
		const target = event.currentTarget as HTMLInputElement | null;
		if (!target?.files?.length) return;
		uploadFiles(Array.from(target.files));
	}

	function triggerFileDialog() {
		if (!attachmentsEnabled || isUploadingAttachments) return;
		filePicker?.click();
	}

	function handleDragEnter(event: DragEvent) {
		if (!attachmentsEnabled) return;
		event.preventDefault();
		dragCounter += 1;
		dragActive = true;
	}

	function handleDragOver(event: DragEvent) {
		if (!attachmentsEnabled) return;
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = "copy";
		}
	}

	function handleDragLeave(event: DragEvent) {
		if (!attachmentsEnabled) return;
		event.preventDefault();
		dragCounter = Math.max(dragCounter - 1, 0);
		if (dragCounter === 0) {
			dragActive = false;
		}
	}

	function handleDrop(event: DragEvent) {
		if (!attachmentsEnabled) return;
		event.preventDefault();
		dragCounter = 0;
		dragActive = false;
		const files = event.dataTransfer?.files;
		if (files?.length) {
			uploadFiles(Array.from(files));
		}
	}

	async function copyTranscript() {
		if (!transcriptText?.length) {
			new Notice("Transcript is empty", 3000);
			return;
		}
		try {
			if (navigator?.clipboard?.writeText) {
				await navigator.clipboard.writeText(transcriptText);
			} else {
				const textarea = document.createElement("textarea");
				textarea.value = transcriptText;
				textarea.style.position = "fixed";
				textarea.style.left = "-9999px";
				document.body.appendChild(textarea);
				textarea.select();
				document.execCommand("copy");
				document.body.removeChild(textarea);
			}
			new Notice("Transcript copied to clipboard", 3000);
		} catch (error) {
			console.error(error);
			new Notice("Unable to copy transcript", 4000);
		}
	}

	function formatTime(seconds: number | null | undefined): string {
		if (seconds === null || seconds === undefined || isNaN(seconds)) {
			return "0:00";
		}
		const totalSeconds = Math.max(0, Math.floor(seconds));
		const mins = Math.floor(totalSeconds / 60);
		const secs = totalSeconds % 60;
		return `${mins}:${secs.toString().padStart(2, "0")}`;
	}

	function formatDurationLabel(duration: number | null): string {
		if (!duration || duration <= 0) return "Processing…";
		return formatTime(duration);
	}

	function getSpeakerKey(
		segment: TranscriptSegmentWithSpeaker,
		index: number
	): string {
		return (
			segment.speakerId ??
			segment.speaker ??
			segment.speakerName ??
			`unknown-${index}`
		);
	}

	function getSpeakerLabel(
		segment: TranscriptSegmentWithSpeaker,
		index: number
	): string {
		return (
			segment.speakerLabel ??
			segment.speakerName ??
			(segment.speakerId ? `Speaker ${segment.speakerId}` : null) ??
			(segment.speaker ? `Speaker ${segment.speaker}` : null) ??
			`Speaker ${index + 1}`
		);
	}

	function getSpeakerInitials(label: string): string {
		if (!label) return "??";
		const parts = label
			.split(/\s+/)
			.filter(Boolean)
			.map((part) => part[0]?.toUpperCase())
			.join("");
		return parts.slice(0, 2) || label.slice(0, 2).toUpperCase();
	}

	function getSpeakerColorClass(key: string): string {
		if (!key) return "blue";
		if (!speakerColorAssignments.has(key)) {
			const hash = Array.from(key).reduce((acc, char) => {
				acc = (acc << 5) - acc + char.charCodeAt(0);
				return acc & acc;
			}, 0);
			const color =
				speakerColorClasses[Math.abs(hash) % speakerColorClasses.length];
			speakerColorAssignments.set(key, color);
		}
		return speakerColorAssignments.get(key) ?? "blue";
	}

	function highlightParts(text: string, query: string) {
		if (!query?.trim()) {
			return [{ text, highlight: false }];
		}
		const lowerText = text.toLowerCase();
		const lowerQuery = query.toLowerCase();
		let startIndex = 0;
		const parts: { text: string; highlight: boolean }[] = [];
		while (startIndex < text.length) {
			const matchIndex = lowerText.indexOf(lowerQuery, startIndex);
			if (matchIndex === -1) {
				parts.push({
					text: text.substring(startIndex),
					highlight: false,
				});
				break;
			}
			if (matchIndex > startIndex) {
				parts.push({
					text: text.substring(startIndex, matchIndex),
					highlight: false,
				});
			}
			parts.push({
				text: text.substring(matchIndex, matchIndex + lowerQuery.length),
				highlight: true,
			});
			startIndex = matchIndex + lowerQuery.length;
		}
		return parts.length ? parts : [{ text, highlight: false }];
	}

	function buildGroups(
		source: TranscriptSegmentWithSpeaker[]
	): GroupedTranscript[] {
		const groups: GroupedTranscript[] = [];
		let current: GroupedTranscript | null = null;
		source.forEach((segment, index) => {
			const speakerKey = getSpeakerKey(segment, index);
			if (!current || current.speakerKey !== speakerKey) {
				current = {
					id: `${speakerKey}-${groups.length}`,
					speakerKey,
					label: getSpeakerLabel(segment, index),
					startTime: Number(segment.start ?? 0),
					endTime: Number(segment.end ?? segment.start ?? 0),
					segments: [],
				};
				groups.push(current);
			}
			current.segments.push({ segment, index });
			current.endTime = Number(segment.end ?? segment.start ?? current.endTime);
		});
		return groups;
	}

	function computeSearchMatches(
		source: TranscriptSegmentWithSpeaker[],
		text: string,
		query: string
	): TranscriptSearchMatch[] {
		if (!query?.trim()) {
			return [];
		}
		const matches: TranscriptSearchMatch[] = [];
		const lowerQuery = query.toLowerCase();
		if (source?.length) {
			source.forEach((segment, index) => {
				const segmentText = segment.text?.toLowerCase() ?? "";
				let startIndex = 0;
				while (startIndex < segmentText.length) {
					const matchIndex = segmentText.indexOf(lowerQuery, startIndex);
					if (matchIndex === -1) break;
					matches.push({
						type: "segment",
						segmentIndex: index,
						textIndex: matchIndex,
						length: lowerQuery.length,
					});
					startIndex = matchIndex + lowerQuery.length;
				}
				const speakerName =
					getSpeakerLabel(segment, index).toLowerCase() ?? "";
				if (speakerName.includes(lowerQuery)) {
					matches.push({
						type: "speaker",
						segmentIndex: index,
					});
				}
			});
		} else if (text) {
			const lowerText = text.toLowerCase();
			let startIndex = 0;
			while (startIndex < lowerText.length) {
				const matchIndex = lowerText.indexOf(lowerQuery, startIndex);
				if (matchIndex === -1) break;
				matches.push({
					type: "plaintext",
					textIndex: matchIndex,
					length: lowerQuery.length,
				});
				startIndex = matchIndex + lowerQuery.length;
			}
		}
		return matches;
	}

	function findActiveSegmentIndex(
		source: TranscriptSegmentWithSpeaker[],
		time: number | null
	): number | null {
		if (time === null || time === undefined) {
			return null;
		}
		for (let i = 0; i < source.length; i++) {
			const segment = source[i];
			if (
				segment.start !== undefined &&
				segment.end !== undefined &&
				time >= segment.start &&
				time < segment.end
			) {
				return i;
			}
		}
		return null;
	}

	function goToPreviousMatch() {
		if (!searchMatches.length) return;
		currentMatchIndex =
			currentMatchIndex === 0
				? searchMatches.length - 1
				: currentMatchIndex - 1;
	}

	function goToNextMatch() {
		if (!searchMatches.length) return;
		currentMatchIndex =
			currentMatchIndex === searchMatches.length - 1
				? 0
				: currentMatchIndex + 1;
	}

	function toggleSearch() {
		if (showSearch && searchQuery) {
			clearSearch();
		} else {
			showSearch = !showSearch;
		}
	}

	function clearSearch() {
		searchQuery = "";
		showSearch = false;
		currentMatchIndex = 0;
	}

	function jumpToTime(time: number | undefined) {
		if (time === undefined || time === null) return;
		onSeekToTime?.(time);
	}

</script>

<div class="aan-transcript-stack">
	<section class="audio-note-attachments-panel">
		<header class="aan-attachments-header">
			<div>
				<p class="aan-attachments-title">Attachments</p>
				<p class="aan-attachments-subtitle">
					{#if attachments.length}
						{attachments.length} file{attachments.length === 1 ? "" : "s"}
					{:else}
						Store reference files with this recording
					{/if}
				</p>
			</div>
			<button
				class="aan-transcript-btn"
				type="button"
				on:click={triggerFileDialog}
				disabled={!attachmentsEnabled || isUploadingAttachments}
			>
				{isUploadingAttachments ? "Uploading…" : "Add files"}
			</button>
		</header>
		<div
			class="aan-attachments-dropzone"
			class:is-disabled={!attachmentsEnabled}
			class:is-dragging={dragActive}
			on:dragenter={handleDragEnter}
			on:dragover={handleDragOver}
			on:dragleave={handleDragLeave}
			on:drop={handleDrop}
			aria-disabled={!attachmentsEnabled}
			aria-busy={isUploadingAttachments}
		>
			<p>{attachmentStatusText}</p>
		</div>
		{#if attachments.length}
			<ul class="aan-attachments-list">
				{#each attachments as attachment (attachment.path)}
					<li class="aan-attachment-item">
						<div class="aan-attachment-details">
							<span class="aan-attachment-type" aria-hidden="true">
								{formatAttachmentType(attachment.extension)}
							</span>
							<div class="aan-attachment-meta">
								<span class="aan-attachment-name">{attachment.name}</span>
								<span class="aan-attachment-size">{attachment.size}</span>
							</div>
						</div>
						<div class="aan-attachment-actions">
							<button
								type="button"
								class="aan-attachment-action"
								on:click={async () => {
									await onOpenAttachment(attachment.path);
								}}
								aria-label={`Open ${attachment.name}`}
							>
								<svg
									viewBox="0 0 24 24"
									aria-hidden="true"
									focusable="false"
								>
									<path
										d="M7 17L17 7"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
									/>
									<path
										d="M10 7h7v7"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
									/>
								</svg>
							</button>
							<button
								type="button"
								class="aan-attachment-action danger"
								on:click={async () => {
									await onDeleteAttachment(attachment.path);
								}}
								aria-label={`Delete ${attachment.name}`}
								disabled={isUploadingAttachments}
							>
								<svg
									viewBox="0 0 24 24"
									aria-hidden="true"
									focusable="false"
								>
									<path
										d="M6 7h12"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
									/>
									<path
										d="M10 7V5h4v2"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
									/>
									<path
										d="M9 7v10a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V7"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
									/>
								</svg>
							</button>
						</div>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="aan-attachments-empty">
				{attachmentsEnabled
					? "No attachments yet."
					: "Attachments will appear once a recording is linked."}
			</p>
		{/if}
		<input
			type="file"
			multiple
			class="aan-attachments-input"
			bind:this={filePicker}
			on:change={handleFileInput}
		/>
	</section>
	<div class="audio-note-transcript-panel">
		<div class="audio-note-transcript-card">
			<div
				class="audio-note-player-host"
				class:has-player={Boolean(playerContainer)}
				bind:this={playerHost}
			></div>
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
	</div>
</div>
