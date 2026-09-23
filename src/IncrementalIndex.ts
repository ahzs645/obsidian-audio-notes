/** A resumable catalog. Discovery uses file stats; only step() reads contents. */
export interface IndexFile { path: string; mtime: number; size: number }
interface RecordState<T> {
	file: IndexFile;
	state: "pending" | "complete" | "unresolved";
	entry?: T | null;
	error?: string;
	retryAt?: number;
}
export interface IndexHost<T> {
	files(): IndexFile[];
	read(file: IndexFile): Promise<T | null>;
	load(): Promise<string | null>;
	save(contents: string): Promise<void>;
}
export class IncrementalIndex<T> {
	private records = new Map<string, RecordState<T>>();
	private active = new Set<string>();
	private writes: Promise<void> = Promise.resolve();
	private stopped = false;
	public saveError = "";
	constructor(private host: IndexHost<T>, private timeoutMs = 15_000) {}

	async initialize(): Promise<void> {
		try {
			const raw = await this.host.load();
			const saved = raw ? JSON.parse(raw) : null;
			if (saved?.version === 1 && Array.isArray(saved.records)) {
				for (const r of saved.records) {
					if (typeof r?.file?.path === "string" &&
						typeof r.file.mtime === "number" && typeof r.file.size === "number" &&
						["pending", "complete", "unresolved"].includes(r.state)) {
						this.records.set(r.file.path, r);
					}
				}
			}
		} catch { /* Missing/corrupt checkpoint: rediscover, never assume complete. */ }
		this.reconcile();
	}

	reconcile(): void {
		const present = new Set<string>();
		for (const file of this.host.files()) {
			present.add(file.path);
			const old = this.records.get(file.path);
			if (!old || old.file.mtime !== file.mtime || old.file.size !== file.size) {
				this.records.set(file.path, { file: { ...file }, state: "pending" });
			}
		}
		for (const key of this.records.keys()) if (!present.has(key)) this.records.delete(key);
	}

	get entries(): T[] {
		return [...this.records.values()].filter(r => r.state === "complete" && r.entry != null)
			.map(r => r.entry!);
	}
	get progress() {
		const rows = [...this.records.values()];
		return {
			total: rows.length,
			complete: rows.filter(r => r.state === "complete").length,
			pending: rows.filter(r => r.state === "pending").length,
			unresolved: rows.filter(r => r.state === "unresolved").length,
			active: this.active.size,
		};
	}
	get unresolved(): string[] {
		return [...this.records.values()].filter(r => r.state === "unresolved")
			.map(r => `${r.file.path}: ${r.error || "Unavailable"}`);
	}

	/** One file per tick, at most two outstanding reads even if cloud reads hang. */
	async step(): Promise<void> {
		if (this.stopped) return;
		this.reconcile();
		if (this.active.size >= 2) return;
		const rows = [...this.records.values()];
		const eligible = (r: RecordState<T>) => !this.active.has(r.file.path);
		const row = rows.find(r => eligible(r) && r.state === "pending") ??
			rows.find(r => eligible(r) && r.state === "unresolved" && (r.retryAt || 0) <= Date.now());
		if (!row) { if (this.saveError) await this.persist(); return; }
		this.active.add(row.file.path);
		let timer: ReturnType<typeof setTimeout>;
		const reading = Promise.resolve().then(() => this.host.read(row.file));
		// A timeout does not cancel an Obsidian read. Keep its slot until it settles.
		void reading.then(() => this.active.delete(row.file.path), () => this.active.delete(row.file.path));
		try {
			const entry = await Promise.race([
				reading,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("File unavailable or cloud download timed out")), this.timeoutMs);
				}),
			]);
			this.reconcile();
			if (!this.stopped && this.records.get(row.file.path) === row) {
				row.entry = entry;
				row.state = "complete";
				delete row.error;
				delete row.retryAt;
			}
		} catch (error) {
			if (!this.stopped && this.records.get(row.file.path) === row) {
				row.state = "unresolved";
				row.error = error instanceof Error ? error.message : String(error);
				row.retryAt = Date.now() + 5 * 60_000;
			}
		} finally {
			clearTimeout(timer!);
			if (!this.stopped) await this.persist();
		}
	}

	async record(file: IndexFile, entry: T): Promise<void> {
		this.records.set(file.path, { file: { ...file }, state: "complete", entry });
		await this.persist();
	}
	retry(): void {
		for (const row of this.records.values()) row.retryAt = 0;
	}
	stop(): void { this.stopped = true; }
	private persist(): Promise<void> {
		const contents = JSON.stringify({ version: 1, records: [...this.records.values()] });
		this.writes = this.writes.then(async () => {
			try { await this.host.save(contents); this.saveError = ""; }
			catch (error) { this.saveError = `Index progress could not be saved: ${error instanceof Error ? error.message : String(error)}`; }
		});
		return this.writes;
	}
}
