<script lang="ts">
	export let audioUploadInProgress = false;
	export let triggerAudioPicker: () => void = () => {};
	export let handleAudioFileInput: (event: Event) => void = () => {};
	export let onUploadMeetingAudio: (files: File[]) => Promise<void> = async () =>
		Promise.resolve();
	export let audioUploadInput: HTMLInputElement | null = null;
	export let transcriptUploadInProgress = false;
	export let triggerTranscriptPicker: () => void = () => {};
	export let handleTranscriptFileInput: (event: Event) => void = () => {};
	export let onUploadTranscript: (files: File[]) => Promise<void> = async () =>
		Promise.resolve();
	export let transcriptUploadInput: HTMLInputElement | null = null;
	export let hasTranscript = false;

	let audioDragActive = false;
	let transcriptDragActive = false;

	const audioExtensions = new Set([
		"mp3",
		"m4a",
		"wav",
		"aac",
		"flac",
		"ogg",
		"oga",
		"opus",
		"webm",
		"mp4",
		"mpeg",
		"mpga",
		"aif",
		"aiff",
		"caf",
		"3gp",
	]);
	const transcriptExtensions = new Set(["vtt", "srt", "txt", "json"]);

	function getExtension(fileName: string) {
		const segments = fileName.split(".");
		return segments.length > 1 ? segments.pop()?.toLowerCase() ?? "" : "";
	}

	function isAudioFile(file: File) {
		return (
			file.type.startsWith("audio/") || audioExtensions.has(getExtension(file.name))
		);
	}

	function isTranscriptFile(file: File) {
		if (transcriptExtensions.has(getExtension(file.name))) {
			return true;
		}
		return file.type === "text/vtt" || file.type === "text/plain";
	}

	function activateDropzone(event: DragEvent, kind: "audio" | "transcript") {
		if (
			(kind === "audio" && audioUploadInProgress) ||
			(kind === "transcript" && transcriptUploadInProgress)
		) {
			return;
		}
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = "copy";
		}
		if (kind === "audio") {
			audioDragActive = true;
			return;
		}
		transcriptDragActive = true;
	}

	function deactivateDropzone(event: DragEvent, kind: "audio" | "transcript") {
		event.preventDefault();
		const currentTarget = event.currentTarget;
		const nextTarget = event.relatedTarget;
		if (
			currentTarget instanceof HTMLElement &&
			nextTarget instanceof Node &&
			currentTarget.contains(nextTarget)
		) {
			return;
		}
		if (kind === "audio") {
			audioDragActive = false;
			return;
		}
		transcriptDragActive = false;
	}

	async function handleDrop(
		event: DragEvent,
		kind: "audio" | "transcript"
	) {
		event.preventDefault();
		if (kind === "audio") {
			audioDragActive = false;
			if (audioUploadInProgress) {
				return;
			}
		} else {
			transcriptDragActive = false;
			if (transcriptUploadInProgress) {
				return;
			}
		}

		const droppedFiles = Array.from(event.dataTransfer?.files ?? []);
		const matchingFiles = droppedFiles.filter((file) =>
			kind === "audio" ? isAudioFile(file) : isTranscriptFile(file)
		);
		if (!matchingFiles.length) {
			return;
		}

		if (kind === "audio") {
			await onUploadMeetingAudio(matchingFiles.slice(0, 1));
			return;
		}
		await onUploadTranscript(matchingFiles);
	}
</script>

<section class="aan-audio-upload-panel">
	<p class="aan-audio-upload-title">
		{hasTranscript
			? "Add meeting audio to enable playback."
			: "Add meeting audio to enable playback, or import an existing transcript to start without a recording."}
	</p>
	<div class="aan-audio-upload-actions">
		<button
			class="aan-audio-upload-target"
			class:is-dragging={audioDragActive}
			type="button"
			on:click={triggerAudioPicker}
			on:dragenter={(event) => activateDropzone(event, "audio")}
			on:dragover={(event) => activateDropzone(event, "audio")}
			on:dragleave={(event) => deactivateDropzone(event, "audio")}
			on:drop={(event) => handleDrop(event, "audio")}
			disabled={audioUploadInProgress}
		>
			<span class="aan-audio-upload-target-title">Upload meeting audio</span>
			<span class="aan-audio-upload-target-hint">
				{audioUploadInProgress ? "Uploading…" : "Click or drop an audio file here"}
			</span>
		</button>
		{#if !hasTranscript}
		<button
			class="aan-audio-upload-target"
			class:is-dragging={transcriptDragActive}
			type="button"
			on:click={triggerTranscriptPicker}
			on:dragenter={(event) => activateDropzone(event, "transcript")}
			on:dragover={(event) => activateDropzone(event, "transcript")}
			on:dragleave={(event) => deactivateDropzone(event, "transcript")}
			on:drop={(event) => handleDrop(event, "transcript")}
			disabled={transcriptUploadInProgress}
		>
			<span class="aan-audio-upload-target-title">
				Upload transcript (.vtt/.srt/.txt/.json)
			</span>
			<span class="aan-audio-upload-target-hint">
				{transcriptUploadInProgress
					? "Uploading…"
					: "Click or drop transcript files here"}
			</span>
		</button>
		{/if}
	</div>
	<input
		type="file"
		accept="audio/*"
		class="aan-attachments-input"
		bind:this={audioUploadInput}
		on:change={handleAudioFileInput}
	/>
	<input
		type="file"
		accept=".vtt,.srt,.json,.txt,text/vtt,text/plain"
		multiple
		class="aan-attachments-input"
		bind:this={transcriptUploadInput}
		on:change={handleTranscriptFileInput}
	/>
</section>
