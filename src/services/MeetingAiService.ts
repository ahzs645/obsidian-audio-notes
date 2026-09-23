import { spawn } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { normalizePath, Platform, TFile } from "obsidian";
import type {
	AudioNotesSettings,
	MeetingAiProviderKind,
} from "../AudioNotesSettings";
import type AutomaticAudioNotes from "../main";

import { AiModelCatalog, effortOptions } from "./AiModelCatalog";

const AI_SECTION_START = "<!-- AUDIO-NOTES-AI:START -->";
const AI_SECTION_END = "<!-- AUDIO-NOTES-AI:END -->";
const AI_NOTES_HEADING = "## AI Meeting Notes";
const NOTES_HEADING = "## Notes";
const NOTES_PLACEHOLDER =
	"- Capture decisions, summaries, or paste AI output here.";

const CLAUDE_OUTPUT_SCHEMA = JSON.stringify({
	type: "object",
	additionalProperties: false,
	required: ["title", "markdown_notes"],
	properties: {
		title: {
			type: "string",
		},
		markdown_notes: {
			type: "string",
		},
	},
});

const LABEL_OUTPUT_SCHEMA = JSON.stringify({
	type: "object",
	additionalProperties: false,
	required: ["label"],
	properties: {
		label: {
			type: "string",
		},
	},
});

export interface MeetingAiHealth {
	available: boolean;
	configured: boolean;
	provider: MeetingAiProviderKind;
	providerLabel: string;
	message: string;
	authLabel?: string;
}

export interface MeetingAiDraft {
	title: string;
	markdownNotes: string;
	providerLabel: string;
}

interface MeetingAiInput {
	title: string;
	transcriptText: string;
	notePath?: string;
}

export interface MeetingLabelSuggestionInput {
	title: string;
	context: string;
	candidateTags: string[];
}

/** The model and effort actually sent to the CLI, already reconciled with the
 *  discovered catalog. Providers send this verbatim and never re-read settings. */
export interface MeetingAiModelChoice {
	model: string;
	effort: string;
}

interface MeetingAiProvider {
	readonly kind: Exclude<MeetingAiProviderKind, "disabled">;
	readonly label: string;
	checkHealth(settings: AudioNotesSettings): Promise<MeetingAiHealth>;
	generateJson(
		settings: AudioNotesSettings,
		prompt: string,
		schemaJson: string,
		choice: MeetingAiModelChoice
	): Promise<Record<string, unknown>>;
}

class ClaudeCodeMeetingAiProvider implements MeetingAiProvider {
	readonly kind = "claude" as const;
	readonly label = "Claude Code";

	async checkHealth(settings: AudioNotesSettings): Promise<MeetingAiHealth> {
		const binaryPath = settings.meetingAiClaudeBinaryPath;
		try {
			const result = await runCommand(binaryPath, ["auth", "status"]);
			const parsed = JSON.parse(result.stdout.trim()) as Record<
				string,
				unknown
			>;
			const loggedIn = parsed.loggedIn === true;
			const authMethod =
				typeof parsed.authMethod === "string"
					? parsed.authMethod
					: undefined;
			const subscriptionType =
				typeof parsed.subscriptionType === "string"
					? parsed.subscriptionType
					: undefined;
			const authLabel = formatClaudeAuthLabel(authMethod, subscriptionType);
			return {
				available: loggedIn,
				configured: true,
				provider: this.kind,
				providerLabel: this.label,
				authLabel,
				message: loggedIn
					? authLabel
						? `${this.label} is ready (${authLabel}).`
						: `${this.label} is ready.`
					: `${this.label} is installed but not authenticated. Run \`claude auth login\`.`,
			};
		} catch (error) {
			return {
				available: false,
				configured: true,
				provider: this.kind,
				providerLabel: this.label,
				message: toMessage(
					error,
					`Could not run ${binaryPath}. Make sure Claude Code is installed.`
				),
			};
		}
	}

	async generateJson(
		settings: AudioNotesSettings,
		prompt: string,
		schemaJson: string,
		choice: MeetingAiModelChoice
	): Promise<Record<string, unknown>> {
		const args = [
			"-p",
			"--output-format",
			"json",
			"--json-schema",
			schemaJson,
			"--tools",
			"",
			...(choice.model ? ["--model", choice.model] : []),
			...(choice.effort ? ["--effort", choice.effort] : []),
		];
		const result = await runCommand(
			settings.meetingAiClaudeBinaryPath,
			args,
			prompt
		);
		const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
		return (
			(parsed.structured_output as Record<string, unknown> | undefined) ??
			parsed
		);
	}
}

