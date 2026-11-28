# Run one message from a terminal

`blitzcrank run` answers one message with no chat platform involved. Use it
to debug a report or to drive a test harness. It reads one JSON object on
stdin and prints the run on stdout, one JSON object per line.

```sh
echo '{"thread":"t1","text":"Crystal Lake ist ab Episode 6 falsch"}' |
  BLITZCRANK_DATA_DIR=/tmp/blitzcrank-debug blitzcrank run
```

```jsonl
{"type":"run.started","runId":"36cef7c0-…","thread":"t1"}
{"type":"step","tool":"tool_search","write":false}
{"type":"step","tool":"sonarr_episodes","write":false}
{"type":"reply","text":"…"}
{"type":"usage","inputTokens":21400,"outputTokens":800,"costUsd":0.08}
{"type":"run.finished","runId":"36cef7c0-…","status":"completed"}
```

## Input

| Field    | Required | Meaning                                  |
| -------- | -------- | ---------------------------------------- |
| `thread` | yes      | 1 to 64 letters, digits, `_`, or `-`     |
| `text`   | yes      | The message                              |
| `admin`  | no       | `true` makes this one message an admin's |

To continue a conversation, run the command again with the same `thread` and
data directory, once per message.

Without `"admin": true`, the message is a member's, and the agent leaves
removing or unmonitoring media that plays fine to an admin. The flag covers
only the message it comes with.

## Output

- `step` names each tool call as it starts and says whether the tool may
  write. It never shows arguments. The full trace is in
  `sessions/cli/<thread>.sqlite` under the data directory.
- `review` appears for each [write review](write-review.md) decision.
- `usage` totals every run of the thread so far, the same as the reply footer
  in a Fluxer thread. `costUsd` is null unless the provider bills per token.
- A run that ends without a message prints no `reply`.
- A failed run ends with `"status":"failed"` and its error, and the command
  exits 1. Bad input fails before `run.started`.

Host logs go to stderr, so stdout carries only the run.

## Environment

The command needs the host's environment: the three models, their
credentials, `BLITZCRANK_MCP_URL`, and `BLITZCRANK_MCP_TOKEN`. It reads no
`FLUXER_*` settings.

A run here goes through the same journal, runner, and tools as the service.
The agent's brief matches the Fluxer one minus the platform name, so it
behaves the way it would in a Fluxer thread. The command checks no sender,
since whoever runs it already holds every credential the run uses.

## Use a separate data directory

The journal admits one process at a time, so the command fails while the
service holds the directory. Give it a directory of its own.

If you kill a run partway, with Ctrl-C or a timeout, it stays unfinished in
the journal, because a write may have gone out with no answer. That thread
takes no more runs, and the service refuses to start on a directory holding
such a run.
