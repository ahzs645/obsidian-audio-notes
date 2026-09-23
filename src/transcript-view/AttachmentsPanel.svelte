<script lang="ts">
	import type { SidebarAttachment } from "./types";

	export let attachments: SidebarAttachment[] = [];
	export let attachmentsEnabled = false;
	export let isUploadingAttachments = false;
	export let attachmentsCollapsed = true;
	export let dragActive = false;
	export let attachmentStatusText = "";
	export let formatAttachmentType: (ext: string) => string = (ext) =>
		ext?.toUpperCase() ?? "FILE";
	export let triggerFileDialog: () => void = () => {};
	export let handleDragEnter: (event: DragEvent) => void = () => {};
	export let handleDragOver: (event: DragEvent) => void = () => {};
	export let handleDragLeave: (event: DragEvent) => void = () => {};
	export let handleDrop: (event: DragEvent) => void = () => {};
	export let handleFileInput: (event: Event) => void = () => {};
	export let onOpenAttachment: (path: string) => Promise<void> = async () =>
		Promise.resolve();
	export let onDeleteAttachment: (path: string) => Promise<void> = async () =>
		Promise.resolve();
	export let filePicker: HTMLInputElement | null = null;
</script>

<!-- The whole row is a drop target so files can be dropped without expanding it first. -->
<section
	class="audio-note-attachments-panel"
	class:is-dragging={dragActive}
	class:is-expanded={!attachmentsCollapsed}
	on:dragenter={handleDragEnter}
	on:dragover={handleDragOver}
	on:dragleave={handleDragLeave}
	on:drop={handleDrop}
	aria-busy={isUploadingAttachments}
>
	<header class="aan-attachments-header">
		<button
			class="aan-attachments-summary"
			type="button"
			on:click={() => (attachmentsCollapsed = !attachmentsCollapsed)}
			aria-expanded={!attachmentsCollapsed}
			title={attachmentsCollapsed ? "Show attachments" : "Hide attachments"}
		>
			<svg class="aan-attachments-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
			</svg>
			<span class="aan-attachments-title">{dragActive ? "Drop to attach" : "Attachments"}</span>
			{#if attachments.length}
				<span class="aan-attachments-count">{attachments.length}</span>
			{/if}
			<svg class="aan-attachments-chevron" class:expanded={!attachmentsCollapsed} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M6 9l6 6 6-6" />
			</svg>
		</button>
		<button
			class="aan-attachments-add"
			type="button"
			on:click={triggerFileDialog}
			disabled={!attachmentsEnabled || isUploadingAttachments}
			title={isUploadingAttachments ? "Uploading…" : "Add files"}
			aria-label={isUploadingAttachments ? "Uploading files" : "Add files"}
		>
			{#if isUploadingAttachments}
				<span class="aan-transcript-spinner" aria-hidden="true"></span>
			{:else}
				<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
			{/if}
		</button>
	</header>

	{#if !attachmentsCollapsed}
		{#if !attachments.length}
			<p class="aan-attachments-empty">{attachmentStatusText}</p>
		{/if}
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
		{/if}
	{/if}

	<input
		type="file"
		multiple
		class="aan-attachments-input"
		bind:this={filePicker}
		on:change={handleFileInput}
	/>
</section>
