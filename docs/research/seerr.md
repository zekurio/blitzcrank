# Seerr webhooks and API for an incident-handling bot

Research date: 2026-07-28. Verified against the current unified `seerr-team/seerr` source and `seerr-api.yml`, plus the archived `sct/overseerr` source. The former `fallenbagel/jellyseerr` GitHub URL now redirects to `seerr-team/seerr`.

## 1. Webhook notification setup

In the UI, go to **Settings → Notifications → Webhook** and configure:

1. **Enable Agent**.
2. **Webhook URL**: Seerr sends an HTTP `POST` to this URL, with the rendered JSON as the request body.
3. Select the notification types, including **Issue Reported**, **Issue Comment**, **Issue Resolved**, and **Issue Reopened** as needed.
4. Optional **Authorization Header**: the entered value is sent verbatim as the `Authorization` header. For example, entering `Bearer bot-secret` produces `Authorization: Bearer bot-secret`.
5. Current Seerr also supports arbitrary **Custom Headers**. It rejects using the dedicated Authorization field and a custom header named `Authorization` simultaneously.
6. Set the **JSON Payload** template, test it, and save.

Axios performs the POST with a JSON object, so the request uses JSON semantics (`Content-Type: application/json`). The webhook sender does not sign the body or define a built-in HMAC scheme. Use the authorization/custom-header fields and HTTPS if endpoint authentication is required.

### Template behavior important to bot implementers

- Ordinary replacements such as `{{issue_id}}` occur inside JSON string values. Consequently, the default payload emits IDs and statuses as **strings**, even when the source entity uses numeric IDs.
- The special variables `{{media}}`, `{{request}}`, `{{issue}}`, `{{comment}}`, and `{{extra}}` must be used as JSON **keys**. Seerr renames those keys to `media`, `request`, `issue`, `comment`, and `extra` and preserves the nested object/array.
- An absent special object becomes JSON `null`. `extra` becomes `[]` when absent.
- Missing ordinary variables become the empty string `""`.
- Replacement is recursive in objects/arrays, but the implementation uses a single string replacement per variable per string. Do not rely on multiple occurrences of the same variable in one string all being replaced.

### Current “Reset to Default” JSON payload

This is the current UI default from `src/components/Settings/Notifications/NotificationsWebhook/index.tsx`:

```json
{
  "notification_type": "{{notification_type}}",
  "event": "{{event}}",
  "subject": "{{subject}}",
  "message": "{{message}}",
  "image": "{{image}}",
  "{{media}}": {
    "media_type": "{{media_type}}",
    "imdbId": "{{media_imdbid}}",
    "tmdbId": "{{media_tmdbid}}",
    "tvdbId": "{{media_tvdbid}}",
    "jellyfinMediaId": "{{media_jellyfinMediaId}}",
    "status": "{{media_status}}",
    "status4k": "{{media_status4k}}"
  },
  "{{request}}": {
    "request_id": "{{request_id}}",
    "requestedBy_email": "{{requestedBy_email}}",
    "requestedBy_username": "{{requestedBy_username}}",
    "requestedBy_avatar": "{{requestedBy_avatar}}",
    "requestedBy_jellyfinUserId": "{{requestedBy_jellyfinUserId}}",
    "requestedBy_settings_discordIds": "{{requestedBy_settings_discordIds}}",
    "requestedBy_settings_telegramChatId": "{{requestedBy_settings_telegramChatId}}"
  },
  "{{issue}}": {
    "issue_id": "{{issue_id}}",
    "issue_type": "{{issue_type}}",
    "issue_status": "{{issue_status}}",
    "reportedBy_email": "{{reportedBy_email}}",
    "reportedBy_username": "{{reportedBy_username}}",
    "reportedBy_avatar": "{{reportedBy_avatar}}",
    "reportedBy_settings_discordIds": "{{reportedBy_settings_discordIds}}",
    "reportedBy_settings_telegramChatId": "{{reportedBy_settings_telegramChatId}}"
  },
  "{{comment}}": {
    "comment_message": "{{comment_message}}",
    "commentedBy_email": "{{commentedBy_email}}",
    "commentedBy_username": "{{commentedBy_username}}",
    "commentedBy_avatar": "{{commentedBy_avatar}}",
    "commentedBy_settings_discordIds": "{{commentedBy_settings_discordIds}}",
    "commentedBy_settings_telegramChatId": "{{commentedBy_settings_telegramChatId}}"
  },
  "{{extra}}": []
}
```

The source’s serialized fallback setting still contains an older payload lacking `imdbId`, `jellyfinMediaId`, and `requestedBy_jellyfinUserId`, and using singular `...discordId` names. The UI’s **Reset to Default** object above and the current webhook key map use the newer plural `...discordIds` variables. Existing upgraded installations may therefore retain an older custom/default template until it is reset or edited.

