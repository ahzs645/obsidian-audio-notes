import { spawn } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Platform, TFile } from "obsidian";
import type {
	AudioNotesSettings,
	MeetingAiProviderKind,
} from "../AudioNotesSettings";
import type AutomaticAudioNotes from "../main";

const AI_SECTION_START = "<!-- AUDIO-NOTES-AI:START -->";
const AI_SECTION_END = "<!-- AUDIO-NOTES-AI:END -->";

const CLAUDE_OUTPUT_SCHEMA = JSON.stringify({
	type: "object",
	additionalProperties: false,
	required: ["summary", "decisions", "action_items", "open_questions"],
	properties: {
		summary: {
			type: "string",
		},
		decisions: {
			type: "array",
			items: {
				type: "string",
			},
		},
		action_items: {
			type: "array",
			items: {
				type: "string",
			},
		},
		open_questions: {
			type: "array",
			items: {
				type: "string",
			},
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
	summary: string;
	decisions: string[];
	actionItems: string[];
	openQuestions: string[];
	providerLabel: string;
}

interface MeetingAiInput {
	title: string;
	transcriptText: string;
	notePath?: string;
}

interface MeetingAiProvider {
	readonly kind: Exclude<MeetingAiProviderKind, "disabled">;
	readonly label: string;
	checkHealth(settings: AudioNotesSettings): Promise<MeetingAiHealth>;
	generate(
		settings: AudioNotesSettings,
		input: MeetingAiInput
	): Promise<MeetingAiDraft>;
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

	async generate(
		settings: AudioNotesSettings,
		input: MeetingAiInput
	): Promise<MeetingAiDraft> {
		const args = [
			"-p",
			"--output-format",
			"json",
			"--json-schema",
			CLAUDE_OUTPUT_SCHEMA,
			"--tools",
			"",
			...(settings.meetingAiClaudeModel
				? ["--model", settings.meetingAiClaudeModel]
				: []),
			...(settings.meetingAiClaudeEffort
				? ["--effort", settings.meetingAiClaudeEffort]
				: []),
		];
		const prompt = buildMeetingPrompt(settings, input);
		const result = await runCommand(
			settings.meetingAiClaudeBinaryPath,
			args,
			prompt
		);
		const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
		const structured =
			(parsed.structured_output as Record<string, unknown> | undefined) ??
			parsed;

		return {
			summary:
				typeof structured.summary === "string"
					? structured.summary.trim()
					: "",
			decisions: normalizeStringArray(structured.decisions),
			actionItems: normalizeStringArray(structured.action_items),
			openQuestions: normalizeStringArray(structured.open_questions),
			providerLabel: this.label,
		};
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

	async generate(
		settings: AudioNotesSettings,
		input: MeetingAiInput
	): Promise<MeetingAiDraft> {
		const tempDir = await mkdtemp(join(tmpdir(), "audio-notes-codex-"));
		const schemaPath = join(tempDir, "meeting-notes.schema.json");
		const outputPath = join(tempDir, "meeting-notes.json");
		try {
			await writeFile(schemaPath, CLAUDE_OUTPUT_SCHEMA, "utf8");
			const args = [
				"exec",
				"--ephemeral",
				"--skip-git-repo-check",
				"-s",
				"read-only",
				...(settings.meetingAiCodexModel
					? ["--model", settings.meetingAiCodexModel]
					: []),
				...(settings.meetingAiCodexEffort
					? [
							"--config",
							`model_reasoning_effort="${settings.meetingAiCodexEffort}"`,
					  ]
					: []),
				"--output-schema",
				schemaPath,
				"--output-last-message",
				outputPath,
				"-",
			];
			const prompt = buildMeetingPrompt(settings, input);
			const result = await runCommand(
				settings.meetingAiCodexBinaryPath,
				args,
				prompt
			);
			const rawOutput = (await readFile(outputPath, "utf8")).trim();
			const parsed = JSON.parse(rawOutput || result.stdout.trim()) as Record<
				string,
				unknown
			>;

			return {
				summary:
					typeof parsed.summary === "string" ? parsed.summary.trim() : "",
				decisions: normalizeStringArray(parsed.decisions),
				actionItems: normalizeStringArray(parsed.action_items),
				openQuestions: normalizeStringArray(parsed.open_questions),
				providerLabel: this.label,
			};
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	}
}

export class MeetingAiService {
	constructor(private readonly plugin: AutomaticAudioNotes) {}

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
		if (!this.isDesktopSupported()) {
			throw new Error("Local AI meeting notes are only available on desktop.");
		}
		const provider = this.resolveProvider();
		if (!provider) {
			throw new Error("No local AI provider is enabled in settings.");
		}
		const health = await provider.checkHealth(this.plugin.settings);
		if (!health.available) {
			throw new Error(health.message);
		}

		const draft = await provider.generate(this.plugin.settings, {
			title: file.basename,
			transcriptText,
			notePath: file.path,
		});
		const current = await this.plugin.app.vault.read(file);
		const updated = upsertAiNotesSection(current, draft);
		if (updated !== current) {
			await this.plugin.app.vault.modify(file, updated);
		}
		return draft;
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
	const customInstructions = settings.meetingAiCustomInstructions.trim();
	return [
		"You are drafting concise meeting notes from a transcript for an Obsidian note.",
		"Use only the transcript below. Do not invent facts, owners, deadlines, or decisions.",
		"If an item is ambiguous, leave it out or put it in open_questions.",
		"Keep the summary short and useful for someone scanning the note later.",
		"",
		`Meeting title: ${input.title}`,
		...(input.notePath ? [`Note path: ${input.notePath}`] : []),
		"",
		"Return structured output with:",
		"- summary: 1-3 short paragraphs",
		"- decisions: concrete decisions actually made",
		"- action_items: concrete follow-ups; include owner or due date only if explicit",
		"- open_questions: unresolved questions or missing decisions",
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

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
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

	const trimmed = content.trimEnd();
	return trimmed.length ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

function renderAiNotesBlock(draft: MeetingAiDraft): string {
	const generatedAt = new Date().toLocaleString();
	return [
		AI_SECTION_START,
		"## AI Notes",
		"",
		`_Generated via ${draft.providerLabel} on ${generatedAt}._`,
		"",
		"### Summary",
		draft.summary || "_No summary generated._",
		"",
		"### Decisions",
		...renderBulletList(draft.decisions),
		"",
		"### Action Items",
		...renderBulletList(draft.actionItems, true),
		"",
		"### Open Questions",
		...renderBulletList(draft.openQuestions),
		AI_SECTION_END,
	].join("\n");
}

function renderBulletList(items: string[], checkbox = false): string[] {
	if (!items.length) {
		return ["- None noted."];
	}
	return items.map((item) => (checkbox ? `- [ ] ${item}` : `- ${item}`));
}

function toMessage(cause: unknown, fallback: string): string {
	if (cause instanceof Error && cause.message.trim().length > 0) {
		return cause.message.trim();
	}
	return fallback;
}
