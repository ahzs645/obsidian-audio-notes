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
	renderTimeDisplay: (
		timeElement: HTMLElement,
		currentSeconds: number,
		durationSeconds: number
	) => void;
	resolveAudioSrc: (audioNote: AudioNote) => string | undefined;
	registerCleanup: (cleanup: () => void) => void;
}

export function createAudioPlayer(
	env: AudioPlayerEnvironment,
	audioNote: AudioNote,
	updateTranscript?: (props: Record<string, unknown>) => void
): [HTMLMediaElement | undefined, HTMLElement | undefined] {
	const fakeUuid = generateRandomString(8);
	const audioSrcPath = env.resolveAudioSrc(audioNote);
	if (!audioSrcPath) {
		return [undefined, undefined];
	}

	const audio = new Audio(audioSrcPath);
	audio.id = `audio-player-${fakeUuid}`;
	audio.playbackRate = audioNote.speed;

	if (!audioNote.audioFilename.includes("#t=")) {
		const savedTime = env.getSavedCurrentTime(audio.src);
		if (savedTime !== undefined) {
			audio.currentTime = savedTime;
		}
	}

	const playButton = createEl("button", {
		attr: { id: `play-icon-${fakeUuid}` },
		cls: "audio-note-play-button",
	});
	const playIcon = getIcon("play");
	const pauseIcon = getIcon("pause");
	if (playIcon) {
		playButton.appendChild(playIcon);
	}

	const seeker = createEl("input", {
		attr: { id: `seek-slider-${fakeUuid}` },
		type: "range",
		value: "0",
		cls: "seek-slider",
	});
	seeker.max = "100";

	const timeSpan = createEl("span", {
		attr: {
			id: `current-time-${fakeUuid}`,
			"data-time-format": "split",
		},
		cls: "time",
	});
	timeSpan.createSpan({ cls: "time-current", text: "0:00" });
	timeSpan.createSpan({ cls: "time-divider", text: "/" });
	timeSpan.createSpan({ cls: "time-total", text: "0:00" });

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

	const togglePlayback = () => {
		if (audio.paused) {
			audio.play();
		} else {
			audio.pause();
		}
	};

	const notifyTranscriptTime = () => {
		updateTranscript?.({
			currentTime: audio.currentTime,
		});
	};

	const updateTranscriptMetadata = () => {
		const duration = isNaN(audio.duration) ? null : audio.duration;
		updateTranscript?.({
			metadataDuration: duration,
			currentTime: audio.currentTime,
		});
	};

	const updateTime = (timeElement: HTMLElement) => {
		env.renderTimeDisplay(timeElement, audio.currentTime, audio.duration);
	};

	const updateSeekFill = () => {
		if (!isFinite(audio.duration) || audio.duration <= 0) {
			seeker.style.setProperty("--seek-progress", "0%");
			return;
		}
		const percent = Math.min(
			100,
			Math.max((audio.currentTime / audio.duration) * 100, 0)
		);
		seeker.style.setProperty("--seek-progress", `${percent}%`);
	};

	const updateSeeker = () => {
		if (!isNaN(audio.duration) && audio.duration > 0) {
			seeker.max = Math.floor(audio.duration).toString();
		} else {
			seeker.max = Math.floor(audio.currentTime || 0).toString();
		}
		seeker.value = audio.currentTime.toString();
		updateSeekFill();
	};

	const updateAudioFromSeeker = () => {
		audio.currentTime = parseFloat(seeker.value);
		notifyTranscriptTime();
	};

	playButton.addEventListener("click", togglePlayback);
	audio.addEventListener("timeupdate", notifyTranscriptTime);
	audio.addEventListener("seeked", notifyTranscriptTime);

	updateTranscript?.({
		onSeekToTime: (time: number) => {
			audio.currentTime = time;
			updateTime(timeSpan);
			updateSeeker();
			env.updateCurrentTimeOfAudio(audio);
			notifyTranscriptTime();
		},
	});

	if (audio.readyState > 0) {
		updateSeeker();
		updateTime(timeSpan);
		updateTranscriptMetadata();
	} else {
		audio.addEventListener("loadedmetadata", () => {
			updateSeeker();
			updateTime(timeSpan);
			updateTranscriptMetadata();
		});
	}

	audio.addEventListener("play", () => {
		env.setCurrentPlayerId(fakeUuid);
		if (playIcon && pauseIcon) {
			playIcon.parentNode?.replaceChild(pauseIcon, playIcon);
		}
		env.saveCurrentPlayerPosition(audio);
	});

	const handlePauseLikeEvent = () => {
		if (playIcon && pauseIcon) {
			pauseIcon.parentNode?.replaceChild(playIcon, pauseIcon);
		}
		env.saveCurrentPlayerPosition(audio);
	};

	audio.addEventListener("pause", handlePauseLikeEvent);
	audio.addEventListener("ended", handlePauseLikeEvent);

	audio.addEventListener("timeupdate", () => {
		updateTime(timeSpan);
		updateSeeker();
		env.updateCurrentTimeOfAudio(audio);
		env.updateKnownCurrentTime(audio.src, audio.currentTime);
	});

	seeker.addEventListener("input", () => {
		updateTime(timeSpan);
		updateAudioFromSeeker();
		env.updateCurrentTimeOfAudio(audio);
		env.updateKnownCurrentTime(audio.src, audio.currentTime);
		updateSeekFill();
	});

	seeker.addEventListener("change", () => {
		updateTime(timeSpan);
		updateAudioFromSeeker();
		env.updateCurrentTimeOfAudio(audio);
		env.updateKnownCurrentTime(audio.src, audio.currentTime);
		updateSeekFill();
	});

	const overrideSpaceKey = (event: KeyboardEvent) => {
		if (event.key === " " || event.keyCode === 32) {
			event.preventDefault();
			togglePlayback();
		}
	};
	playButton.onkeydown = overrideSpaceKey;

	if ("mediaSession" in navigator) {
		let title = audioNote.audioFilename;
		title = title.split(".")[title.split(".").length - 2];
		title = title.split("/")[title.split("/").length - 1];
		title = title.split("\\")[title.split("\\").length - 1];
		navigator.mediaSession.metadata = new MediaMetadata({
			title,
		});

		navigator.mediaSession.setActionHandler("play", () => audio.play());
		navigator.mediaSession.setActionHandler("pause", () => audio.pause());
		navigator.mediaSession.setActionHandler("stop", () => audio.pause());
		navigator.mediaSession.setActionHandler("seekbackward", () => {
			audio.currentTime -= env.settings.backwardStep;
			updateTime(timeSpan);
			updateSeeker();
		});
		navigator.mediaSession.setActionHandler("seekforward", () => {
			audio.currentTime += env.settings.forwardStep;
			updateTime(timeSpan);
			updateSeeker();
		});
		navigator.mediaSession.setActionHandler("seekto", (ev: any) => {
			audio.currentTime = ev.seekTime;
			updateTime(timeSpan);
			updateSeeker();
		});
	}

	const audioPlayerContainer = createDiv({
		attr: { id: `audio-player-container-${fakeUuid}` },
		cls: "audio-player-container",
	});
	audio.addClass("aan-player-hidden-audio");
	audioPlayerContainer.appendChild(audio);

	const controlsRow = audioPlayerContainer.createDiv("aan-player-compact");
	const controlGroup = controlsRow.createDiv("aan-player-compact-buttons");
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

	const sliderRow = controlsRow.createDiv("aan-player-compact-slider");
	sliderRow.appendChild(seeker);
	sliderRow.appendChild(timeSpan);

	return [audio, audioPlayerContainer];
}