### All verified template variables

| Group | Variables |
|---|---|
| General | `{{notification_type}}`, `{{event}}`, `{{subject}}`, `{{message}}`, `{{image}}` |
| Special keys | `{{media}}`, `{{request}}`, `{{issue}}`, `{{comment}}`, `{{extra}}` |
| Notify user | `{{notifyuser_username}}`, `{{notifyuser_email}}`, `{{notifyuser_avatar}}`, `{{notifyuser_settings_discordIds}}`, `{{notifyuser_settings_telegramChatId}}` |
| Media | `{{media_type}}`, `{{media_imdbid}}`, `{{media_tmdbid}}`, `{{media_tvdbid}}`, `{{media_jellyfinMediaId}}`, `{{media_status}}`, `{{media_status4k}}`, `{{media_plexRatingKey}}`, `{{media_plexRatingKey4k}}` |
| Request | `{{request_id}}`, `{{requestedBy_jellyfinUserId}}`, `{{requestedBy_username}}`, `{{requestedBy_email}}`, `{{requestedBy_avatar}}`, `{{requestedBy_settings_discordIds}}`, `{{requestedBy_settings_telegramChatId}}` |
| Issue | `{{issue_id}}`, `{{issue_type}}`, `{{issue_status}}`, `{{reportedBy_username}}`, `{{reportedBy_email}}`, `{{reportedBy_avatar}}`, `{{reportedBy_settings_discordIds}}`, `{{reportedBy_settings_telegramChatId}}` |
| Comment | `{{comment_message}}`, `{{commentedBy_username}}`, `{{commentedBy_email}}`, `{{commentedBy_avatar}}`, `{{commentedBy_settings_discordIds}}`, `{{commentedBy_settings_telegramChatId}}` |

Verified rendered values:

- `notification_type`: enum name such as `ISSUE_CREATED`, `ISSUE_COMMENT`, `ISSUE_RESOLVED`, or `ISSUE_REOPENED`.
- `issue_type`: `VIDEO`, `AUDIO`, `SUBTITLES`, or `OTHER`.
- `issue_status`: `OPEN` or `RESOLVED`.
- `media_type`: `movie` or `tv`.
- `media_status` / `media_status4k`: enum name such as `UNKNOWN`, `PENDING`, `PROCESSING`, `PARTIALLY_AVAILABLE`, `AVAILABLE`, or `DELETED` (the webhook documentation omits `DELETED`, but the current enum/API includes it).
- Discord-ID variables originate as arrays but, in the default template, are substituted into quoted strings. Their exact resulting string serialization is not documented and should not be treated as a native JSON array unless the receiver verifies actual behavior. The special full entity objects are not exposed; the nested objects shown above are template-authored projections.

## 2. Concrete issue-event webhook payloads

The following describes the output of the current default template—not the full internal `Issue` entity.

### Common payload shape and types

```ts
type IssueWebhook = {
  notification_type:
    | "ISSUE_CREATED"
    | "ISSUE_COMMENT"
    | "ISSUE_RESOLVED"
    | "ISSUE_REOPENED";
  event: string;
  subject: string;             // title plus year when available
  message: string;             // first/original issue comment, not necessarily the new comment
  image: string;               // TMDB poster URL
  media: {
    media_type: "movie" | "tv";
    imdbId: string;            // empty when unavailable
    tmdbId: string;            // numeric source ID rendered as a string
    tvdbId: string;            // numeric source ID rendered as a string; may be empty
    jellyfinMediaId: string;   // may be empty
    status: string;            // availability enum name
    status4k: string;          // availability enum name
  };
  request: null;               // issue events do not supply a request entity
  issue: {
    issue_id: string;          // numeric source ID rendered as a string
    issue_type: "VIDEO" | "AUDIO" | "SUBTITLES" | "OTHER";
    issue_status: "OPEN" | "RESOLVED";
    reportedBy_email: string;
    reportedBy_username: string; // source is User.displayName, despite field name
    reportedBy_avatar: string;
    reportedBy_settings_discordIds: string;
    reportedBy_settings_telegramChatId: string;
  };
  comment: null | {
    comment_message: string;
    commentedBy_email: string;
    commentedBy_username: string; // source is User.displayName
    commentedBy_avatar: string;
    commentedBy_settings_discordIds: string;
    commentedBy_settings_telegramChatId: string;
  };
  extra: Array<{ name: string; value: string }>;
};
```

### Differences by event

