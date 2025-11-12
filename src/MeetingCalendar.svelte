<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import { Calendar } from "@fullcalendar/core";
	import dayGridPlugin from "@fullcalendar/daygrid";
	import interactionPlugin from "@fullcalendar/interaction";
	import timeGridPlugin from "@fullcalendar/timegrid";
	import { ExternalLink, FileText } from "lucide-svelte";
	import type { MeetingEvent } from "./meeting-events";
	import { localDateKey } from "./meeting-events";

export let events: MeetingEvent[] = [];
export let selectedDate: string;
export let colorLegend: Record<string, string> = {};
export let onSelectDate: (date: string) => void;
export let onOpenNote: (path: string, newLeaf: boolean) => void;
export let onRefresh: () => void;
export let condensed = false;

let calendarEl: HTMLDivElement;
	let calendar: Calendar | null = null;
let currentView: "dayGridMonth" | "timeGridWeek" | "timeGridDay" = "dayGridMonth";
	let currentLabel = "";
	let highlightFrame: number | null = null;

	const today = () => localDateKey(new Date());

	const formatTime = (date: Date) =>
		date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

	const parseDateString = (value: string) => {
		const [year, month, day] = value.split("-").map((part) => Number(part));
		return new Date(year, (month ?? 1) - 1, day ?? 1);
	};

	const humanizeDate = (iso: string) =>
		parseDateString(iso).toLocaleDateString(undefined, {
			weekday: "long",
			month: "long",
			day: "numeric",
		});

	const toCalendarEvents = () =>
		events.map((event) => ({
			id: event.path,
			title: event.title,
			start: event.start,
			end: event.end,
			allDay: false,
			backgroundColor: event.color,
			borderColor: event.color,
			extendedProps: {
				path: event.path,
			},
		}));

		$: selectedDayEvents = events
			.filter((event) => (event.displayDate || localDateKey(event.start)) === selectedDate)
			.sort((a, b) => a.start.getTime() - b.start.getTime());

	const legendEntries = () =>
		Object.entries(colorLegend || {}).filter(
			([tag, color]) => tag && color && tag.trim() && color.trim()
		);

	const scheduleSelectedDayHighlight = () => {
		if (highlightFrame) {
			cancelAnimationFrame(highlightFrame);
			highlightFrame = null;
		}
		highlightFrame = requestAnimationFrame(() => {
			highlightFrame = null;
			if (!calendarEl || !selectedDate) return;
			const selectedCells = calendarEl.querySelectorAll(".aan-calendar-day-selected");
			selectedCells.forEach((cell) => cell.classList.remove("aan-calendar-day-selected"));
			const selector = `[data-date="${selectedDate}"]`;
			const target = calendarEl.querySelector<HTMLElement>(selector);
			target?.classList.add("aan-calendar-day-selected");
		});
	};

	const changeView = (view: "dayGridMonth" | "timeGridWeek" | "timeGridDay") => {
		if (condensed && view !== "dayGridMonth") {
			return;
		}
		currentView = view;
		if (calendar) {
			calendar.changeView(view, parseDateString(selectedDate));
			currentLabel = calendar.view.title;
			scheduleSelectedDayHighlight();
		}
	};

	const syncCalendar = () => {
		if (!calendar) return;
		calendar.batchRendering(() => {
			calendar.removeAllEvents();
			calendar.addEventSource(toCalendarEvents());
			if (selectedDate) {
				calendar.gotoDate(parseDateString(selectedDate));
			}
		});
		currentLabel = calendar?.view?.title ?? "";
		scheduleSelectedDayHighlight();
		requestAnimationFrame(() => calendar?.updateSize());
	};

	const setSelectedDate = (value: string) => {
		selectedDate = value;
		scheduleSelectedDayHighlight();
		onSelectDate?.(selectedDate);
	};

	const handleDatesSet = () => {
		currentLabel = calendar?.view?.title ?? "";
		scheduleSelectedDayHighlight();
	};

	const gotoPrev = () => {
		calendar?.prev();
		currentLabel = calendar?.view?.title ?? "";
		scheduleSelectedDayHighlight();
	};

	const gotoNext = () => {
		calendar?.next();
		currentLabel = calendar?.view?.title ?? "";
		scheduleSelectedDayHighlight();
	};

	const gotoToday = () => {
		calendar?.today();
		currentLabel = calendar?.view?.title ?? "";
		setSelectedDate(today());
	};

	onMount(() => {
		calendar = new Calendar(calendarEl, {
			initialView: currentView,
			plugins: [dayGridPlugin, timeGridPlugin, interactionPlugin],
			height: "100%",
			handleWindowResize: true,
			headerToolbar: false,
			showNonCurrentDates: false,
			fixedWeekCount: false,
			datesSet: () => handleDatesSet(),
			dateClick: (info) => {
				setSelectedDate(localDateKey(info.date));
			},
			eventClick: (info) => {
				info.jsEvent.preventDefault();
				const path = info.event.extendedProps.path as string;
				const newLeaf = info.jsEvent.metaKey || info.jsEvent.ctrlKey;
				onOpenNote?.(path, newLeaf);
			},
		});
		calendar.render();
		requestAnimationFrame(() => calendar?.updateSize());
		syncCalendar();
		scheduleSelectedDayHighlight();

		return () => {
			calendar?.destroy();
			calendar = null;
		};
	});

	onDestroy(() => {
		if (highlightFrame) {
			cancelAnimationFrame(highlightFrame);
			highlightFrame = null;
		}
		if (calendar) {
			calendar.destroy();
		}
		calendar = null;
	});

	$: syncCalendar();
