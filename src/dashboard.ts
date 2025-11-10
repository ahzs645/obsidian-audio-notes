import { normalizePath, TFile } from "obsidian";
import type AutomaticAudioNotes from "./main";

const DASHBOARD_MARKER_START = "<!-- AUDIO-NOTES-DASHBOARD:START -->";
const DASHBOARD_MARKER_END = "<!-- AUDIO-NOTES-DASHBOARD:END -->";

const DASHBOARD_BLOCK = [
	"## Upcoming meetings",
	"```dataview",
	'table start_date as "Date", start_time as "Start", file.link as "Meeting"',
	"from #meeting",
	"where start_date >= date(today)",
	"sort start_date asc, start_time asc",
	"limit 10",
	"```",
	"",
	"## Open action items",
	"```dataview",
	"task from #meeting",
	"where !completed",
	'group by file.link as "Meeting"',
	"```",
	"",
	"## Recently captured recordings",
	"```dataview",
	'table dateformat(date(start), \"yyyy-MM-dd HH:mm\") as "Captured", file.link as "Note"',
	"from #meeting",
	"sort start desc",
	"limit 10",
	"```",
].join("\n");

function wrapDashboard(block: string): string {
	return [
		"# Audio Notes Dashboard",
		"",
		"> Requires the Dataview community plugin.",
		"",
		DASHBOARD_MARKER_START,
		block,
		DASHBOARD_MARKER_END,
		"",
	].join("\n");
}

function replaceBlock(content: string, block: string): string {
	const startIndex = content.indexOf(DASHBOARD_MARKER_START);
	const endIndex = content.indexOf(DASHBOARD_MARKER_END);
	if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
		return content;
	}
	const before = content.slice(0, startIndex + DASHBOARD_MARKER_START.length);
	const after = content.slice(endIndex);
	return `${before}\n\n${block}\n${after}`;
}

export async function ensureDashboardNote(
	plugin: AutomaticAudioNotes,
	forceUpdate: boolean = false
): Promise<string> {
	const targetPath =
		plugin.settings.dashboardNotePath?.trim() ||
		"Audio Notes Dashboard.md";
	const normalized = normalizePath(targetPath);
	const vault = plugin.app.vault;
	const existing = vault.getAbstractFileByPath(normalized);

	if (!existing) {
		await vault.create(normalized, wrapDashboard(DASHBOARD_BLOCK));
		return `Created dashboard note at ${normalized}`;
	}

	if (!(existing instanceof TFile)) {
		throw new Error(
			`Dashboard path ${normalized} points to a folder. Choose a Markdown file.`
		);
	}

	const current = await vault.read(existing);
	if (
		!current.includes(DASHBOARD_MARKER_START) ||
		!current.includes(DASHBOARD_MARKER_END)
	) {
		if (!forceUpdate) {
			return "Dashboard note already exists. Add the dashboard markers to allow automatic refresh.";
		}
		const updated =
			current.trimEnd() +
			"\n\n" +
			DASHBOARD_MARKER_START +
			"\n" +
			DASHBOARD_BLOCK +
			"\n" +
			DASHBOARD_MARKER_END +
			"\n";
		await vault.modify(existing, updated);
		return `Updated dashboard note at ${normalized}`;
	}

	const updated = replaceBlock(current, DASHBOARD_BLOCK);
	await vault.modify(existing, updated);
	return `Updated dashboard note at ${normalized}`;
}