class CodexMeetingAiProvider implements MeetingAiProvider {
	readonly kind = "codex" as const;
	readonly label = "Codex / ChatGPT";

	async checkHealth(settings: AudioNotesSettings): Promise<MeetingAiHealth> {
		const binaryPath = settings.meetingAiCodexBinaryPath;
		try {
			const result = await runCommand(binaryPath, ["login", "status"]);
			const status = `${result.stdout}\n${result.stderr}`.trim();
			const loggedIn = /logged in/i.test(status);
			return {
				available: loggedIn,
				configured: true,
				provider: this.kind,
				providerLabel: this.label,
				authLabel: loggedIn ? status : undefined,
				message: loggedIn
					? `${this.label} is ready (${status}).`
					: `${this.label} is installed but not authenticated. Run \`codex login\`.`,
			};
		} catch (error) {
			return {
				available: false,
				configured: true,
				provider: this.kind,
				providerLabel: this.label,
				message: toMessage(
					error,
					`Could not run ${binaryPath}. Make sure Codex CLI is installed.`
				),
			};
		}
	}

	async generateJson(
		settings: AudioNotesSettings,
		prompt: string,
		schemaJson: string,
		choice: MeetingAiModelChoice
	): Promise<Record<string, unknown>> {
		const tempDir = await mkdtemp(join(tmpdir(), "audio-notes-codex-"));
		const schemaPath = join(tempDir, "meeting-notes.schema.json");
		const outputPath = join(tempDir, "meeting-notes.json");
		try {
			await writeFile(schemaPath, schemaJson, "utf8");
			const args = [
				"exec",
				"--ephemeral",
				"--skip-git-repo-check",
				"-s",
				"read-only",
				...(choice.model ? ["--model", choice.model] : []),
				...(choice.effort
					? [
							"--config",
							`model_reasoning_effort="${choice.effort}"`,
					  ]
					: []),
				"--output-schema",
				schemaPath,
				"--output-last-message",
				outputPath,
				"-",
			];
			const result = await runCommand(
				settings.meetingAiCodexBinaryPath,
				args,
				prompt
			);
			const rawOutput = (await readFile(outputPath, "utf8")).trim();
			return JSON.parse(rawOutput || result.stdout.trim()) as Record<
				string,
				unknown
			>;
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	}
}

export class MeetingAiService {
	readonly models: AiModelCatalog;
	private readonly generatingFiles = new Set<TFile>();
	private readonly generationListeners = new Set<() => void>();

	isGenerating(file: TFile | null): boolean {
		return Boolean(file && [...this.generatingFiles].some(active => active === file || active.path === file.path));
	}

	subscribeGeneration(listener: () => void): () => void {
		this.generationListeners.add(listener);
		return () => { this.generationListeners.delete(listener); };
	}

	private notifyGeneration(): void {
		for (const listener of this.generationListeners) {
			try { listener(); } catch (error) { console.error("Audio Notes: generation listener failed", error); }
		}
	}
	constructor(private readonly plugin: AutomaticAudioNotes) {
		const adapter = plugin.app.vault.adapter;
		const path = `${plugin.manifest.dir}/ai-models.json`;
		this.models = new AiModelCatalog({
			load: async () => await adapter.exists(path) ? adapter.read(path) : null,
			save: data => adapter.write(path, data),
		});
		plugin.register(() => this.models.dispose());
	}

	refreshModels(force = false): Promise<void> {
		const s = this.plugin.settings, provider = s.meetingAiProvider;
		if (!this.isDesktopSupported() || provider === "disabled") return Promise.resolve();
		return this.models.refresh(provider, provider === "claude" ? s.meetingAiClaudeBinaryPath : s.meetingAiCodexBinaryPath, force);
	}

	isDesktopSupported(): boolean {
		return Platform.isDesktop || Platform.isDesktopApp || Platform.isMacOS;
	}

