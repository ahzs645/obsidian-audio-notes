<script lang="ts">
export let canGenerateAiNotes = false;
export let isGeneratingAiNotes = false;
export let isSavingAiOptions = false;
export let aiCatalogStatus = "";
export let onRefreshAiModels: (force?: boolean) => Promise<void> = async () => {};
export let aiProvider = "codex";
export let aiModel = "";
export let aiEffort = "medium";
export let aiModelOptions: { value: string; label: string }[] = [];
export let aiEffortOptions: { value: string; label: string }[] = [];
export let onGenerateAiNotes: () => Promise<void> = async () => {};
export let onAiOptionsChange: (field: "provider" | "model" | "effort", value: string) => Promise<void> = async () => {};
/** Narrow layouts: one button opens a menu that also holds "Generate AI notes". */
export let compact = false;
let controls: HTMLDivElement;
let dropdown: HTMLDetailsElement;
let summary: HTMLElement;
let menu: HTMLDivElement;
let menuOpen = false;
let openUp = false;
let menuHeight = 360;
let menuTop = 0;
let menuLeft = 0;
function portal(node: HTMLDivElement) {
	// Escape the sidebar's scrolling/overflow containers, which clip upward menus.
	node.ownerDocument.body.appendChild(node);
	return { destroy() { node.remove(); } };
}
function position() {
	if (!menuOpen || !summary) return;
	const view = summary.ownerDocument.defaultView;
	if (!view) return;
	const rect = summary.getBoundingClientRect();
	const below = Math.max(0, view.innerHeight - rect.bottom - 16);
	const above = Math.max(0, rect.top - 16);
	openUp = below < 340 && above > below;
	menuHeight = Math.min(360, openUp ? above : below);
	menuTop = openUp ? rect.top - 8 : rect.bottom + 8;
	menuLeft = Math.max(8, Math.min(rect.right - Math.min(260, view.innerWidth - 16), view.innerWidth - 268));
}
function toggle() {
	menuOpen = dropdown.open;
	if (!menuOpen) return;
	position();
	void onRefreshAiModels();
}
function change(field: "provider" | "model" | "effort", event: Event) {
	void onAiOptionsChange(field, (event.currentTarget as HTMLSelectElement).value);
}
function outside(event: MouseEvent) {
	if (dropdown && !event.composedPath().includes(controls) && !event.composedPath().includes(menu)) dropdown.open = false;
}
function escape(event: KeyboardEvent) {
	if (event.key === "Escape" && dropdown?.open) { dropdown.open = false; summary?.focus(); }
}
function generateFromMenu() {
	dropdown.open = false;
	void onGenerateAiNotes();
}
$: busy = isGeneratingAiNotes || isSavingAiOptions;
</script>

<svelte:window on:click={outside} on:keydown={escape} on:resize={position} on:scroll|capture={position} />
<div class="aan-ai-controls" bind:this={controls}>
	{#if !compact}
	<button type="button" class="aan-transcript-btn primary icon-only aan-ai-generate"
		disabled={!canGenerateAiNotes || busy} aria-busy={isGeneratingAiNotes}
		aria-label={isGeneratingAiNotes ? "Generating AI notes" : "Generate AI notes"}
		title={isGeneratingAiNotes ? "Generating AI notes…" : "Generate AI notes"}
		on:click={() => void onGenerateAiNotes()}>
		<svg class="aan-transcript-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
			<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" />
			<path d="M20 2v4M18 4h4" />
		</svg>
	</button>
	{/if}
	<details class="aan-ai-options" bind:this={dropdown} on:toggle={toggle}>
		<summary class="aan-transcript-btn" class:icon-only={!compact} class:primary={compact} class:aan-ai-compact-trigger={compact}
			aria-busy={compact && isGeneratingAiNotes}
			aria-label={compact ? "AI notes" : "AI model and effort options"}
			title={compact ? (isGeneratingAiNotes ? "Generating AI notes…" : "AI notes") : "AI model and effort options"} bind:this={summary}>
			{#if compact}
				<svg class="aan-transcript-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
					<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" />
					<path d="M20 2v4M18 4h4" />
				</svg>
			{/if}
			<svg class="aan-transcript-icon aan-ai-chevron" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="m7 10 5 5 5-5" /></svg>
		</summary>
		<div class="aan-ai-options-menu" bind:this={menu} use:portal
			style="display: {menuOpen ? 'grid' : 'none'}; max-height: {menuHeight}px; top: {menuTop}px; left: {menuLeft}px; transform: {openUp ? 'translateY(-100%)' : 'none'}">
			{#if compact}
				<button type="button" class="mod-cta aan-ai-menu-generate" disabled={!canGenerateAiNotes || busy}
					aria-busy={isGeneratingAiNotes} on:click={generateFromMenu}>
					{isGeneratingAiNotes ? "Generating AI notes…" : "Generate AI notes"}
				</button>
			{/if}
			<label>Provider
				<select aria-label="AI provider" value={aiProvider} disabled={busy} on:change={(event) => change("provider", event)}>
					<option value="codex">Codex / ChatGPT</option>
					<option value="claude">Claude Code</option>
				</select>
			</label>
			<label>Model
				<select aria-label="AI model" value={aiModel} disabled={busy} on:change={(event) => change("model", event)}>
					{#each aiModelOptions as option}<option value={option.value}>{option.label}</option>{/each}
				</select>
			</label>
			<label>Effort
				<select aria-label="AI reasoning effort" value={aiEffort} disabled={busy} on:change={(event) => change("effort", event)}>
					{#each aiEffortOptions as option}<option value={option.value}>{option.label}</option>{/each}
				</select>
			</label>
			<div class="aan-ai-refresh-row">
				<small role="status">{aiCatalogStatus}</small>
				<button type="button" aria-label="Refresh models" title="Refresh models" disabled={busy || aiCatalogStatus === "Refreshing…"} on:click={() => void onRefreshAiModels(true)}>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 11.6-1L20 9M4 15l2.4 3A7 7 0 0 0 18 17"/></svg>
				</button>
			</div>
			<small>{isGeneratingAiNotes ? "Generating AI notes…" : isSavingAiOptions ? "Saving…" : "Saved for future generations."}</small>
		</div>
	</details>
</div>
