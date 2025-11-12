import type { App } from "obsidian";
import { SuggestModal } from "obsidian";

interface IconChoice {
	label: string;
	value: string;
	keywords: string[];
}

const ICON_CHOICES: IconChoice[] = [
	{ label: "Briefcase", value: "💼", keywords: ["job", "work", "career"] },
	{ label: "Graduation cap", value: "🎓", keywords: ["school", "study"] },
	{ label: "Handshake", value: "🤝", keywords: ["volunteer", "nonprofit"] },
	{ label: "Office building", value: "🏢", keywords: ["organization", "hq"] },
	{ label: "Light bulb", value: "💡", keywords: ["idea", "brainstorm"] },
	{ label: "Laptop", value: "💻", keywords: ["tech", "project"] },
	{ label: "Target", value: "🎯", keywords: ["goal", "focus"] },
	{ label: "Calendar", value: "🗓️", keywords: ["calendar", "schedule"] },
	{ label: "Microphone", value: "🎙️", keywords: ["podcast", "recording"] },
	{ label: "Chart", value: "📊", keywords: ["report", "analytics"] },
	{ label: "Clipboard", value: "📋", keywords: ["notes", "agenda"] },
	{ label: "People", value: "👥", keywords: ["team", "group"] },
	{ label: "Rocket", value: "🚀", keywords: ["launch", "startup"] },
	{ label: "Heart", value: "❤️", keywords: ["care", "nonprofit"] },
	{ label: "Stethoscope", value: "🩺", keywords: ["health", "medical"] },
	{ label: "Book", value: "📚", keywords: ["training", "education"] },
	{ label: "Hammer", value: "🔨", keywords: ["build", "project"] },
	{ label: "Globe", value: "🌐", keywords: ["global", "remote"] },
	{ label: "Phone", value: "📞", keywords: ["call", "support"] },
	{ label: "Checkmark", value: "✅", keywords: ["complete", "task"] },
];

export class MeetingLabelIconPickerModal extends SuggestModal<IconChoice> {
	constructor(app: App, private onPick: (icon: string) => void) {
		super(app);
		this.setPlaceholder("Search icons or emojis…");
	}

	getSuggestions(query: string): IconChoice[] {
		const normalized = query.trim().toLowerCase();
		if (!normalized) {
			return ICON_CHOICES;
		}
		return ICON_CHOICES.filter(
			(icon) =>
				icon.label.toLowerCase().includes(normalized) ||
				icon.value.includes(normalized) ||
				icon.keywords.some((keyword) => keyword.includes(normalized))
		);
	}

	renderSuggestion(choice: IconChoice, el: HTMLElement) {
		el.empty();
		el.addClass("aan-label-picker-item");
		const title = el.createDiv("aan-label-picker-title");
		title.createSpan("aan-label-picker-icon").setText(choice.value);
		title.createSpan().setText(choice.label);
		const meta = el.createDiv("aan-label-picker-meta");
		meta.setText(choice.keywords.join(", "));
	}

	onChooseSuggestion(choice: IconChoice) {
		this.onPick(choice.value);
	}
}
