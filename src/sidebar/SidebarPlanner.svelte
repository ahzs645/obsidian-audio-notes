<script lang="ts">
	import { localDateKey } from "../meeting-events";
	import type { MeetingEvent } from "../meeting-events";

	export let events: MeetingEvent[] = [];
	export let selectedDate: string;
export let onSelectDate: (date: string) => void;
export let onOpenNote: (path: string, newLeaf: boolean) => void;

	const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const todayKey = localDateKey(new Date());

	let monthCursor = firstDayOfMonth(selectedDate);
	let lastSelected = selectedDate;

	$: if (selectedDate !== lastSelected) {
		lastSelected = selectedDate;
		monthCursor = firstDayOfMonth(selectedDate);
	}

	$: eventsByDate = buildEventsByDate(events);
	$: weeks = buildCalendar(monthCursor);
	$: selectedDayEvents = (events || [])
		.filter((event) => getDisplayDate(event) === selectedDate)
		.sort((a, b) => a.start.getTime() - b.start.getTime());

	function buildEventsByDate(list: MeetingEvent[]) {
		const map = new Map<string, MeetingEvent[]>();
		for (const event of list) {
			const key = getDisplayDate(event);
			if (!map.has(key)) {
				map.set(key, []);
			}
			map.get(key)!.push(event);
		}
		return map;
	}

	function getDisplayDate(event: MeetingEvent): string {
		return event.displayDate || localDateKey(event.start);
	}

	function firstDayOfMonth(iso: string): Date {
		const d = parseISODate(iso);
		d.setDate(1);
		d.setHours(0, 0, 0, 0);
		return d;
	}

	function parseISODate(iso: string): Date {
		const [year, month, day] = iso.split("-").map((part) => Number(part));
		return new Date(year, (month ?? 1) - 1, day ?? 1);
	}

	function addMonths(date: Date, delta: number): Date {
		const clone = new Date(date);
		clone.setMonth(clone.getMonth() + delta);
		return clone;
	}

	function buildCalendar(month: Date) {
		const first = new Date(month);
		const startOffset = first.getDay();
		const gridStart = new Date(first);
		gridStart.setDate(first.getDate() - startOffset);
		const weeks: {
			label: string;
			days: {
				iso: string;
				label: number;
				isCurrentMonth: boolean;
				isToday: boolean;
				isSelected: boolean;
				meetingCount: number;
			}[];
		}[] = [];
		for (let w = 0; w < 6; w++) {
			const days = [];
			for (let d = 0; d < 7; d++) {
				const current = new Date(gridStart);
				current.setDate(gridStart.getDate() + w * 7 + d);
				const iso = localDateKey(current);
				days.push({
					iso,
					label: current.getDate(),
					isCurrentMonth:
						current.getMonth() === month.getMonth() &&
						current.getFullYear() === month.getFullYear(),
					isToday: iso === todayKey,
					isSelected: iso === selectedDate,
					meetingCount: eventsByDate.get(iso)?.length || 0,
				});
			}
			weeks.push({ label: `week-${w}`, days });
		}
		return weeks;
	}

	function selectDay(iso: string) {
		onSelectDate?.(iso);
	}

	function gotoToday() {
		monthCursor = firstDayOfMonth(todayKey);
		onSelectDate?.(todayKey);
	}

	function gotoPrevMonth() {
		monthCursor = addMonths(monthCursor, -1);
	}

	function gotoNextMonth() {
		monthCursor = addMonths(monthCursor, 1);
	}

	function monthLabel(date: Date): string {
		return date.toLocaleDateString(undefined, {
			month: "long",
			year: "numeric",
		});
	}

	function openEvent(path: string, newLeaf: boolean) {
		onOpenNote?.(path, newLeaf);
	}
</script>

<div class="aan-sidebar-calendar">
	<header class="aan-sidebar-calendar__toolbar">
		<div class="aan-sidebar-calendar__btn-group">
			<button on:click={gotoPrevMonth}>Prev</button>
			<button on:click={gotoToday}>Today</button>
			<button on:click={gotoNextMonth}>Next</button>
		</div>
		<div class="aan-sidebar-calendar__label">{monthLabel(monthCursor)}</div>
	</header>
	<div class="aan-sidebar-calendar__weekdays">
		{#each weekdays as day}
			<div>{day}</div>
		{/each}
	</div>
	<div class="aan-sidebar-calendar__grid">
		{#each weeks as week}
			{#each week.days as day}
				<button
					class={`aan-sidebar-calendar__cell ${day.isCurrentMonth ? "" : "is-outside"} ${day.isToday ? "is-today" : ""} ${day.isSelected ? "is-selected" : ""}`}
					on:click={() => selectDay(day.iso)}
				>
					<span>{day.label}</span>
					{#if day.meetingCount > 0}
						<span class="aan-sidebar-calendar__dot"></span>
					{/if}
				</button>
			{/each}
		{/each}
	</div>

	<section class="aan-sidebar-agenda">
		<header>
			<div class="aan-calendar-day-label">
				{new Date(selectedDate).toLocaleDateString(undefined, {
					weekday: "long",
					month: "long",
					day: "numeric",
				})}
			</div>
			<div class="aan-calendar-day-count">
				{selectedDayEvents.length
					? `${selectedDayEvents.length} meeting${selectedDayEvents.length > 1 ? "s" : ""}`
					: "No meetings"}
			</div>
		</header>
		{#if selectedDayEvents.length === 0}
			<p class="aan-calendar-empty">No meetings scheduled.</p>
		{:else}
			<ul class="aan-calendar-day-list">
				{#each selectedDayEvents as event}
					<li class="aan-calendar-day-row">
						<div class="aan-calendar-day-time">
							<span>{event.start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
							<span class="aan-calendar-day-time__end">
								{event.end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
							</span>
						</div>
						<div class="aan-calendar-day-content">
							<div class="aan-calendar-day-title">
								<span
									class="aan-calendar-day-dot"
									style={`background:${event.color || "var(--interactive-accent)"}`}
								></span>
								{event.title}
							</div>
							{#if event.tags?.length}
								<div class="aan-calendar-day-meta">
									<div class="aan-calendar-tag-row">
										{#each event.tags as tag}
											<span class="aan-calendar-chip--soft">{tag}</span>
										{/each}
									</div>
								</div>
							{/if}
							<div class="aan-calendar-day-actions">
								<button
									class="aan-calendar-icon-button"
									title="Open note"
									on:click={() => openEvent(event.path, false)}
								>
									<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide-icon lucide lucide-file-text "><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><line x1="10" y1="9" x2="8" y2="9"></line></svg>
								</button>
								<button
									class="aan-calendar-icon-button"
									title="Open in new pane"
									on:click={() => openEvent(event.path, true)}
								>
									<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide-icon lucide lucide-external-link "><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
								</button>
							</div>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
	</div>