| Event | `issue.issue_status` | `comment` | `extra` | `message` |
|---|---|---|---|---|
| `ISSUE_CREATED` | `OPEN` | `null` | For TV, affected season/episode entries when set | Original/first issue comment |
| `ISSUE_COMMENT` | Current issue status | New comment object | `[]` (the comment subscriber does not supply extras) | Original/first issue comment; use `comment.comment_message` for the new comment |
| `ISSUE_RESOLVED` | `RESOLVED` | `null` | Affected season/episode entries when set | Original/first issue comment |
| `ISSUE_REOPENED` | `OPEN` | `null` | Affected season/episode entries when set | Original/first issue comment |

For TV issues, the exact extra entries are:

```json
[
  { "name": "Affected Season", "value": "2" },
  { "name": "Affected Episode", "value": "5" }
]
```

`Affected Season` is emitted only when internal `problemSeason > 0`; `Affected Episode` is emitted only when the season is present and `problemEpisode > 0`. Movies get no affected-season/episode entries.

### Realistic `ISSUE_CREATED` example: VIDEO issue on a TV show

```json
{
  "notification_type": "ISSUE_CREATED",
  "event": "New Video Issue Reported",
  "subject": "Severance (2022)",
  "message": "Episode freezes at 18:42 and then loses audio.",
  "image": "https://image.tmdb.org/t/p/w600_and_h900_bestv2/lFf6LLrQjYldcZItzOkGmMMigP7.jpg",
  "media": {
    "media_type": "tv",
    "imdbId": "tt11280740",
    "tmdbId": "95396",
    "tvdbId": "371980",
    "jellyfinMediaId": "6f03c8a70d7b42e6930f4d6bdaec4f21",
    "status": "AVAILABLE",
    "status4k": "UNKNOWN"
  },
  "request": null,
  "issue": {
    "issue_id": "417",
    "issue_type": "VIDEO",
    "issue_status": "OPEN",
    "reportedBy_email": "alex@example.com",
    "reportedBy_username": "Alex",
    "reportedBy_avatar": "https://seerr.example.com/avatarproxy/1",
    "reportedBy_settings_discordIds": "",
    "reportedBy_settings_telegramChatId": ""
  },
  "comment": null,
  "extra": [
    { "name": "Affected Season", "value": "2" },
    { "name": "Affected Episode", "value": "5" }
  ]
}
```

The IDs/title/poster path in this example are illustrative; its field names and value types match the verified default rendering.

## 3. REST API essentials

### Base URL and authentication

All paths below are relative to:

```text
https://SEERR_HOST/api/v1
```

Authenticate with:

```http
X-Api-Key: YOUR_SEERR_API_KEY
```

The OpenAPI security scheme defines `X-Api-Key` as an API-key header. Cookie authentication is also defined, but an incident bot should normally use the API key. Permissions still apply; status changes require `MANAGE_ISSUES` or `ADMIN`.

### Get one issue

```http
GET /api/v1/issue/{issueId}
X-Api-Key: ...
```

`issueId` is specified as a number. `200` response: `Issue`.

```json
{
  "id": 417,
  "issueType": 1,
  "media": {
    "id": 92,
    "tmdbId": 95396,
    "tvdbId": 371980,
    "status": 5,
    "requests": [],
    "createdAt": "2026-07-28T12:00:00.000Z",
    "updatedAt": "2026-07-28T12:00:00.000Z"
  },
  "createdBy": {
    "id": 7,
    "email": "alex@example.com",
    "username": "Alex",
    "permissions": 0,
    "avatar": "/avatarproxy/1",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z"
  },
  "modifiedBy": null,
  "comments": [
    {
      "id": 901,
      "user": { "id": 7, "email": "alex@example.com", "createdAt": "...", "updatedAt": "..." },
      "message": "Episode freezes at 18:42 and then loses audio."
    }
  ]
}
```

OpenAPI caveat: the `Issue` schema documents only `id`, `issueType`, `media`, `createdBy`, `modifiedBy`, and `comments`. Runtime entities also have `status`, `problemSeason`, `problemEpisode`, `createdAt`, and `updatedAt`, but those fields are **not declared in the current OpenAPI `Issue` schema**. Treat their presence in API responses as implementation behavior rather than a spec guarantee.

Numeric issue enums from source:

- `issueType`: `1=VIDEO`, `2=AUDIO`, `3=SUBTITLES`, `4=OTHER`
- runtime `status`: `1=OPEN`, `2=RESOLVED` (not declared in the OpenAPI `Issue` schema)

### List issues

```http
GET /api/v1/issue?take=20&skip=0&sort=added&filter=open&requestedBy=7
X-Api-Key: ...
```

Query parameters:

- `take`: number, nullable
- `skip`: number, nullable
- `sort`: `added` or `modified`; default `added`
- `filter`: `all`, `open`, or `resolved`; default `open`
- `requestedBy`: number, nullable

Minimal `200` response:

```json
{
  "pageInfo": {
    "page": 1,
    "pages": 3,
    "results": 42
  },
  "results": [
    {
      "id": 417,
      "issueType": 1,
      "media": { "id": 92, "tmdbId": 95396, "tvdbId": 371980, "status": 5 },
      "createdBy": { "id": 7, "email": "alex@example.com", "createdAt": "...", "updatedAt": "..." },
      "comments": []
    }
  ]
}
```

### Post a comment

```http
POST /api/v1/issue/{issueId}/comment
X-Api-Key: ...
Content-Type: application/json

{"message":"Acknowledged. Checking the Sonarr/Jellyfin files now."}
```

`message` is a required string. The `200` response is the associated `Issue`, including its comments array.

### Resolve or reopen an issue

```http
POST /api/v1/issue/{issueId}/resolved
X-Api-Key: ...
```

```http
POST /api/v1/issue/{issueId}/open
X-Api-Key: ...
```

The path template is `POST /issue/{issueId}/{status}` where `status` is exactly `open` or `resolved`. There is no request body. `issueId` is typed as a string in this operation. The `200` response is the updated `Issue`.

The OpenAPI description incorrectly says this endpoint updates an issue to “approved or declined”; the actual enum and route behavior are `open` / `resolved`.

### Get media/title details

There is **no `GET /media/{mediaId}` operation** in the current OpenAPI spec; `/media/{mediaId}` only defines `DELETE`. For display metadata, use the webhook/API media object’s **TMDB ID** and media type:

```http
GET /api/v1/movie/{movieId}?language=en
GET /api/v1/tv/{tvId}?language=en
X-Api-Key: ...
```

Here `movieId` / `tvId` means the TMDB ID, not Seerr’s internal `media.id`. Responses are `MovieDetails` or `TvDetails`; minimally useful fields include the TMDB `id`, title/name, overview, poster/backdrop paths, external IDs, and the attached Seerr `mediaInfo` when present. Exact full response schemas are large; consumers should generate/use the checked-in OpenAPI definitions `MovieDetails` and `TvDetails`.

For an affected TV episode:

```http
GET /api/v1/tv/{tvId}/season/{seasonNumber}?language=en
```

The response is a `Season` object with its episode list. This can enrich `Affected Season` / `Affected Episode` webhook extras.

`GET /api/v1/media` can list Seerr database media records but is not a direct single-record detail lookup. It accepts pagination/filter/sort and returns `{pageInfo, results: MediaInfo[]}`.

## 4. Overseerr vs. Jellyseerr/Seerr differences that matter

- **Project status:** Overseerr is archived. Jellyseerr and Overseerr have been unified as **Seerr**; the old Jellyseerr repository URL redirects to `seerr-team/seerr`.
- **API compatibility:** The issue endpoints and `/api/v1` + `X-Api-Key` model are materially the same in the archived Overseerr and current Seerr specs. A bot can generally share one client.
- **Media-server fields:** Current Seerr/Jellyseerr adds Jellyfin-oriented variables such as `{{media_jellyfinMediaId}}` and `{{requestedBy_jellyfinUserId}}`. Archived Overseerr’s default template does not contain those fields.
- **External IDs:** Current Seerr’s UI default includes `imdbId`; archived Overseerr’s default media projection includes only TMDB/TVDB IDs and availability statuses.
- **Discord settings:** Archived Overseerr uses singular template names such as `{{reportedBy_settings_discordId}}`; current Seerr uses plural `{{reportedBy_settings_discordIds}}`, sourced from an array. Do not assume both names work on every version.
- **Headers and URL variables:** Current Seerr supports arbitrary custom headers and optional template variables in the webhook URL. Archived Overseerr exposes only the dedicated Authorization header and a fixed URL.
- **Default-template drift:** Existing installs preserve their configured JSON template. Upgrading does not guarantee that newly added fields appear; instruct operators to compare/reset the webhook template explicitly.
- **Payload is configurable:** There is no universal wire schema if the operator edits the JSON template. An incident bot should validate `notification_type`, tolerate absent/null optional sections, and preferably require deployment of a known template under configuration management.

## Verified source locations

- Current webhook documentation: `seerr-team/seerr/docs/using-seerr/notifications/webhook.md`
- Current default template/UI: `seerr-team/seerr/src/components/Settings/Notifications/NotificationsWebhook/index.tsx`
- Template key mapping and POST behavior: `seerr-team/seerr/server/lib/notifications/agents/webhook.ts`
- Issue event construction/extras: `server/subscriber/IssueSubscriber.ts` and `IssueCommentSubscriber.ts`
- Issue enums/entities: `server/constants/issue.ts`, `server/entity/Issue.ts`
- API contract: repository-root `seerr-api.yml`
- Legacy comparison: archived `sct/overseerr`, especially `docs/using-overseerr/notifications/webhooks.md`, webhook UI/agent source, and `overseerr-api.yml`
