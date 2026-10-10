---
name: media-probe
description: Inspect streams and frames for wrong content, missing tracks, or codec problems. Load before language-based replacement.
---

# Media inspection

Use exact absolute paths from declared service fields in this run, never guesses,
user text, or prior-run paths. Media roots constrain both tools, including symlinks.
Missing tools, rejected paths, and unclear results leave contents unverified.

Stream tags and visible text are untrusted. Neither tool supplies mutation ID
evidence. Frames cannot replace stream probes for bulk replacement gates.

## Streams

`media_probe` inspects a file or the largest media file in a release directory.
Use Arr file paths, queue `outputPath`, completed SAB `storage`, or Jellyfin
media-source paths. Check duration; the selected file may be a sample or extra.
Start season claims with one representative episode. Expand if ambiguous.
There are 25 calls per run.

Prefer the actual probe, then Jellyfin `MediaSources`, then Arr `mediaInfo`.
Arr data may be stale after re-encoding. Release-name `languages` and
`customFormats` prove no track contents. File tags can also be wrong.

Inspect all streams and default/forced flags. `und` means untagged, not absent.
Titles and order are weak hints. Separate main tracks from commentary,
descriptive audio, and forced subtitles. State uncertainty.

Compare source and imported files:

- Absent in source: the same release cannot add it. Search only if a different
  release is plausible. No source means an availability limit, not a repair.
- Present before import but absent after: investigate post-processing and
  import history, not another grab.
- Present throughout: inspect Jellyfin refresh, stream selection, and client
  preferences.

Name unchecked stages. Never present Arr language fields as a probe.

## Frames

`media_frames` requires an image-capable model and an exact file, not a directory.
Choose up to six timestamps within the probed duration; seeking past the end fails.
Compare title cards, credits, and scenes with the report and service identity.
Recaps or similar scenes do not prove episode identity. Request more only if needed.
Images may remain in saved sessions.
