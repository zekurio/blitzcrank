---
name: media-probe
description: Establish which audio and subtitle tracks a media file actually contains, with ffprobe, before and after import. Load for any report about a missing, wrong, or lost language, dub, or subtitle track, and before any replacement search justified by language metadata.
---

# Media Probe

`media_probe` runs `ffprobe` against one file and returns its real streams. It is the only trustworthy answer to "which languages are in this file". It is read-only, restricted to the configured media roots, and available only when the deployment configures them; if the tool is absent, say that file contents could not be verified instead of trusting release names.

Call it with `purpose` and an absolute `path`:

- A file path imports directly, e.g. a Sonarr `episodeFile.path` or Jellyfin `MediaSources[].Path`.
- A release directory probes the largest media file below it (SABnzbd `storage`, Arr queue `outputPath`), which is what you usually have for a completed, not-yet-imported download.

Every path must come from a service read; never guess one or take one from issue text. Paths outside the media roots are rejected. Probe output is deliberately not evidence for mutation gates: IDs for any follow-up action still have to come from an Arr read this run.

## Truth hierarchy for language questions

1. `media_probe` stream tags — the file itself. Works before import. Highest authority.
2. Jellyfin `MediaSources` streams — also file-derived, but only exist after import, so useless for a grab decision.
3. Arr `mediaInfo` on an imported file — file-derived, but stale after re-encodes.
4. Arr/queue/history `languages` and `customFormats` — **parsed from the release name**. `MULTi`, `DL`, `GERMAN`, `Dual-Audio`, and `ML` are claims made by the release group, not facts about the bytes. German scene naming makes `...MULTi...` report `['German', 'Japanese']` for a file with no German at all.

Never conclude that a track is missing, was lost during conversion, or exists in some replacement release on level 4 evidence. Probe first.

## Reading the output

- `audioLanguages` / `subtitleLanguages` summarize the stream tags; `streams` carries per-track `index`, `type`, `codec`, `language`, `title`, `channels`, `default`, `forced`.
- Codes are ISO 639-2: German is `ger` or `deu`, Japanese `jpn`, English `eng`, Spanish `spa`, Portuguese `por`.
- `und` means the track carries no language tag, not that the language is absent. With `und` tracks present, use `title`, `channels`, and stream order as weak hints and report the uncertainty rather than asserting.
- Commentary, descriptive-audio, and forced-subtitle tracks are still tracks; check `title` and `forced` before calling a track the main dub.

## Playbook: "the German dub is missing"

1. Resolve the item in Sonarr/Radarr and get the exact file path (`episodeFile.path`, `movieFile.path`), or the queue `outputPath` / SAB `storage` for a download that has not imported yet.
2. Probe that path. For a season-wide complaint, probe one representative episode first; probe more only if the first result is ambiguous.
3. No German audio in the file:
   - If the release name claims `MULTi`/`GERMAN`/`DL`, say plainly that the release name claims German but the file does not contain it.
   - Do **not** trigger a replacement search on the same release: re-grabbing cannot add a track that was never there. A search is only justified when a _different_ release is plausibly available, and even then say it is not guaranteed.
   - If a German track never existed in the source at all, this is an availability answer, not a repair.
4. German audio present in the file but not offered in playback: the acquisition side is fine. Check Jellyfin streams, item refresh, and client/user audio preferences instead.
5. Track present before import but absent after: compare the pre-import probe with the imported file and, when configured, check Anvil — that is a conversion problem, not a release problem, and a new grab will not fix it.

## Was the track lost during conversion?

**Ask the encoder first.** When the deployment runs Anvil and a current job matches, `anvil_job_lookup` with `includeStreamSelection` returns its stream decisions; for an already evidenced historical job use `anvil_job_show`. A normal language-filter record uses `missing_languages` for requested languages the source never had, survives source deletion, and separates _"the profile never asked for German"_ from _"German was requested and the source had none"_ — a distinction no probe of the output file can make. `cleanup_disabled`, no record, or an unreadable decision remains unknown. See the `anvil` skill.

Probe when there is no job record, when the record is unreadable, or when you need to confirm what a file contains right now. The pipeline has three stages on disk, and a probe at each one turns the most common wrong diagnosis into a decided question:

```
SABnzbd completed  ──encoder reads──▶  converted  ──Arr imports/moves──▶  library
```

1. Probe the **source** in the download directory (SABnzbd `storage`, Arr queue `outputPath`).
2. Probe the encoder's **output** in the converted directory, when a job result gives you its exact path.
3. Probe the **imported file** in the library (`episodeFile.path`, `movieFile.path`).

Read the result honestly:

- Track present in the source, absent afterwards ⇒ the conversion dropped it. Check the stream-selection record before calling that a bug: a drop with reason `language_not_requested` is the profile working as configured, and the fix is the profile, not another release. Either way, fetching the same release again cannot help.
- Track absent in the source ⇒ it was never there. The release name claimed it; the bytes did not. A replacement of the same release changes nothing, and only a genuinely different release could help.
- Track present everywhere ⇒ acquisition and conversion are both fine; the problem is playback selection, and belongs in Jellyfin or the client.

Probe one representative episode, not a whole season. If a stage's path is not available to you, say which stage could not be checked instead of assuming what it would have shown.

## Pitfalls

- Do not report probe results as if they came from the Arr, and do not report Arr `languages` as if a file had been inspected.
- Do not probe every episode of a season by reflex; the per-run probe limit exists and one representative file usually answers the question.
- A sample or an extra can be the largest file in an odd release directory; check `durationSeconds` before drawing conclusions from a directory probe.
- Absence of a probe (tool unavailable, path outside the media roots, file not found) is missing evidence. Report it as such — never fall back to release-name languages to justify a mutation.
