import { Notice } from "obsidian";
import { generateRandomString, getIcon } from "../utils";
import type { AudioNote } from "../AudioNotes";
import type { AudioNotesSettings } from "../AudioNotesSettings";

export interface AudioPlayerEnvironment {
	settings: AudioNotesSettings;
	getSavedCurrentTime: (src: string) => number | undefined;
	updateKnownCurrentTime: (src: string, value: number) => void;
	updateCurrentTimeOfAudio: (audio: HTMLMediaElement) => void;
	saveCurrentPlayerPosition: (audio: HTMLMediaElement) => void;
	setCurrentPlayerId: (id: string | null) => void;
	getKnownDuration: (src: string) => number | undefined;
	setKnownDuration: (src: string, value: number) => void;
	renderTimeDisplay: (
		timeElement: HTMLElement,
		currentSeconds: number,
		durationSeconds: number
	) => void;
	resolveAudioSrc: (audioNote: AudioNote) => string | undefined;
	registerCleanup: (cleanup: () => void) => void;
}

export interface AudioPlayerControls {
	/** Show a length before the file is loaded (e.g. the transcript's last timestamp). */
	setDurationHint: (seconds: number | null) => void;
	/** Stop playback and drop the source so the file handle/download is released. */
	release: () => void;
}

const isUsableDuration = (value: number | null | undefined): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;

function normalizeSrc(src: string): string {
	try {
		return new URL(src, document.baseURI).href;
	} catch {
		return src;
	}
}

/**
 * Builds the compact player. The audio file is not attached to the element
 * until the user presses play, so opening a meeting never reads (or forces
 * Google Drive to download) the recording.
 */
