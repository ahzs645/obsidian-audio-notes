<script lang="ts">
	export let audioUploadInProgress = false;
	export let triggerAudioPicker: () => void = () => {};
	export let handleAudioFileInput: (event: Event) => void = () => {};
	export let audioUploadInput: HTMLInputElement | null = null;
</script>

<section class="aan-audio-upload-panel">
	<p class="aan-audio-upload-title">
		Upload meeting audio to enable playback and transcripts.
	</p>
	<button
		class="aan-transcript-btn"
		type="button"
		on:click={triggerAudioPicker}
		disabled={audioUploadInProgress}
	>
		{audioUploadInProgress ? "Uploading…" : "Upload meeting audio"}
	</button>
	<input
		type="file"
		accept="audio/*"
		class="aan-attachments-input"
		bind:this={audioUploadInput}
		on:change={handleAudioFileInput}
	/>
</section>
