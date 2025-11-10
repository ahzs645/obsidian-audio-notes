import { MarkdownView, Notice, TFile, type App } from "obsidian";
import type { AudioNotesSettings } from "./AudioNotesSettings";
import { generateMeetingNoteContent } from "./MeetingNoteTemplate";

export const createNewAudioNoteFile = async (
	app: App,
	settings: AudioNotesSettings,
	audioFilename: string,
	transcriptFilename: string | undefined,
	newNoteFilename: string,
	title: string
) => {
    if (transcriptFilename === undefined) {
        transcriptFilename = audioFilename;
        const testTranscriptFilename = transcriptFilename.split(".").slice(0, transcriptFilename.split(".").length - 1).join(".") + ".json";
        if (await app.vault.adapter.exists(testTranscriptFilename)) {
            transcriptFilename = testTranscriptFilename;
        }
    }
	const noteContent = generateMeetingNoteContent(settings, {
		title,
		audioPath: audioFilename,
		transcriptPath: transcriptFilename,
		start: new Date(),
		end: new Date(),
	});
	const lines = noteContent.split("\n");
	const notesHeadingIndex = lines.findIndex(
		(line) => line.trim() === "## Notes"
	);
	const cursorLine = notesHeadingIndex === -1 ? lines.length : notesHeadingIndex + 1;
    app.vault.create(newNoteFilename, noteContent).then((newNote: TFile) => {
        // Create the file and open it in the active leaf
        const leaf = app.workspace.getLeaf(false);
        leaf.openFile(newNote).then(() => {
            const view = leaf.view;
            if (view && view instanceof MarkdownView) {
                view.editor.setCursor(cursorLine, 0);
            }
        });
    }).catch((error: any) => {
        new Notice(`Could not create new audio note file: ${newNoteFilename}`);
        new Notice(`${error}`);
    });
}

export const createAudioNoteTitleFromUrl = (url: string): string => {
    const urlParts = url.split("/");
    const lastPart = urlParts[urlParts.length - 1];
    let title = lastPart.split("?")[0];
    if (title.includes(".mp3")) {
        title = title.replace(/.mp3/g, "");
    } else if (title.includes(".m4b")) {
        title = title.replace(/.m4b/g, "");
    } else if (title.includes(".m4a")) {
        title = title.replace(/.m4a/g, "");
    }
    return title;
}

export const createAudioNoteFilenameFromUrl = (url: string): string => {
    const title = createAudioNoteTitleFromUrl(url);
    const newNoteFilename = (title.replace(/[|&\/\\#,+()$~%'":*?<>{}]/g, "-")) + ".md";
    return newNoteFilename;
}

export const normalizeFolderPath = (
	folderPath: string | undefined,
	fallback: string = ""
): string => {
	const target = (folderPath || fallback || "").trim();
	const cleaned = target.replace(/\\/g, "/").replace(/\/+$/, "");
	return cleaned;
};

export const ensureFolderExists = async (
	app: App,
	folderPath: string
): Promise<void> => {
	if (!folderPath) {
		return;
	}
	const segments = folderPath.split("/").filter((segment) => !!segment);
	let currentPath = "";
	for (const segment of segments) {
		currentPath = currentPath ? `${currentPath}/${segment}` : segment;
		const exists = await app.vault.adapter.exists(currentPath);
		if (!exists) {
			await app.vault.createFolder(currentPath);
		}
	}
};

export const createDeepgramQueryParams = (language: string): any => {
    const DGoptions = {
        language: language,
        modelTier: "base",
        punctuation: true,
        numbers: true,
        profanity: true,
        keywords: "",
    };
    const options = {
        language: DGoptions.language,
        tier: DGoptions.modelTier,
        punctuate: DGoptions.punctuation,
        numbers: DGoptions.numbers,
        profanity_filter: DGoptions.profanity,
        keywords: DGoptions.keywords
            .split(",")
            .map((keyword: string) => keyword.trim()),
    }
    let optionsWithValue = Object.keys(options).filter(function (x) {
        // @ts-ignore
        return options[x] !== false && options[x] !== "";
    });
    let optionsToPass = {};
    optionsWithValue.forEach((key) => {
        // @ts-ignore
        optionsToPass[key] = options[key];
    });
    return optionsToPass;
}