	canGenerateNotes(transcriptText: string | null | undefined): boolean {
		return (
			this.isDesktopSupported() &&
			Boolean(this.resolveProvider()) &&
			Boolean(transcriptText?.trim())
		);
	}

	async checkHealth(): Promise<MeetingAiHealth> {
		if (!this.isDesktopSupported()) {
			return {
				available: false,
				configured: false,
				provider: "disabled",
				providerLabel: "Local AI",
				message: "Local AI meeting notes are only available on desktop.",
			};
		}

		const provider = this.resolveProvider();
		if (!provider) {
			return {
				available: false,
				configured: false,
				provider: "disabled",
				providerLabel: "Local AI",
				message: "Enable a local AI provider in Audio Notes settings first.",
			};
		}

		return provider.checkHealth(this.plugin.settings);
	}

	async generateMeetingNotes(
		file: TFile,
		transcriptText: string
	): Promise<MeetingAiDraft> {
		if (this.isGenerating(file)) throw new Error("AI notes are already being generated for this meeting.");
		this.generatingFiles.add(file);
		this.notifyGeneration();
		try {
			return await this.generateMeetingNotesJob(file, transcriptText);
		} finally {
			this.generatingFiles.delete(file);
			this.notifyGeneration();
		}
	}

	private async generateMeetingNotesJob(file: TFile, transcriptText: string): Promise<MeetingAiDraft> {
		// Preserve the settings class getters while copying its backing values.
		const settings: AudioNotesSettings = Object.assign(
			Object.create(Object.getPrototypeOf(this.plugin.settings)), this.plugin.settings
		);
		if (!this.isDesktopSupported()) {
			throw new Error("Local AI meeting notes are only available on desktop.");
		}
		const provider = this.resolveProvider();
		if (!provider) {
			throw new Error("No local AI provider is enabled in settings.");
		}
		const health = await provider.checkHealth(settings);
		if (!health.available) {
			throw new Error(health.message);
		}

		const prompt = buildMeetingPrompt(settings, {
			title: file.basename,
			transcriptText,
			notePath: file.path,
		});
		const structured = await provider.generateJson(
			settings,
			prompt,
			CLAUDE_OUTPUT_SCHEMA,
			this.effectiveModelChoice(settings)
		);
		const draft: MeetingAiDraft = {
			title:
				typeof structured.title === "string"
					? structured.title.trim()
					: "",
			markdownNotes:
				typeof structured.markdown_notes === "string"
					? structured.markdown_notes.trim()
					: "",
			providerLabel: provider.label,
		};
		const current = await this.plugin.app.vault.read(file);
		const updated = upsertAiNotesSection(current, draft);
		if (updated !== current) {
			await this.plugin.app.vault.modify(file, updated);
		}
		if (draft.title) {
			await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
				fm.title = draft.title;
			});
			await this.renameMeetingFile(file, draft.title);
		}
		return draft;
	}

	isConfigured(): boolean {
		return this.isDesktopSupported() && Boolean(this.resolveProvider());
	}

	async suggestMeetingLabel(
		input: MeetingLabelSuggestionInput
	): Promise<string> {
		const provider = this.resolveProvider();
		if (!provider) {
			throw new Error("No local AI provider is enabled in settings.");
		}
		const prompt = buildLabelSuggestionPrompt(input);
		const structured = await provider.generateJson(
			this.plugin.settings,
			prompt,
			LABEL_OUTPUT_SCHEMA,
			this.effectiveModelChoice(this.plugin.settings)
		);
		const label =
			typeof structured.label === "string"
				? structured.label.trim().replace(/^#/, "").toLowerCase()
				: "";
		return input.candidateTags.includes(label) ? label : "";
	}

	private async renameMeetingFile(file: TFile, title: string): Promise<void> {
		const nextPath = getUniqueMarkdownPath(
			this.plugin,
			file,
			sanitizeMarkdownFileName(title)
		);
		if (!nextPath || nextPath === file.path) {
			return;
		}
		await this.plugin.app.vault.rename(file, nextPath);
	}

	/**
	 * Reconcile the saved model and effort with what the CLI actually offers.
	 * A model the catalog no longer lists — renamed, withdrawn, or hand-typed —
	 * falls back to the first available one at its provider-default effort, so a
	 * stale setting degrades instead of failing every call at the CLI.
	 */
	private effectiveModelChoice(settings: AudioNotesSettings): MeetingAiModelChoice {
		const claude = settings.meetingAiProvider === "claude";
		const models = this.models.get(claude ? "claude" : "codex", claude ? settings.meetingAiClaudeBinaryPath : settings.meetingAiCodexBinaryPath)?.models || [];
		const model = claude ? settings.meetingAiClaudeModel : settings.meetingAiCodexModel;
		const effort = claude ? settings.meetingAiClaudeEffort : settings.meetingAiCodexEffort;
		const keptEffort = effortOptions(models, model, effort).some(o => o.value === effort) ? effort : "";
		// Nothing discovered yet (offline, or never refreshed): the saved values are all we know.
		if (!model || !models.length || models.some(m => m.value === model || m.resolvedModel === model)) {
			return { model, effort: keptEffort };
		}
		const fallback = models[0];
		console.warn(
			`Audio Notes: ${claude ? "Claude Code" : "Codex"} no longer offers "${model}"; using "${fallback.value}" at its default effort.`
		);
		return { model: fallback.value, effort: "" };
	}

	private resolveProvider(): MeetingAiProvider | null {
		switch (this.plugin.settings.meetingAiProvider) {
			case "claude":
				return new ClaudeCodeMeetingAiProvider();
			case "codex":
				return new CodexMeetingAiProvider();
			default:
				return null;
		}
	}
}

