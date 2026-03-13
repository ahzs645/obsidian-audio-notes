# Google Drive Audio Archive

This plugin currently treats meeting audio as one of two things:

- A vault-relative path in `media_uri`
- An `http` or `https` URL in `media_uri`

For an Obsidian Sync setup where audio should stay out of the synced vault, there are now two supported paths:

- Direct external storage for new desktop uploads and new Whisper imports
- Migration of older vault-local audio into the external archive

The stable note pattern is:

- Keep `transcript_uri` in the vault
- Remove `media_uri` once the recording is archived outside the vault
- Store metadata pointing to the archived recording in Google Drive

## Recommended Frontmatter

For meetings with archived audio outside the vault:

```yaml
---
title: Team Sync
transcript_uri: transcripts/2026/03/12/team-sync.json
recording_archive: google-drive
recording_drive_path: 2026/03/12/team-sync/audio.m4a
recording_url: https://drive.google.com/file/d/FILE_ID/view
tags: [meeting]
---
```

Field meanings:

- `transcript_uri`: Vault-relative transcript path. This remains synced by Obsidian Sync.
- `recording_archive`: Archive backend identifier. Use `google-drive`.
- `recording_drive_path`: Path relative to your chosen Google Drive archive root.
- `recording_url`: Optional Google Drive share link for opening the recording externally.

For meetings that still have a local in-vault audio copy:

```yaml
---
title: Team Sync
media_uri: MediaArchive/audio/2026/03/12/team-sync/audio.m4a
transcript_uri: transcripts/2026/03/12/team-sync.json
tags: [meeting]
---
```

Use `media_uri` only for recordings you intentionally keep inside the vault.

## Migration Workflow

1. Move or copy the audio file from the vault into your Google Drive local sync folder.
2. Remove `media_uri` from the note so Obsidian Sync no longer needs to carry the recording.
3. Add `recording_archive: google-drive`.
4. Add `recording_drive_path` relative to the Google Drive archive root.
5. Optionally add `recording_url` if you want a one-tap external link from the note.

## Migration Script

This repo includes a helper:

```bash
node scripts/migrate-google-drive-audio.js \
  --vault-root "/path/to/your/vault" \
  --notes-root "meetings" \
  --source-audio-root "MediaArchive/audio" \
  --drive-root "/Users/you/Library/CloudStorage/GoogleDrive-you@gmail.com/My Drive/Ahmad/Obsidian/Meetings"
```

Run it without `--apply` first. That produces a dry-run report only.

When the output looks correct:

```bash
node scripts/migrate-google-drive-audio.js \
  --vault-root "/path/to/your/vault" \
  --notes-root "meetings" \
  --source-audio-root "MediaArchive/audio" \
  --drive-root "/Users/you/Library/CloudStorage/GoogleDrive-you@gmail.com/My Drive/Ahmad/Obsidian/Meetings" \
  --apply
```

Default behavior is `move`, not `copy`, so the vault stops carrying those archived recordings.

Useful flags:

- `--mode copy`: Copy audio into Google Drive but keep the original vault file for a staged migration.
- `--keep-media-uri`: Keep the existing `media_uri` field instead of removing it.
- `--manifest /path/to/report.json`: Write a machine-readable migration report.

## Notes

- The current plugin does not automatically open `recording_url` or `recording_drive_path`. These fields are archival metadata for now.
- Archived notes continue to work well as transcript-first meeting notes because `transcript_uri` stays in the vault.
- Google Drive share links are best treated as external fallback links, not guaranteed embedded audio playback URLs.
