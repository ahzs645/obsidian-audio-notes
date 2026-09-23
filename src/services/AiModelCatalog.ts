import { spawn } from "child_process";
import { tmpdir } from "os";

export type AiProvider = "claude" | "codex";
export interface AiModel { value: string; label: string; efforts: string[]; resolvedModel?: string }
export interface CatalogEntry { key: string; updatedAt: number; models: AiModel[] }
interface CacheHost { load(): Promise<string | null>; save(data: string): Promise<void> }
export const effortLabel = (value: string) => value === "" ? "Provider default" : value === "xhigh" ? "Extra high" : value[0].toUpperCase() + value.slice(1);
const token = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9_-]*$/.test(value);

export function parseModels(provider: AiProvider, rows: unknown): AiModel[] {
	if (!Array.isArray(rows)) throw new Error("The CLI returned an invalid model list.");
	const result: AiModel[] = [];
	for (const row of rows) {
		if (!row || typeof row !== "object" || row.hidden === true) continue;
		const value = provider === "codex" ? row.model : row.value;
		if (typeof value !== "string" || !value.trim() || result.some(m => m.value === value)) continue;
		const rawEfforts = provider === "codex" ? row.supportedReasoningEfforts?.map((e: any) => e?.reasoningEffort) : row.supportedEffortLevels;
		result.push({ value, label: typeof row.displayName === "string" ? row.displayName : value,
			efforts: Array.isArray(rawEfforts) ? [...new Set<string>(rawEfforts.filter(token))] : [],
			...(typeof row.resolvedModel === "string" ? { resolvedModel: row.resolvedModel } : {}) });
	}
	if (!result.length) throw new Error("The CLI returned no available models.");
	return result;
}

/** Metadata-only CLI handshakes: no prompt, conversation, or generation request. */
export function discoverModels(provider: AiProvider, binary: string, signal?: AbortSignal): Promise<AiModel[]> {
	return new Promise((resolve, reject) => {
		const args = provider === "codex" ? ["app-server"] : ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--setting-sources", "user"];
		const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
		const direct = process.platform === "win32" || binary.includes("/");
		const child = spawn(direct ? binary : process.env.SHELL || "/bin/zsh", direct ? args : ["-lc", `exec ${[binary, ...args].map(quote).join(" ")}`], { cwd: tmpdir(), stdio: "pipe", shell: process.platform === "win32" });
		let done = false, buffer = "", bytes = 0, id = 2;
		const rows: unknown[] = [], cursors = new Set<string>();
		const finish = (error?: Error, models?: AiModel[]) => {
			if (done) return;
			done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
			child.stdin.end(); child.kill();
			const force = setTimeout(() => child.kill("SIGKILL"), 1500);
			(force as any).unref?.(); child.once("close", () => clearTimeout(force));
			if (error) reject(error); else resolve(models!);
		};
		const abort = () => finish(new Error("Model refresh cancelled."));
		const timer = setTimeout(() => finish(new Error("Model discovery timed out. Check the CLI login and connection.")), 30_000);
		const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
		signal?.addEventListener("abort", abort, { once: true });
		child.on("error", error => finish(error));
		child.stdin.on("error", error => finish(error));
		child.stderr.resume(); // CLI logs may contain account details; never expose them in the picker.
		child.on("close", () => { if (!done) finish(new Error("The AI CLI exited before returning its model list.")); });
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (done) return;
			bytes += chunk.length;
			if (bytes > 4 * 1024 * 1024) return finish(new Error("The AI CLI response exceeded the size limit."));
			buffer += chunk;
			let end: number;
			while (!done && (end = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
				let message: any;
				try { message = JSON.parse(line); } catch { continue; }
				try {
					if (provider === "claude") {
						if (message.type !== "control_response" || message.response?.request_id !== "models") continue;
						if (message.response.subtype !== "success") throw new Error("Claude Code could not retrieve its model list.");
						finish(undefined, parseModels(provider, message.response.response?.models));
					} else if (message.id === 1) {
						if (message.error) throw new Error("Codex initialization failed.");
						send({ method: "initialized" });
						send({ id, method: "model/list", params: { limit: 100, includeHidden: false } });
					} else if (message.id === id) {
						if (message.error || !Array.isArray(message.result?.data)) throw new Error("Codex could not retrieve its model list.");
						rows.push(...message.result.data);
						const cursor = message.result.nextCursor;
						if (cursor) {
							if (typeof cursor !== "string" || cursors.has(cursor) || cursors.size >= 100) throw new Error("Invalid model list pagination.");
							cursors.add(cursor); id++;
							send({ id, method: "model/list", params: { cursor, limit: 100, includeHidden: false } });
						} else finish(undefined, parseModels(provider, rows));
					}
				} catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
			}
		});
		if (signal?.aborted) return abort();
		send(provider === "codex" ? { id: 1, method: "initialize", params: { clientInfo: { name: "obsidian_audio_notes", version: "1.0" } } } : { type: "control_request", request_id: "models", request: { subtype: "initialize" } });
	});
}