</script>

<div class={`aan-calendar-panel ${condensed ? "aan-calendar-panel--condensed" : ""}`}>
		<div class="aan-calendar-toolbar">
			<div class="aan-calendar-toolbar__group">
				<button on:click={gotoPrev}>Prev</button>
				<button on:click={gotoToday}>Today</button>
				<button on:click={gotoNext}>Next</button>
			</div>
			<div class="aan-calendar-toolbar__label">{currentLabel}</div>
			{#if !condensed}
				<div class="aan-calendar-toolbar__group">
					<button class:selected={currentView === "dayGridMonth"} on:click={() => changeView("dayGridMonth")}>
						Month
					</button>
					<button class:selected={currentView === "timeGridWeek"} on:click={() => changeView("timeGridWeek")}>
						Week
					</button>
					<button class:selected={currentView === "timeGridDay"} on:click={() => changeView("timeGridDay")}>
						Day
					</button>
				</div>
				<button class="aan-calendar-refresh" on:click={() => onRefresh?.()}>Refresh</button>
			{/if}
		</div>
	<div class="aan-calendar-grid" bind:this={calendarEl}></div>
	<div class="aan-calendar-day-view">
		<div class="aan-calendar-day-header">
			<div>
				<div class="aan-calendar-day-label">{humanizeDate(selectedDate)}</div>
				<div class="aan-calendar-day-count">
					{selectedDayEvents.length
						? `${selectedDayEvents.length} meeting${selectedDayEvents.length > 1 ? "s" : ""}`
						: "No meetings"}
				</div>
			</div>
			{#if legendEntries().length}
				<div class="aan-calendar-legend">
					{#each legendEntries() as [tag, color]}
						<div class="aan-calendar-legend-item">
							<span class="aan-calendar-legend-swatch" style={`background:${color}`}></span>
							<span class="aan-calendar-legend-label">{tag}</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>
		{#if selectedDayEvents.length === 0}
			<p class="aan-calendar-empty">No meetings scheduled.</p>
		{:else}
			<ul class="aan-calendar-day-list">
				{#each selectedDayEvents as event}
					<li class="aan-calendar-day-row">
						<div class="aan-calendar-day-time">
							<span>{formatTime(event.start)}</span>
							<span class="aan-calendar-day-time__end">{formatTime(event.end)}</span>
						</div>
						<div class="aan-calendar-day-content">
							<div class="aan-calendar-day-title">
								<span class="aan-calendar-day-dot" style={`background:${event.color}`}></span>
								{event.title}
							</div>
							<div class="aan-calendar-day-meta">
								{#if event.label}
									<div class="aan-calendar-label-row">
										<span class="aan-calendar-label-caption">
											{event.label.categoryName ?? "Label"}
										</span>
										<span
											class="aan-calendar-chip aan-calendar-chip--label"
											title={event.label.tag}
										>
											{#if event.label.icon}
												<span
													class="aan-calendar-label-icon"
													aria-hidden="true"
												>
													{event.label.icon}
												</span>
											{/if}
											{event.label.displayName}
										</span>
									</div>
								{/if}
								{#if event.tags?.length}
									<div class="aan-calendar-tag-row">
										{#each event.tags as tag}
											<span class="aan-calendar-chip--soft">{tag}</span>
										{/each}
									</div>
								{/if}
							</div>
							<div class="aan-calendar-day-actions">
								<button
									class="aan-calendar-icon-button"
									title="Open note"
									aria-label="Open note"
									on:click={() => onOpenNote?.(event.path, false)}
								>
									<FileText size={16} />
								</button>
								<button
									class="aan-calendar-icon-button"
									title="Open in new pane"
									aria-label="Open in new pane"
									on:click={() => onOpenNote?.(event.path, true)}
								>
									<ExternalLink size={16} />
								</button>
							</div>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
