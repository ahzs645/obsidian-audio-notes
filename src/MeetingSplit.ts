/**
 * Pure helpers for splitting one recorded meeting into two: dividing the
 * transcript at a time, finding likely split points, and working out each
 * part's schedule. File and note changes live in MeetingSplitService.
 */

export interface SplitWord {
	text: string;
	start?: number;
	end?: number;
	[key: string]: unknown;
}

export interface SplitSegment {
	start: number;
	end: number;
	text: string;
	words?: SplitWord[];
	[key: string]: unknown;
}

export interface SplitSuggestion {
	/** Where to split: the middle of the pause. */
	atSec: number;
	/** How long nobody spoke. */
	gapSec: number;
}

function joinWords(words: SplitWord[]): string {
	// Whisper words carry their own leading spaces; others need them added.
	const spaced = words.some((word) => /^\s/.test(word.text ?? ""));
	return (spaced ? words.map((w) => w.text).join("") : words.map((w) => w.text).join(" ")).trim();
}

function shiftWords(words: SplitWord[], offset: number): SplitWord[] {
	return words.map((word) => ({
		...word,
		...(typeof word.start === "number" ? { start: Math.max(0, word.start - offset) } : {}),
		...(typeof word.end === "number" ? { end: Math.max(0, word.end - offset) } : {}),
	}));
}

/**
 * Divides segments at `splitSec`. The second part's times are rebased so it
 * starts at 0, matching its own cut recording. A segment that straddles the
 * split is divided by its word timings, or kept whole on the side where
 * most of it falls when it has none.
 */
export function splitSegments<T extends SplitSegment>(
	segments: T[],
	splitSec: number
): { first: T[]; second: T[] } {
	const first: T[] = [];
	const second: T[] = [];
	const rebase = (segment: T, words?: SplitWord[]): T => ({
		...segment,
		start: Math.max(0, segment.start - splitSec),
		end: Math.max(0, segment.end - splitSec),
		...(words ? { words: shiftWords(words, splitSec) } : {}),
	});

	for (const segment of segments) {
		if (segment.end <= splitSec) {
			first.push(segment);
			continue;
		}
		if (segment.start >= splitSec) {
			second.push(rebase(segment, segment.words));
			continue;
		}
		const timedWords = (segment.words ?? []).filter(
			(word) => typeof word.start === "number" && typeof word.end === "number"
		);
		if (timedWords.length) {
			const mid = (word: SplitWord) => ((word.start as number) + (word.end as number)) / 2;
			const before = timedWords.filter((word) => mid(word) < splitSec);
			const after = timedWords.filter((word) => mid(word) >= splitSec);
			if (before.length) {
				first.push({
					...segment,
					end: Math.min(splitSec, before[before.length - 1].end as number),
					text: joinWords(before),
					words: before,
				});
			}
			if (after.length) {
				const piece = {
					...segment,
					start: Math.max(splitSec, after[0].start as number),
					text: joinWords(after),
				} as T;
				second.push(rebase(piece, after));
			}
			continue;
		}
		if (splitSec - segment.start >= segment.end - splitSec) {
			first.push({ ...segment, end: splitSec });
		} else {
			second.push(rebase({ ...segment, start: splitSec } as T, segment.words));
		}
	}
	return { first, second };
}

/**
 * The longest pauses between segments, longest first: when a recording ran
 * through two meetings, the break between them is usually the longest quiet.
 */
export function suggestSplitPoints(
	segments: SplitSegment[],
	options: { minGapSec?: number; limit?: number; edgeSec?: number } = {}
): SplitSuggestion[] {
	const { minGapSec = 20, limit = 3, edgeSec = 60 } = options;
	if (segments.length < 2) return [];
	const sorted = [...segments].sort((a, b) => a.start - b.start);
	const total = sorted[sorted.length - 1].end;
	const gaps: SplitSuggestion[] = [];
	let lastEnd = sorted[0].end;
	for (let i = 1; i < sorted.length; i++) {
		const gap = sorted[i].start - lastEnd;
		const at = lastEnd + gap / 2;
		// A pause right at the start or end isn't a meeting boundary.
		if (gap >= minGapSec && at > edgeSec && at < total - edgeSec) {
			gaps.push({ atSec: at, gapSec: gap });
		}
		lastEnd = Math.max(lastEnd, sorted[i].end);
	}
	return gaps.sort((a, b) => b.gapSec - a.gapSec).slice(0, limit);
}

/** The quiet point just before a segment, for "split before this line". */
export function splitPointBefore(segments: SplitSegment[], index: number): number {
	const segment = segments[index];
	if (!segment) return 0;
	const previous = segments
		.slice(0, index)
		.reduce((end, item) => Math.max(end, item.end), 0);
	return previous < segment.start ? (previous + segment.start) / 2 : segment.start;
}

export interface SplitSchedule {
	first: { start: Date; end: Date };
	second: { start: Date; end: Date };
}

/**
 * Part one keeps the meeting's start and ends at the split; part two picks
 * up there and keeps the original end (or runs for the rest of the
 * recording when the saved end is earlier than that).
 */
export function splitSchedule(
	start: Date,
	end: Date,
	splitSec: number,
	totalSec: number
): SplitSchedule {
	const splitAt = new Date(start.getTime() + splitSec * 1000);
	const recordedEnd = new Date(start.getTime() + Math.max(totalSec, splitSec) * 1000);
	const secondEnd = end.getTime() > splitAt.getTime() ? end : recordedEnd;
	return {
		first: { start, end: splitAt },
		second: { start: splitAt, end: secondEnd.getTime() > splitAt.getTime() ? secondEnd : splitAt },
	};
}

export function formatClock(totalSeconds: number): string {
	const seconds = Math.max(0, Math.round(totalSeconds));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	const mm = String(m).padStart(h ? 2 : 1, "0");
	return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}