export class AiModelCatalog {
	private entries = new Map<string, CatalogEntry>();
	private attempts = new Map<string, number>();
	private pending = new Map<string, Promise<void>>();
	private errors = new Map<string, string>();
	private listeners = new Set<() => void>();
	private controller = new AbortController();
	private writes = Promise.resolve();
	private loaded: Promise<void>;
	constructor(private host: CacheHost, private discover = discoverModels) {
		this.loaded = this.load();
	}
	private async load() {
		try {
			const data = JSON.parse(await this.host.load() || "null");
			if (data?.version === 1 && Array.isArray(data.entries)) for (const e of data.entries) {
				if (typeof e.key === "string" && Number.isFinite(e.updatedAt) && Array.isArray(e.models) && e.models.every((m: any) => typeof m?.value === "string" && typeof m.label === "string" && Array.isArray(m.efforts) && m.efforts.every(token))) this.entries.set(e.key, e);
			}
		} catch { /* Offline cache is optional. */ }
		this.emit();
	}
	subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
	private emit() { if (!this.controller.signal.aborted) this.listeners.forEach(fn => fn()); }
	dispose() { this.controller.abort(); this.listeners.clear(); }
	private key(provider: AiProvider, binary: string) { return JSON.stringify([provider, binary]); }
	get(provider: AiProvider, binary: string) { return this.entries.get(this.key(provider, binary)); }
	status(provider: AiProvider, binary: string) {
		const key = this.key(provider, binary), entry = this.entries.get(key);
		if (this.pending.has(key)) return "Refreshing…";
		const error = this.errors.get(key);
		if (error) return `${entry ? "Using saved model list. " : "Model list unavailable. "}${error}`;
		return entry ? `Updated ${new Date(entry.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Model list has not been retrieved yet.";
	}
	refresh(provider: AiProvider, binary: string, force = false): Promise<void> {
		const key = this.key(provider, binary);
		const running = this.pending.get(key); if (running) return running;
		const task = this.refreshInner(provider, binary, key, force).finally(() => { this.pending.delete(key); this.emit(); });
		this.pending.set(key, task); this.emit(); return task;
	}
	private async refreshInner(provider: AiProvider, binary: string, key: string, force: boolean) {
		await this.loaded;
		if (this.controller.signal.aborted) return;
		const attempted = this.attempts.get(key);
		if (!force && attempted && Date.now() - attempted < (this.errors.has(key) ? 60_000 : 6 * 3600_000)) return;
		this.attempts.set(key, Date.now());
		try {
			const models = await this.discover(provider, binary, this.controller.signal);
			if (this.controller.signal.aborted) return;
			this.entries.set(key, { key, updatedAt: Date.now(), models }); this.errors.delete(key);
			const data = JSON.stringify({ version: 1, entries: [...this.entries.values()] });
			this.writes = this.writes.catch(() => {}).then(() => this.host.save(data));
			try { await this.writes; } catch { this.errors.set(key, "Could not save the model list for offline use."); }
		} catch (e) { this.errors.set(key, e instanceof Error ? e.message : String(e)); }
	}
}

export function modelOptions(models: AiModel[], selected: string) {
	const options = [{ value: "", label: "Provider default" }, ...models.map(m => ({ value: m.value, label: m.label }))];
	if (selected && !options.some(m => m.value === selected)) options.push({ value: selected, label: `${selected} (saved/custom)` });
	return options;
}
export function effortOptions(models: AiModel[], model: string, selected: string) {
	if (!model) return [{ value: "", label: "Provider default" }];
	const known = models.find(m => m.value === model || m.resolvedModel === model);
	const values = known ? known.efforts : selected ? [selected] : [];
	return [{ value: "", label: "Provider default" }, ...values.map(value => ({ value, label: effortLabel(value) }))];
}
