<script lang="ts">
	import { localDateKey } from "../meeting-events";
	import type { MeetingEvent } from "../meeting-events";
	import type { NormalizedMeetingLabelCategory } from "../meeting-labels";

	export let events: MeetingEvent[] = [];
	export let selectedDate: string;
	export let categories: NormalizedMeetingLabelCategory[] = [];
	export let filterValue: string = "";
	export let onSelectDate: (date: string) => void;
	export let onOpenNote: (path: string, newLeaf: boolean) => void;
	export let onFilterChange: (value: string) => void = () => {};
	export let onCreateMeeting: (date: string) => void = () => {};

	const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const todayKey = localDateKey(new Date());
	$: selectedDayDate = parseISODate(selectedDate);

	let monthCursor = firstDayOfMonth(selectedDate);
	let lastSelected = selectedDate;

	$: if (selectedDate !== lastSelected) {
		lastSelected = selectedDate;
		monthCursor = firstDayOfMonth(selectedDate);
	}

	$: filteredEvents = filterEvents(events, filterValue);
	$: eventsByDate = buildEventsByDate(filteredEvents);
	$: weeks = buildCalendar(monthCursor, eventsByDate, selectedDate);
	$: selectedDayEvents = (filteredEvents || [])
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

	function buildCalendar(
		month: Date,
		map: Map<string, MeetingEvent[]>,
		selected: string
	) {
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
					isSelected: iso === selected,
					meetingCount: map.get(iso)?.length || 0,
				});
			}
			weeks.push({ label: `week-${w}`, days });
		}
		return weeks.filter((week) =>
			week.days.some((day) => day.isCurrentMonth)
		);
	}

	function selectDay(iso: string) {
		monthCursor = firstDayOfMonth(iso);
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

	const formatTimeLabel = (date: Date) =>
		date.toLocaleTimeString([], {
			hour: "numeric",
			minute: "2-digit",
		});

	function formatDuration(start: Date, end: Date): string {
		const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
		if (!Number.isFinite(minutes) || minutes <= 0) return "";
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.floor(minutes / 60);
		const rest = minutes % 60;
		return rest ? `${hours}h ${rest}m` : `${hours}h`;
	}

	const formatTagForLabel = (tag?: string) => {
		if (!tag) return "";
		const slashIndex = tag.lastIndexOf("/");
		if (slashIndex === -1) {
			return tag;
		}
		return tag.slice(slashIndex + 1);
	};
	function filterEvents(
		source: MeetingEvent[],
		value: string
	): MeetingEvent[] {
		if (!value) {
			return source || [];
		}
		if (value === "__unlabeled__") {
			return (source || []).filter((event) => !event.label?.tag);
		}
		if (value.startsWith("category:")) {
			const categoryId = value.slice("category:".length);
			return (source || []).filter(
				(event) => event.label?.categoryId === categoryId
			);
		}
		if (value.startsWith("tag:")) {
			const tag = value.slice("tag:".length);
			return (source || []).filter(
				(event) => event.label?.tag === tag
			);
		}
		return source || [];
	}

	function buildLabelOptions(list: MeetingEvent[]) {
		const map = new Map<
			string,
			{ tag: string; displayName: string; categoryName?: string }
		>();
		for (const event of list || []) {
			const tag = event.label?.tag;
			if (!tag) continue;
			if (map.has(tag)) continue;
			map.set(tag, {
				tag,
				displayName:
					event.label?.displayName || formatTagForLabel(tag),
				categoryName: event.label?.categoryName,
			});
		}
		return Array.from(map.values()).sort((a, b) =>
			a.displayName.localeCompare(b.displayName)
		);
	}

	$: labelOptions = buildLabelOptions(events);

	function handleFilterSelectChange(event: Event) {
		const target = event.currentTarget as HTMLSelectElement | null;
		if (!target) return;
		onFilterChange?.(target.value);
	}

	function handleAddMeeting() {
		const targetDate =
			selectedDayDate instanceof Date &&
			!Number.isNaN(selectedDayDate.getTime())
				? localDateKey(selectedDayDate)
				: todayKey;
		onCreateMeeting?.(targetDate);
	}
</script>

<div class="aan-sidebar-calendar">
	<header class="aan-sidebar-calendar__toolbar">
		<h3 class="aan-sidebar-calendar__label" aria-live="polite" title={monthLabel(monthCursor)}>
			<span class="aan-sidebar-calendar__month">{monthCursor.toLocaleDateString(undefined, { month: "short" })}</span>
			<span class="aan-sidebar-calendar__year">{monthCursor.getFullYear()}</span>
		</h3>
		<div class="aan-sidebar-calendar__btn-group">
			<button type="button" class="aan-sidebar-calendar__arrow" on:click={gotoPrevMonth} aria-label="Previous month" title="Previous month">
				<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="m15 6-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
			</button>
			<button type="button" on:click={gotoToday}>Today</button>
			<button type="button" class="aan-sidebar-calendar__arrow" on:click={gotoNextMonth} aria-label="Next month" title="Next month">
				<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
			</button>
		</div>
	</header>
	<div class="aan-sidebar-calendar__filter">
		<label for="aan-calendar-filter">Filter</label>
		<select
			id="aan-calendar-filter"
			on:change={handleFilterSelectChange}
		>
			<option value="" selected={!filterValue}>All meetings</option>
			<option value="__unlabeled__" selected={filterValue === "__unlabeled__"}>
				No label
			</option>
			{#if categories.length}
				<optgroup label="Categories">
					{#each categories as category}
						<option
							value={`category:${category.id}`}
							selected={filterValue === `category:${category.id}`}
						>
							{category.name}
						</option>
					{/each}
				</optgroup>
			{/if}
			{#if labelOptions.length}
				<optgroup label="Labels">
					{#each labelOptions as option}
						<option
							value={`tag:${option.tag}`}
							selected={filterValue === `tag:${option.tag}`}
						>
							{option.displayName}
						</option>
					{/each}
				</optgroup>
			{/if}
		</select>
	</div>
	<div class="aan-sidebar-calendar__weekdays">
		{#each weekdays as day}
			<div title={day}>
				<span class="aan-sidebar-calendar__weekday-long">{day}</span>
				<span class="aan-sidebar-calendar__weekday-short" aria-hidden="true">{day.charAt(0)}</span>
			</div>
		{/each}
	</div>
	<div class="aan-sidebar-calendar__grid">
		{#each weeks as week}
			{#each week.days as day}
				<button
					class={`aan-sidebar-calendar__cell ${day.isCurrentMonth ? "" : "is-outside"} ${day.isToday ? "is-today" : ""} ${day.isSelected ? "is-selected" : ""}`}
					on:click={() => selectDay(day.iso)}
					type="button"
					aria-label={parseISODate(day.iso).toLocaleDateString(undefined, { dateStyle: "full" })}
					aria-pressed={day.isSelected}
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
		<header class="aan-sidebar-agenda__header">
			<div class="aan-sidebar-agenda__heading">
				{#if selectedDayDate instanceof Date && !Number.isNaN(selectedDayDate.getTime())}
					<div class="aan-calendar-day-label">
						<span class="aan-calendar-day-label-long">
							{selectedDayDate.toLocaleDateString(undefined, {
								weekday: "long",
								month: "long",
								day: "numeric",
							})}
						</span>
						<span class="aan-calendar-day-label-short">
							{selectedDayDate.toLocaleDateString(undefined, {
								weekday: "short",
								month: "short",
								day: "numeric",
							})}
						</span>
					</div>
				{/if}
				<div class="aan-calendar-day-count">
					{selectedDayEvents.length
						? `${selectedDayEvents.length} meeting${selectedDayEvents.length > 1 ? "s" : ""}`
						: "No meetings"}
				</div>
			</div>
			<button
				type="button"
				class="aan-calendar-add-btn"
				title="Add meeting"
				aria-label="Add meeting"
				on:click={handleAddMeeting}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					class="lucide-icon lucide lucide-plus"
				>
					<path d="M5 12h14"></path>
					<path d="M12 5v14"></path>
				</svg>
			</button>
		</header>
		{#if selectedDayEvents.length === 0}
			<p class="aan-calendar-empty">No meetings scheduled.</p>
		{:else}
			<ul class="aan-calendar-day-list">
				{#each selectedDayEvents as event}
					<li class="aan-calendar-day-row">
						<div class="aan-calendar-day-card">
							<div class="aan-calendar-day-card-top">
								<span class="aan-calendar-day-time">
									<span>{formatTimeLabel(event.start)} –</span>
									<span>{formatTimeLabel(event.end)}</span>
								</span>
								{#if formatDuration(event.start, event.end)}
									<span class="aan-calendar-day-duration">
										{formatDuration(event.start, event.end)}
									</span>
								{/if}
								{#if event.label}
									<span class="aan-calendar-day-badge">
										{event.label.name ?? formatTagForLabel(event.label.tag)}
									</span>
								{/if}
							</div>
							<div class="aan-calendar-day-title-row">
								<span
									class="aan-calendar-day-dot"
									style={`background:${event.color || "var(--interactive-accent)"}`}
								></span>
								<!-- The title button stretches over the whole card, so clicking anywhere opens the note. -->
								<button
									type="button"
									class="aan-calendar-day-title-text"
									title={`Open ${event.title}`}
									on:click={() => openEvent(event.path, false)}
								>
									{event.title}
								</button>
								<button
									type="button"
									class="aan-calendar-action-btn"
									title="Open in new pane"
									aria-label={`Open ${event.title} in new pane`}
									on:click={() => openEvent(event.path, true)}
								>
									<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
								</button>
							</div>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
	</div>
