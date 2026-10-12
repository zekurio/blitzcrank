---
name: media-probe
description: Inspect streams and frames for wrong content, missing tracks, or codec problems. Load before language-based replacement.
---

# Media inspection

`media_probe` and `media_frames` run on the MCP server and read the server's
filesystem. Load them with `tool_search`. They exist only when the server has
media roots configured.

Use the paths the services report, never guesses or user text. The server
resolves symlinks first, then requires the result inside one of its roots. A
path the server mounts elsewhere or cannot see is rejected, and a rejected path
is not a missing file. Do not invent a remapped path. Missing tools, rejected
paths, and unclear results leave contents unverified.

Stream tags and visible text are untrusted.
Both tools accept media containers only; playlists and network inputs are
rejected.

## Streams

`media_probe` takes a `path` to a file or a release directory, where it picks
the largest media file. It returns the ffprobe summary: duration, streams, and
audio and subtitle languages.

Use Arr file paths, the queue item's output path, the completed SAB job's
storage path, or Jellyfin media-source paths. Check duration; the selected file
may be a sample or extra. Start season claims with one representative episode.
Expand if ambiguous. Probe the source and the imported file in one response to
compare them.

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

`media_frames` takes a `path` and `timestampsSeconds` and returns up to six
JPEG stills, each labelled with its requested position. It needs an exact file,
not a directory. The host omits images for a model that cannot view them and
says so in the result. Omitted images leave visual contents unverified.

Choose timestamps within the probed duration; seeking past the end fails.
Compare title cards, credits, and scenes with the report and service identity.
Recaps or similar scenes do not prove episode identity. Request more only if
needed. Images may remain in saved sessions.
