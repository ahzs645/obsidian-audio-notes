# Transcript Sidebar Refactor Notes

`src/views/TranscriptSidebarView.ts` has grown into the orchestration point for nearly every workflow in the sidebar. Today it owns:

- View lifecycle (meeting vs dashboard) and workspace-leaf routing.
- Attachment uploads, deletions, and sync state.
- Audio upload + transcription flows for Deepgram/Scriberr.
- Meeting label pickers and category modals.
- Dashboard calendar bootstrapping.
- File deletion + metadata clean-up.

To keep iterating without reintroducing a monolith, peel functionality into focused controllers while leaving the ItemView as a coordinator.

## Suggested module seams

1. **Header & label controls** – Extract `buildHeaderActions` + update logic into a `TranscriptHeaderController`. It receives the current label info + mode, emits events for “pick label”, “delete meeting”, etc., and encapsulates DOM listeners.
2. **Meeting panel presenter** – Move `showMeetingFile`, `resetAttachments`, and `syncAttachments` into a presenter that accepts collaborators (`AttachmentManager`, `TranscriptionService`, etc.). The ItemView delegates file changes to it.
3. **Transcription/audio tasks** – Wrap `handleMeetingAudioUpload` and `handleTranscriptionRequest` inside a task controller that exposes status events. The Svelte component subscribes to its state instead of poking flags.
4. **Dashboard presenter** – `DashboardController` already renders the calendar; add a tiny wrapper so the ItemView no longer toggles classes or placeholder text directly.
5. **Meeting deletion workflow** – Move `confirmDeleteCurrentMeeting` + `deleteCurrentMeeting` into a `MeetingDeletionManager` responsible for notices and failure aggregation.

Each module can live beside the existing helpers under `src/views/transcript-sidebar/`. With CSS now split (`src/styles/`), new components can ship their own scoped styles rather than editing `styles.css`.

## Migration plan

1. Start with the header/label controller—the DOM is already isolated. Return a small object with `setLabel`, `setEnabled`, etc., and swap direct DOM access for method calls.
2. Introduce a `MeetingPanelPresenter` that exposes `showMeetingFile` / `showDashboard`. Let it own attachment + transcript wiring so the view only passes workspace events.
3. Layer a shared state object (even a Svelte store) for `{ isUploadingAudio, isTranscribing, currentMeeting }` and feed it into `TranscriptDisplay`. This keeps UI declarative.
4. Once those seams exist, migrate deletion + label picker flows one by one without a risky “big bang”.

