<script lang="ts">
	import { Notice } from "obsidian";
	import { onMount, onDestroy, tick } from "svelte";
	import AudioUploadPanel from "./AudioUploadPanel.svelte";
	import AttachmentsPanel from "./AttachmentsPanel.svelte";
	import TranscriptPanel from "./TranscriptPanel.svelte";
	import type {
		TranscriptSegmentWithSpeaker,
		TranscriptSearchMatch,
		SidebarAttachment,
		GroupedTranscript,
		TranscriptHighlightPart,
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
export let needsAudioUpload = false;
export let audioUploadInProgress = false;
export let onUploadMeetingAudio: (files: File[]) => Promise<void> = async () =>
	Promise.resolve();
export let canTranscribeDeepgram = false;
export let canTranscribeScriberr = false;
export let hasTranscript = false;
export let onTranscribeMeeting: (
	provider: "deepgram" | "scriberr"
) => Promise<void> = async () => Promise.resolve();

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
let attachmentsCollapsed = true;
let audioUploadInput: HTMLInputElement | null = null;

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

	$: showTranscriptionCta =
		!needsAudioUpload && !hasTranscript;

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

	function highlightParts(text: string, query: string): TranscriptHighlightPart[] {
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

	function triggerAudioPicker() {
		if (audioUploadInProgress) {
			return;
		}
		audioUploadInput?.click();
	}

	function handleAudioFileInput(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = input.files ? Array.from(input.files) : [];
		if (files.length) {
			onUploadMeetingAudio(files);
		}
		input.value = "";
	}

	function requestTranscription(provider: "deepgram" | "scriberr") {
		onTranscribeMeeting(provider);
	}

</script>

<div class="aan-transcript-stack">
	<AttachmentsPanel
		{attachments}
		{attachmentsEnabled}
		{isUploadingAttachments}
		bind:attachmentsCollapsed={attachmentsCollapsed}
		{dragActive}
		{attachmentStatusText}
		{triggerFileDialog}
		{handleDragEnter}
		{handleDragOver}
		{handleDragLeave}
		{handleDrop}
		{handleFileInput}
		{formatAttachmentType}
		bind:filePicker={filePicker}
		{onOpenAttachment}
		{onDeleteAttachment}
	/>
	{#if needsAudioUpload}
		<AudioUploadPanel
			{audioUploadInProgress}
			{triggerAudioPicker}
			{handleAudioFileInput}
			bind:audioUploadInput={audioUploadInput}
		/>
	{/if}
	{#if !needsAudioUpload}
		<div
			class="audio-note-player-host"
			class:has-player={Boolean(playerContainer)}
			bind:this={playerHost}
		></div>
		<TranscriptPanel
			{title}
			{isTranscribing}
			{segments}
			{transcriptDuration}
			{progressMessage}
			{hasSegments}
			bind:collapsed={collapsed}
			{toggleAutoScroll}
			{autoScroll}
			{isSearching}
			{copyTranscript}
			showTranscriptionCta={showTranscriptionCta}
			{canTranscribeDeepgram}
			{canTranscribeScriberr}
			{requestTranscription}
			{formatDurationLabel}
			{toggleSearch}
			{searchMatches}
			{currentMatchIndex}
			{goToPreviousMatch}
			{goToNextMatch}
			{showSearch}
			bind:searchInputEl={searchInputEl}
			{searchQuery}
			{clearSearch}
			bind:scrollContainer={scrollContainer}
			{transcriptText}
			{highlightParts}
			{currentMatch}
			{groupedSegments}
			{activeSegmentIndex}
			{segmentRefAction}
			{jumpToTime}
			{formatTime}
			{getSpeakerColorClass}
		/>
	{/if}
</div>
