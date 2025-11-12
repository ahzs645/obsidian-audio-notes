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
		<div class="aan-attachments-actions">
			<button
				class="aan-transcript-btn"
				type="button"
				on:click={triggerFileDialog}
				disabled={!attachmentsEnabled || isUploadingAttachments}
			>
				{isUploadingAttachments ? "Uploading…" : "Add files"}
			</button>
			<button
				class="aan-attachments-toggle"
				type="button"
				on:click={() => (attachmentsCollapsed = !attachmentsCollapsed)}
				aria-label={attachmentsCollapsed ? "Expand attachments" : "Collapse attachments"}
				aria-expanded={!attachmentsCollapsed}
			>
				<svg viewBox="0 0 24 24" aria-hidden="true" class:expanded={!attachmentsCollapsed}>
					<path
						d="M6 9l6 6 6-6"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
			</button>
		</div>
	</header>

	{#if !attachmentsCollapsed}
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