function buildMeetingPrompt(
	settings: AudioNotesSettings,
	input: MeetingAiInput
): string {
	const basePrompt = settings.meetingAiPrompt.trim();
	const customInstructions = settings.meetingAiCustomInstructions.trim();
	return [
		basePrompt,
		"",
		`Current file title: ${input.title}`,
		...(input.notePath ? [`Note path: ${input.notePath}`] : []),
		"",
		"Return structured output with:",
		"- title: a short descriptive meeting title",
		"- markdown_notes: the complete markdown body to place under the note's existing ## Notes heading",
		...(customInstructions
			? [
					"",
					"Additional instructions:",
					customInstructions,
			  ]
			: []),
		"",
		"Transcript:",
		input.transcriptText.trim(),
	].join("\n");
}

function buildLabelSuggestionPrompt(
	input: MeetingLabelSuggestionInput
): string {
	return [
		"Choose the best meeting label for this Obsidian meeting note.",
		"Pick exactly one tag from the following list. If none of them fits, return an empty string.",
		"",
		"Available tags:",
		...input.candidateTags.map((tag) => `- ${tag}`),
		"",
		`Note title: ${input.title}`,
		"",
		"Note content:",
		input.context.trim(),
		"",
		"Return structured output with:",
		'- label: the chosen tag exactly as written in the list above, or "" if none fits',
	].join("\n");
}

function formatClaudeAuthLabel(
	authMethod: string | undefined,
	subscriptionType: string | undefined
): string | undefined {
	const normalizedAuthMethod = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
	if (normalizedAuthMethod === "apikey") {
		return "Claude API Key";
	}

	const normalizedSubscription =
		subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "") || "";
	if (!normalizedSubscription) {
		return undefined;
	}

	switch (normalizedSubscription) {
		case "max":
		case "maxplan":
		case "max5":
		case "max20":
			return "Claude Max Subscription";
		case "team":
			return "Claude Team Subscription";
		case "enterprise":
			return "Claude Enterprise Subscription";
		case "pro":
			return "Claude Pro Subscription";
		case "free":
			return "Claude Free Subscription";
		default:
			return `Claude ${toTitleCaseWords(subscriptionType || "")} Subscription`;
	}
}

function toTitleCaseWords(value: string): string {
	return value
		.split(/[\s_-]+/g)
		.filter(Boolean)
		.map((part) => part[0]?.toUpperCase() + part.slice(1).toLowerCase())
		.join(" ");
}

async function runCommand(
	command: string,
	args: string[],
	stdin?: string
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const launch = buildCommandLaunch(command, args);
		const child = spawn(launch.command, launch.args, {
			shell: process.platform === "win32",
			stdio: "pipe",
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			reject(error);
		});
		child.on("close", (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
				return;
			}
			reject(
				new Error(
					stderr.trim() ||
						stdout.trim() ||
						`${command} exited with code ${code ?? "unknown"}.`
				)
			);
		});
		if (stdin) {
			child.stdin.write(stdin);
		}
		child.stdin.end();
	});
}

