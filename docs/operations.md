# Logs and journals

## Logs

Both processes write JSON records to stdout and stderr. On NixOS, journald
captures them.

```sh
sudo journalctl -u blitzcrank -u blitzcrank-mcp --since today -o cat
```

Filter on `runId` to follow one run across both processes:

```sh
sudo journalctl -u blitzcrank -u blitzcrank-mcp -o cat |
  jq -R 'fromjson? | select(.runId == "RUN_ID")'
```

`run.admitted` maps a run ID to its `thread`, such as `fluxer:1234567890`.

The host logs job admission and recovery, queue time, run duration, model
requests with token, cache, and reasoning counts, tool starts and outcomes,
and reply publication. The server logs a start and a completion record per
tool call. [The server README](../packages/mcp/README.md#process) describes
its records.

### Reading the records

| Record                                  | Meaning                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `tool.completed` with `status: "error"` | A tool error the model saw and can work around                                              |
| MCP `unknown` outcome                   | A write went out and no answer came back. The run stops for review.                         |
| `review_required` rejection             | The host stopped a write for review                                                         |
| `review.decided`, `review.judged`       | A [write review](write-review.md) decision, and its model request                           |
| `model.completed`                       | One provider attempt, failures included                                                     |
| `run.answer`                            | The reply. Its `threadInputTokens` and `threadOutputTokens` are thread totals, not per run. |
| `action.replayed`                       | Recovery replayed a completed action instead of publishing again                            |

Token counts in the logs are for diagnosis. The usage ledger in the session
journal is the record of what a thread used.

Logs leave out arguments, result bodies, prompts, replies, user identities,
and any error message that might hold private data. For those, go to the
journals.

## Journals

The host keeps SQLite journals under `BLITZCRANK_DATA_DIR`, which is
`/var/lib/blitzcrank` on NixOS.

| File                                 | Holds                                                        |
| ------------------------------------ | ------------------------------------------------------------ |
| `jobs.sqlite`                        | Admission, status, publication intents and results, failures |
| `sessions/<gateway>/<thread>.sqlite` | The Durable transcript, tool outcomes, and usage ledger      |

Use the run ID to find the job and its Durable submission. There is no second
transcript and no memory the model can write to.

These files hold private chat content. Treat backups accordingly.
[Deploy](deploy.md#state) covers how to back them up safely.

## Health checks

Both processes answer an unauthenticated `GET /healthz`. The host's answer
includes how many runs are queued. It's the host's only HTTP endpoint, on
`BLITZCRANK_PORT`, 8484 by default. The host opens its own connection to
Fluxer and takes no other inbound traffic. The server answers on its MCP
port.
