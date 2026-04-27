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
			title:
				typeof structured.title === "string"
					? structured.title.trim()
					: "",
			markdownNotes:
				typeof structured.markdown_notes === "string"
					? structured.markdown_notes.trim()
					: "",
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
				title:
					typeof parsed.title === "string" ? parsed.title.trim() : "",
				markdownNotes:
					typeof parsed.markdown_notes === "string"
						? parsed.markdown_notes.trim()
						: "",
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
		if (draft.title) {
			await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
				fm.title = draft.title;
			});
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
		"Create detailed meeting notes from a transcript for an Obsidian note.",
		"Generate a concise, descriptive meeting title from the transcript.",
		"Write clean markdown that could be saved directly as a standalone downloadable .md file.",
		"Match this vault's existing meeting-note style: start with a useful overview, then use topic-based markdown headings and bullets/tables where helpful.",
		"Do not add an AI wrapper heading, generated-by line, or forced sections. Include Decisions, Action Items, Open Questions, or Next Steps only when useful.",
		"Use only the transcript below. Do not invent facts, owners, deadlines, or decisions.",
		"If the transcript is unclear, say so naturally in the notes instead of pretending certainty.",
		"Keep uncertainty explicit when the transcript is unclear.",
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

function findNextLevelTwoHeadingIndex(content: string, fromIndex: number): number {
	const match = content.slice(fromIndex).match(/\n## (?!#)/);
	return match?.index === undefined ? -1 : fromIndex + match.index + 1;
}

function toMessage(cause: unknown, fallback: string): string {
	if (cause instanceof Error && cause.message.trim().length > 0) {
		return cause.message.trim();
	}
	return fallback;
}