export function createAudioPlayer(
	env: AudioPlayerEnvironment,
	audioNote: AudioNote,
	updateTranscript?: (props: Record<string, unknown>) => void
): [
	HTMLMediaElement | undefined,
	HTMLElement | undefined,
	AudioPlayerControls | undefined
] {
	const fakeUuid = generateRandomString(8);
	const audioSrcPath = env.resolveAudioSrc(audioNote);
	if (!audioSrcPath) {
		return [undefined, undefined, undefined];
	}
	// Same form `audio.src` reports once attached, so saved positions line up.
	const srcKey = normalizeSrc(audioSrcPath);

	const audio = new Audio();
	audio.preload = "none";
	audio.id = `audio-player-${fakeUuid}`;
	audio.playbackRate = audioNote.speed;

	let sourceAttached = false;
	let released = false;
	let pendingTime = 0;
	let durationHint: number | null = env.getKnownDuration(srcKey) ?? null;

	if (!audioNote.audioFilename.includes("#t=")) {
		const savedTime = env.getSavedCurrentTime(srcKey);
		if (savedTime !== undefined && savedTime > 0) {
			pendingTime = savedTime;
		}
	}

	const hasMetadata = () => sourceAttached && audio.readyState > 0;
	const getCurrentTime = () =>
		hasMetadata() ? audio.currentTime : pendingTime;
	const getDuration = (): number | null =>
		isUsableDuration(audio.duration) ? audio.duration : durationHint;

	const playButton = createEl("button", {
		attr: {
			id: `play-icon-${fakeUuid}`,
			type: "button",
			"aria-label": "Play",
			title: "Play",
		},
		cls: "audio-note-play-button",
	});
	const playIcon = getIcon("play");
	const pauseIcon = getIcon("pause");
	if (playIcon) {
		playButton.appendChild(playIcon);
	}

	const setLoading = (loading: boolean) => {
		playButton.toggleClass("is-loading", loading);
		playButton.toggleAttribute("aria-busy", loading);
	};

	const seeker = createEl("input", {
		attr: { id: `seek-slider-${fakeUuid}`, "aria-label": "Seek" },
		type: "range",
		value: "0",
		cls: "seek-slider",
	});
	seeker.max = "100";
	seeker.step = "any";

	const timeSpan = createEl("span", {
		attr: {
			id: `current-time-${fakeUuid}`,
			"data-time-format": "split",
		},
		cls: "time",
	});
	timeSpan.createSpan({ cls: "time-current", text: "0:00" });
	timeSpan.createSpan({ cls: "time-divider", text: "/" });
	timeSpan.createSpan({ cls: "time-total", text: "--:--" });

	let speedValueSpan: HTMLElement;

	const speedSteps = [0.75, 1, 1.25, 1.5, 1.75, 2];
	if (!speedSteps.some((step) => Math.abs(step - audio.playbackRate) < 0.01)) {
		speedSteps.push(audio.playbackRate);
		speedSteps.sort((a, b) => a - b);
	}
	let speedIndex = speedSteps.findIndex(
		(step) => Math.abs(step - audio.playbackRate) < 0.01
	);
	if (speedIndex === -1) speedIndex = 1;

	const formatSpeed = (rate: number) =>
		Math.abs(rate - Math.round(rate)) < 0.01
			? `${Math.round(rate)}x`
			: `${rate.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}x`;

	let updateSpeedButtonsState = () => {};

	const applySpeed = (rate: number) => {
		audio.playbackRate = rate;
		audioNote.speed = rate;
		speedValueSpan.setText(formatSpeed(rate));
		updateSpeedButtonsState();
	};

	const notifyTranscriptTime = () => {
		updateTranscript?.({
			currentTime: getCurrentTime(),
		});
	};

	const updateTime = () => {
		const duration = getDuration();
		env.renderTimeDisplay(timeSpan, getCurrentTime(), duration ?? 0);
		if (duration === null) {
			timeSpan.querySelector(".time-total")?.setText("--:--");
		}
	};

	const updateSeeker = () => {
		const duration = getDuration();
		const current = getCurrentTime();
		seeker.disabled = duration === null;
		seeker.max = (duration ?? Math.max(current, 1)).toString();
		seeker.value = current.toString();
		const percent =
			duration === null
				? 0
				: Math.min(100, Math.max((current / duration) * 100, 0));
		seeker.style.setProperty("--seek-progress", `${percent}%`);
	};

	const refreshUi = () => {
		updateTime();
		updateSeeker();
	};

	const rememberPosition = () => {
		if (sourceAttached) {
			env.updateCurrentTimeOfAudio(audio);
		}
		env.updateKnownCurrentTime(srcKey, getCurrentTime());
	};

	const seekTo = (time: number) => {
		const duration = getDuration();
		let target = Math.max(0, time);
		if (duration !== null) {
			target = Math.min(target, duration);
		}
		if (hasMetadata()) {
			audio.currentTime = target;
		} else {
			// Not loaded yet: remember where to start when play is pressed.
			pendingTime = target;
		}
		refreshUi();
		rememberPosition();
		notifyTranscriptTime();
	};

	const attachSource = () => {
		if (sourceAttached) return;
		sourceAttached = true;
		released = false;
		audio.preload = "auto";
		audio.src = audioSrcPath;
		audio.playbackRate = audioNote.speed;
	};

	const play = async () => {
		attachSource();
		setLoading(audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA);
		try {
			await audio.play();
		} catch (error) {
			setLoading(false);
			if ((error as DOMException)?.name === "AbortError" || released) {
				return;
			}
			console.error("Audio Notes: could not play audio", error);
			new Notice(
				"Could not play this recording. If it lives in Google Drive, it may still be downloading.",
				6000
			);
		}
	};

	const togglePlayback = () => {
		if (audio.paused) {
			void play();
		} else {
			audio.pause();
		}
	};

	playButton.addEventListener("click", togglePlayback);

	updateTranscript?.({
		onSeekToTime: seekTo,
	});

	audio.addEventListener("loadedmetadata", () => {
		if (pendingTime > 0 && Math.abs(audio.currentTime - pendingTime) > 0.25) {
			audio.currentTime = pendingTime;
		}
		pendingTime = 0;
		if (isUsableDuration(audio.duration)) {
			durationHint = audio.duration;
			env.setKnownDuration(srcKey, audio.duration);
		}
		refreshUi();
		updateTranscript?.({
			metadataDuration: getDuration(),
			currentTime: getCurrentTime(),
		});
	});

	audio.addEventListener("waiting", () => setLoading(true));
	audio.addEventListener("playing", () => setLoading(false));
	audio.addEventListener("canplay", () => setLoading(false));
	audio.addEventListener("error", () => {
		setLoading(false);
		if (!released && sourceAttached) {
			new Notice("Could not load this recording.", 6000);
		}
	});

	const setPlayingIcon = (playing: boolean) => {
		if (playIcon && pauseIcon) {
			const [from, to] = playing
				? [playIcon, pauseIcon]
				: [pauseIcon, playIcon];
			from.parentNode?.replaceChild(to, from);
		}
		const label = playing ? "Pause" : "Play";
		playButton.setAttribute("aria-label", label);
		playButton.setAttribute("title", label);
	};

	const bindMediaSession = () => {
		if (!("mediaSession" in navigator)) return;
		let title = audioNote.audioFilename;
		title = title.split(".")[title.split(".").length - 2] ?? title;
		title = title.split("/")[title.split("/").length - 1];
		title = title.split("\\")[title.split("\\").length - 1];
		navigator.mediaSession.metadata = new MediaMetadata({ title });
		navigator.mediaSession.setActionHandler("play", () => void play());
		navigator.mediaSession.setActionHandler("pause", () => audio.pause());
		navigator.mediaSession.setActionHandler("stop", () => audio.pause());
		navigator.mediaSession.setActionHandler("seekbackward", () =>
			seekTo(getCurrentTime() - env.settings.backwardStep)
		);
		navigator.mediaSession.setActionHandler("seekforward", () =>
			seekTo(getCurrentTime() + env.settings.forwardStep)
		);
		navigator.mediaSession.setActionHandler("seekto", (ev: any) =>
			seekTo(ev.seekTime)
		);
	};

	audio.addEventListener("play", () => {
		env.setCurrentPlayerId(fakeUuid);
		setPlayingIcon(true);
		bindMediaSession();
		env.saveCurrentPlayerPosition(audio);
	});

	const handlePauseLikeEvent = () => {
		setPlayingIcon(false);
		setLoading(false);
		if (sourceAttached && !released) {
			env.saveCurrentPlayerPosition(audio);
		}
	};

	audio.addEventListener("pause", handlePauseLikeEvent);
	audio.addEventListener("ended", handlePauseLikeEvent);

	audio.addEventListener("timeupdate", () => {
		refreshUi();
		rememberPosition();
		notifyTranscriptTime();
	});

	const handleSeekerInput = () => {
		seekTo(parseFloat(seeker.value));
	};
	seeker.addEventListener("input", handleSeekerInput);
	seeker.addEventListener("change", handleSeekerInput);

	const overrideSpaceKey = (event: KeyboardEvent) => {
		if (event.key === " " || event.keyCode === 32) {
			event.preventDefault();
			togglePlayback();
		}
	};
	playButton.onkeydown = overrideSpaceKey;

	const audioPlayerContainer = createDiv({
		attr: { id: `audio-player-container-${fakeUuid}` },
		cls: "audio-player-container",
	});
	audio.addClass("aan-player-hidden-audio");
	audioPlayerContainer.appendChild(audio);

	// Seek bar on its own row, then buttons with the time on the right. Wide
	// panes flatten both rows into one via CSS (see player.css).
	const controlsRow = audioPlayerContainer.createDiv("aan-player-compact");
	const sliderRow = controlsRow.createDiv("aan-player-compact-slider");
	sliderRow.appendChild(seeker);
	const barRow = controlsRow.createDiv("aan-player-compact-bar");
	const controlGroup = barRow.createDiv("aan-player-compact-buttons");
	controlGroup.appendChild(playButton);
	const speedControl = controlGroup.createDiv("aan-player-speed-control");
	const decreaseSpeedButton = speedControl.createEl("button", {
		attr: {
			type: "button",
			"aria-label": "Slow down playback",
			title: "Slow down playback",
		},
		cls: "audio-note-speed-adjust",
		text: "-",
	});
	speedValueSpan = speedControl.createSpan({
		cls: "audio-note-speed-value",
		text: "",
	});
	const increaseSpeedButton = speedControl.createEl("button", {
		attr: {
			type: "button",
			"aria-label": "Speed up playback",
			title: "Speed up playback",
		},
		cls: "audio-note-speed-adjust",
		text: "+",
	});

	const clampSpeedIndex = (value: number) =>
		Math.max(0, Math.min(speedSteps.length - 1, value));

	const handleSpeedAdjustment = (delta: number) => {
		const nextIndex = clampSpeedIndex(speedIndex + delta);
		if (nextIndex !== speedIndex) {
			speedIndex = nextIndex;
			applySpeed(speedSteps[speedIndex]);
		}
	};

	decreaseSpeedButton.addEventListener("click", () =>
		handleSpeedAdjustment(-1)
	);
	increaseSpeedButton.addEventListener("click", () =>
		handleSpeedAdjustment(1)
	);

	updateSpeedButtonsState = () => {
		decreaseSpeedButton.toggleAttribute(
			"disabled",
			speedIndex <= 0 || speedSteps.length === 0
		);
		increaseSpeedButton.toggleAttribute(
			"disabled",
			speedIndex >= speedSteps.length - 1 || speedSteps.length === 0
		);
	};

	applySpeed(speedSteps[speedIndex]);

	barRow.appendChild(timeSpan);

	refreshUi();
	if (pendingTime > 0) {
		notifyTranscriptTime();
	}

	const controls: AudioPlayerControls = {
		setDurationHint: (seconds) => {
			if (isUsableDuration(audio.duration)) return;
			durationHint = isUsableDuration(seconds) ? seconds : null;
			refreshUi();
		},
		release: () => {
			if (released) return;
			released = true;
			if (!sourceAttached) return;
			if (!audio.paused) {
				audio.pause();
			}
			env.saveCurrentPlayerPosition(audio);
			audio.removeAttribute("src");
			audio.load();
			sourceAttached = false;
		},
	};

	return [audio, audioPlayerContainer, controls];
}
