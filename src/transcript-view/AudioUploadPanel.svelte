<script lang="ts">
	export let audioUploadInProgress = false;
	export let triggerAudioPicker: () => void = () => {};
	export let handleAudioFileInput: (event: Event) => void = () => {};
	export let audioUploadInput: HTMLInputElement | null = null;
	export let transcriptUploadInProgress = false;
	export let triggerTranscriptPicker: () => void = () => {};
	export let handleTranscriptFileInput: (event: Event) => void = () => {};
	export let transcriptUploadInput: HTMLInputElement | null = null;
</script>

<section class="aan-audio-upload-panel">
	<p class="aan-audio-upload-title">
		Add meeting audio to enable playback, or import an existing transcript to start without a recording.
	</p>
	<div class="aan-audio-upload-actions">
		<button
			class="aan-transcript-btn"
			type="button"
			on:click={triggerAudioPicker}
			disabled={audioUploadInProgress}
		>
			{audioUploadInProgress ? "Uploading…" : "Upload meeting audio"}
		</button>
		<button
			class="aan-transcript-btn"
			type="button"
			on:click={triggerTranscriptPicker}
			disabled={transcriptUploadInProgress}
		>
			{transcriptUploadInProgress
				? "Uploading…"
				: "Upload transcript (.vtt/.srt/.txt)"}
		</button>
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