function buildCommandLaunch(
	command: string,
	args: string[]
): { command: string; args: string[] } {
	if (process.platform === "win32" || command.includes("/")) {
		return { command, args };
	}

	const shell = process.env.SHELL || "/bin/zsh";
	return {
		command: shell,
		args: ["-lc", [command, ...args].map(shellQuote).join(" ")],
	};
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function upsertAiNotesSection(content: string, draft: MeetingAiDraft): string {
	const block = renderAiNotesBlock(draft);
	const startIndex = content.indexOf(AI_SECTION_START);
	const endIndex = content.indexOf(AI_SECTION_END);
	if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
		const before = content.slice(0, startIndex).replace(/\s*$/, "");
		const after = content
			.slice(endIndex + AI_SECTION_END.length)
			.replace(/^\s*/, "");
		return [before, block, after].filter(Boolean).join("\n\n").trimEnd() + "\n";
	}

	const headingIndex = content.indexOf(AI_NOTES_HEADING);
	if (headingIndex !== -1) {
		const nextHeadingIndex = findNextLevelTwoHeadingIndex(
			content,
			headingIndex + AI_NOTES_HEADING.length
		);
		const before = content.slice(0, headingIndex).replace(/\s*$/, "");
		const after =
			nextHeadingIndex === -1
				? ""
				: content.slice(nextHeadingIndex).replace(/^\s*/, "");
		return [before, block, after].filter(Boolean).join("\n\n").trimEnd() + "\n";
	}

	const notesIndex = content.indexOf(NOTES_HEADING);
	if (notesIndex !== -1) {
		const notesBodyStart = notesIndex + NOTES_HEADING.length;
		const afterNotes = content.slice(notesBodyStart);
		const placeholderIndex = afterNotes.indexOf(NOTES_PLACEHOLDER);
		if (placeholderIndex !== -1) {
			const before =
				content.slice(0, notesBodyStart) +
				afterNotes.slice(0, placeholderIndex).replace(/\s*$/, "\n\n");
			const after = afterNotes
				.slice(placeholderIndex + NOTES_PLACEHOLDER.length)
				.replace(/^\s*/, "");
			return [before + block, after].filter(Boolean).join("\n\n").trimEnd() + "\n";
		}

		const before = content.slice(0, notesBodyStart).replace(/\s*$/, "");
		const after = content.slice(notesBodyStart).replace(/^\s*/, "");
		return [before, block, after].filter(Boolean).join("\n\n").trimEnd() + "\n";
	}

	const trimmed = content.trimEnd();
	return trimmed.length ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

function renderAiNotesBlock(draft: MeetingAiDraft): string {
	return draft.markdownNotes || "_No meeting notes generated._";
}

function sanitizeMarkdownFileName(title: string): string {
	return title
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120)
		.trim();
}

function getUniqueMarkdownPath(
	plugin: AutomaticAudioNotes,
	file: TFile,
	fileName: string
): string | null {
	if (!fileName) {
		return null;
	}
	const folderPath = file.path.includes("/")
		? file.path.slice(0, file.path.lastIndexOf("/"))
		: "";
	const basePath = normalizePath(
		folderPath ? `${folderPath}/${fileName}.md` : `${fileName}.md`
	);
	if (basePath === file.path || !plugin.app.vault.getAbstractFileByPath(basePath)) {
		return basePath;
	}
	for (let index = 2; index < 100; index++) {
		const candidate = normalizePath(
			folderPath
				? `${folderPath}/${fileName} ${index}.md`
				: `${fileName} ${index}.md`
		);
		if (!plugin.app.vault.getAbstractFileByPath(candidate)) {
			return candidate;
		}
	}
	return null;
}

function findNextLevelTwoHeadingIndex(content: string, fromIndex: number): number {
	const match = content.slice(fromIndex).match(/\n## (?!#)/);
	return match?.index === undefined ? -1 : fromIndex + match.index + 1;
}

function toMessage(cause: unknown, fallback: string): string {
	if (cause instanceof Error && cause.message.trim().length > 0) {
		const message = cause.message.trim();
		if (/command not found|ENOENT|not recognized|no such file/i.test(message)) {
			return fallback;
		}
		return message;
	}
	return fallback;
}
