export interface TranscriptWord {
	text: string;
	start: number;
	end: number;
	confidence?: number;
}

export interface TranscriptSegmentWithSpeaker {
	id: number | string;
	start: number;
	end: number;
	text: string;
	speakerId?: string | null;
	speaker?: string | null;
	speakerName?: string | null;
	speakerLabel?: string | null;
	confidence?: number | null;
	words?: TranscriptWord[];
}

export interface TranscriptSearchMatch {
	type: "segment" | "speaker" | "plaintext";
	segmentIndex?: number;
	textIndex?: number;
	length?: number;
	context?: string;
}

export interface SidebarAttachment {
	path: string;
	name: string;
	extension: string;
	size: string;
}
