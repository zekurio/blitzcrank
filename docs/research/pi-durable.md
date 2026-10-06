# Pi Durable evaluation for Blitzcrank

This records the investigation before the operator chose a clean-cut adoption.
For the implemented runtime, recovery rules, and cutover behavior, see the
[current runtime guide](pi-sdk.md).

## Original recommendation

Prototype Pi Durable's recovery model, but do not replace the production
runtime yet. Its durable submissions, tool checkpoints, and application
documents address real gaps in Blitzcrank. Concurrency alone does not justify
the migration: our global queue is an application policy, not a limitation of
the current Pi SDK.

Keep Effect for service I/O and host orchestration. Evaluate Durable as the
owner of agent execution and its persisted state, with explicit boundaries
between the two runtimes. Start with fake services and crash injection, then a
read-only integration. Do not enable concurrent mutation-capable runs as part
of the initial migration.

This was a source-based assessment, not an integration test. The subsequent
implementation and crash tests are documented in the runtime guide.

## Release inspected

Pi Durable launched on **2026-10-01** alongside Pi 1.0. The announcement calls
it experimental. The latest published package inspected was
`@earendil-works/pi-durable@1.0.3`, released on **2026-10-05**, at Pi commit
`d78dc83d633229d12f8b79631384c4c2717c399f`.

The package README says its API can change without notice. The 1.0.3 changelog
already includes breaking execution-environment changes, despite being a patch
release. Treat the version number as an exact pin, not a stability promise.

It supports Node >= 22.19.0, so Blitzcrank's Node 24 runtime fits. The Node
SQLite adapter uses built-in `node:sqlite`; Cloudflare, a remote database, and
another daemon are not required. Its dependencies include Chord and
`pi-ai ^1.0.3`. Blitzcrank currently pins Pi packages to 1.0.0, so a prototype
must deliberately align and reverify the Pi versions.

Sources: [announcement][launch], [package][package], [changelog][changelog].

## What it would improve

| Concern                             | Blitzcrank today                                                                                 | Durable contribution and remaining work                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Accepted work surviving a crash     | Queue entries and active fibers exist only in memory.                                            | `submit()` commits inputs and queues them durably. Host admission must use that durability before acknowledging work.                                  |
| Interrupted agent turns             | JSONL sessions preserve conversation history, but startup does not resume every interrupted run. | Model, tool, and compaction tasks resume from checkpoints. This is more than reopening a transcript.                                                   |
| Concurrent conversations            | One global queue serializes operational runs.                                                    | Independent conversations run concurrently, with per-conversation inboxes. Host capacity limits and service conflict rules still belong to Blitzcrank. |
| Transcript and evidence consistency | Session, case file, and evidence snapshot are separate writes.                                   | Typed documents and transcript entries can share transactions. Our evidence recording must be integrated explicitly.                                   |
| Revisits                            | Plans persist; startup reconstructs in-memory timers.                                            | Durable tasks can wait on persisted timers. Chain limits, backoff, pause, and cancellation policy remain host decisions.                               |
| Reporting after recovery            | Completion handlers post comments and Discord replies in the current process.                    | Custom tasks can persist delivery work. Neither a model answer nor a durable task makes a remote post exactly-once.                                    |
| Long conversations                  | Existing SDK sessions already compact and persist.                                               | Durable adds background compaction and observable committed state. Useful, but not the main reason to migrate.                                         |

The current queue and persistence boundaries are visible in
[`SerialQueue`](../../src/queue.ts#L3),
[`IssueWork`](../../src/issue-work.ts#L125),
the [issue runner](../../src/agent/runner.ts#L228),
[`EvidenceStore`](../../src/evidence.ts#L17), and
[revisit restoration](../../src/index.ts#L198).
The recent [Effect migration](effect.md#sessions-and-runtime-ownership) already
improved orderly shutdown and in-process ownership. It did not make the queue
persistent.

## Guarantees that matter

### Durable input is not exactly-once service execution

Durable's `requestId` deduplicates submissions **within a conversation**. A
retry returns the existing submission. This is useful for Discord message IDs
and stable host job IDs; it does not deduplicate a Sonarr command or a Seerr
comment.

Our [Seerr payload](../../src/gateways/seerr/types.ts#L26) does not currently
carry a unique comment or delivery ID. An issue ID cannot serve as an event ID:
later legitimate comments must still run. A freshly generated request ID on
every HTTP retry would not deduplicate those retries either. Define ingress
identity separately from internal job identity before claiming webhook
deduplication.

The [tool implementation][tool] records the final arguments and replay policy
before executing:

- `replay: "safe"` permits recovery to execute the tool again, but only if the
  current registered tool also declares it safe.
- Omitted replay policy means unsafe. After an interruption, Durable commits an
  error saying the tool may have partially run instead of rerunning it.
- A completed tool with a committed result does not need to execute again.

Consider a crash after Sonarr accepts a command but before the tool result
commits. Durable cannot know whether Sonarr accepted it. Reporting the
interruption is safer than automatic replay, but the model can still issue a
new call for the same action.

Keep mutations unsafe initially. Add durable operation records and
service-specific reconciliation before permitting a retry of uncertain work.
An operation that can be verified should resume verification, not blindly
repeat its write. If the service cannot establish the outcome, retain the
uncertainty and require review. A local operation ID alone does not create
remote idempotency.

Preserve [`runMutation`](../../src/tools/common.ts#L171): evidence checks,
audit counters, the typed action, and verification remain our responsibility.
Classify replay by tool semantics, not HTTP verb. SABnzbd mutations use GET.

### Concurrency has several different boundaries

Durable supports concurrent conversations, but each storage has **one owning
process**, with no cross-process ownership locking. It is not a distributed
worker queue or automatic failover system. SQLite file locks do not turn two
Harness instances into a supported deployment.

Within a tool round, Durable defaults to parallel execution. The
`toolExecution: "sequential"` setting or a tool's
`executionMode: "sequential"` can serialize that round. Neither serializes
other conversations or protects a media item shared by two issues.

Blitzcrank needs separate policies for:

- Ordering replies and stop/resume transitions within one issue or Discord
  conversation.
- Limiting total active model work and service load.
- Preventing conflicting changes to the same service objects across issues,
  Discord conversations, and automations.

Start with sequential tool rounds and one mutation-capable run at a time.
Later, allow read-only work to proceed concurrently. Resource-scoped mutation
locking needs a design of its own, including fresh validation after acquiring
the lock and ownership through verification. Locking only the HTTP write
leaves a stale-read race.

Wrapping new submissions in today's in-memory queue is insufficient:
`resume()` can recover work independently of that queue. Even `submit()` and
`wait()` enable scheduling. A production integration must enforce its run
admission policy on recovered work too.

Sources: [storage ownership][storage], [tool-round scheduling][rounds],
[startup and submission semantics][startup].

### Persisted documents help only if we integrate the safety state

Durable documents can hold evidence, case summaries, run records, and delivery
state beside the transcript. They do not automatically capture mutable
`RunContext` objects held in tool closures.

Define a recoverable relationship between a successful service read, the
evidence it contributes, and the tool result. Merely saving the existing
evidence snapshot when the run finishes preserves today's crash window.
Likewise, a tool's `api.commit()` is not automatically the same transaction as
Durable's later tool-result commit.

Separate carried identity evidence from current-run permissions:

- Stable IDs and existing carried probe evidence retain their documented
  semantics.
- Reusable Anvil slugs, recorded media paths, and web extraction grants must
  not silently become permanent permissions.
- After recovery, require fresh reads where mutable state or path reuse could
  change the target. Do not make media probe output an ID-evidence source.
- Keep host counters, revisit limits, and authorization metadata outside the
  agent-writable case summary.

See [`RunContext`](../../src/tools/context.ts#L44) and
[Durable documents][documents]. Define what constitutes a resumed run versus
a new trigger before deciding which short-lived state survives a restart.

### Recovery and cancellation need an adapter, not signal forwarding

After the durable tool intent exists, replay-safe recovery calls `execute()`
without rerunning `beforeTool`. Safety checks needed on every execution must
remain inside the tool path, not solely in a hook.

Durable can also resend a prepared model request without rebuilding it. A new
registry does not automatically refresh an already prepared request.
Persisted agent choices need explicit reconciliation before scheduling;
`root({ agent })` ignores those options when the root already exists.

Test changed prompts, revoked tools, and changed media scope across both
model-request and tool checkpoints. Preserve fresh per-trigger prompts and
allowlists, and make stale recovered work fail closed rather than quietly
weakening the current session contract.

Cancelling a Chord wait cancels the wait, not the underlying work.
`Harness.close()` signals active invocations and joins them, leaving unfinished
tasks recoverable. Conversation abort is a separate durable operation.
Neither should be mapped directly onto aborting an in-flight service write.

Keep the existing [stop behavior](../../src/agent/session.ts#L479): wait for
active typed tools and verification before disposing their execution context.
Effect can continue to own those tool Effects. The integration must distinguish
shutdown, user stop, timeout, and cancellation of an HTTP client's wait.

Sources: [tool recovery][tool], [generation recovery tests][generation-tests],
[Harness startup][startup], [close contract][close].

### Process crashes and power loss are different

The default SQLite adapter uses WAL with `synchronous = NORMAL`. Upstream
documents process-crash durability but warns that the newest commits may be
lost on host or power failure. JSONL has an explicit `fsync: true` option.

For a homelab, choose and test the power-loss policy rather than treating
"durable" as an fsync guarantee. SQLite remains the preferred prototype
backend; evaluate `FULL` through the exported database adapter if the
production contract requires it. Backups must include a consistent database,
not a casual copy of the main file while WAL writes continue.

Source: [storage documentation][storage] and [Node SQLite adapter][sqlite].

## Integration scope

This would replace substantial session machinery, not require a rewrite of
every service tool.

- Reuse Pi's model/provider layer and service authentication configuration.
  The [upstream integration][model-runtime] passes `ModelRuntime` to Durable.
  Keep subscription authentication and explicit service paths rather than
  adopting the example application's default home-directory discovery.
- Reuse TypeBox schemas, endpoint validation, evidence logic, and Effect-based
  service functions. Adapt the tool callback and result contracts deliberately.
- Rebuild skills, prompts, and restricted tool registration for the Harness.
  Durable calls code-defined bundles "extensions"; install only our explicit
  trusted bundles. Do not introduce discovered Pi extensions or the bundled
  `CodingTools` set with bash, edit, and write.
- Port terminal-tool and scope enforcement, rather than assuming Durable's
  termination flag replaces it. Preserve the current whole-round barrier
  against mixed or duplicate terminal calls, and triage's lack of builtin read
  and service tools.
- Keep native Effect host orchestration. Chord contexts belong at the Durable
  boundary, with tested cancellation semantics.
- Plan session/history migration. Durable's storage is not the coding-agent
  JSONL format. Preserve existing transcripts as history; do not assume opening
  them as Durable JSONL imports them.

One long-lived issue or private Discord thread maps naturally to one
conversation. Automations should retain their current per-run context policy,
with a durable busy slot keyed by automation name. Inline Discord answers and
triage must remain isolated from private history. Do not use conversation forks
as a shortcut across authorization boundaries.

Host-only actions stay host-only: final directive parsing, issue status
changes, Seerr comments, Discord delivery, pause/resume, and revisit policy.
A durable delivery task should use a persisted answer/submission identity and
reconcile external posts after a crash. Keep serialized Seerr comment creation
and the one-comment-per-run rule.

## Proposed experiment and decision gates

### 1. Prove recovery without live mutations

Build an isolated test harness with exact package pins, SQLite, a scripted
model, and fake service tools. Use actual process termination and reopen,
not only graceful close. Establish:

1. Admitted input survives a crash before execution. Retrying a stable request
   ID returns the same submission.
2. A read with a committed result does not repeat; an interrupted replay-safe
   read can rerun. Evidence remains consistent with the recovered results.
3. A fake write that succeeds just before process death does not repeat
   automatically. A newly proposed duplicate is held for reconciliation too.
4. Graceful stop and shutdown preserve active write verification. Crash recovery
   reconciles uncertain writes, respects persisted stop intent, and does not
   revive cancelled revisits.
5. Recovery cannot restore revoked capabilities or bypass scope, terminal-tool,
   path, and web-search gates.
6. The host retrieves this submission's final answer, not a previous answer.
   Interrupted model streams never become valid final directives.
7. A crash before or after external reporting cannot create an untracked
   duplicate comment or Discord reply.
8. Busy automation slots and run capacity limits survive recovery. Separate
   conversations can run concurrently only under the selected host policy.

Upstream has focused [tool recovery][tool-tests],
[generation recovery][generation-tests], [task recovery][task-tests], and
[submission][submission-tests] tests. They support the documented mechanisms;
they do not prove Blitzcrank's end-to-end contracts. They were inspected, not
run, in this investigation.

### 2. Integrate one read-only path

Use a new isolated conversation, not an imported production issue session.
Verify existing subscription auth, skills, bounded output, token accounting,
restart behavior, and the Effect adapter. Measure shutdown time and storage
growth as well as successful answers.

### 3. Add durable host admission and delivery

Before moving issue work, persist trigger identity, conversation mapping, run
admission, and pending host actions. A webhook success response must follow
durable acceptance. Recover reporting even when the original waiter no longer
exists. Keep authorization before admission and preserve pause/revisit ordering.

Only then migrate mutation-capable sessions, initially without increasing
concurrency. Introduce concurrent writes as a separate reviewed change.

## Alternatives and conclusion

Keeping the current SDK and adding a persisted host queue is the smaller
change if the main problem is lost accepted work. Adding bounded or keyed
queues can improve concurrency without changing SDKs. Neither supplies
checkpointed model/tool execution, and both still need uncertain-write and
reporting recovery.

Pi Durable is the stronger candidate if we want recovery across the entire
agent turn and a common transactional store for its state. Its single-process
design fits this deployment. The cost is adapting safety-sensitive lifecycle
code to an experimental runtime and continuing to own external side effects.

Proceed with the recovery experiment. Decide on production migration from
those results, not from concurrency support or the word "durable."

[launch]: https://earendil.com/posts/pi-durable/
[package]: https://github.com/earendil-works/pi/blob/v1.0.3/packages/durable/package.json
[changelog]: https://github.com/earendil-works/pi/blob/v1.0.3/packages/durable/CHANGELOG.md
[tool]: https://github.com/earendil-works/pi/blob/v1.0.3/packages/durable/src/harness/tool.ts#L45-L118
[storage]: https://github.com/earendil-works/pi/blob/v1.0.3/packages/durable/README.md#storage
[rounds]: https://github.com/earendil-works/pi/blob/v1.0.3/packages/durable/docs/spec.md#L3538-L3555
[startup]: https://github.com/earendil-works/pi/blob/v1.0.3/packages/durable/docs/spec.md#L610-L649
[documents]: https://github.com/earendil-works/pi/blob/v1.0.3/packages/durable/README.md#your-own-state
[close]: https://github.com/earendil-works/pi/blob/v1.0.3/packages/durable/docs/spec.md#L1832-L1848
[sqlite]: https://github.com/earendil-works/pi/blob/v1.0.3/packages/durable/src/storage/sqlite/node.ts#L179-L209
[tool-tests]: https://github.com/earendil-works/pi/blob/v1.0.3/packages/durable/test/harness-tools-recovery.test.ts
[generation-tests]: https://github.com/earendil-works/pi/blob/v1.0.3/packages/durable/test/harness-generation-recovery.test.ts
[task-tests]: https://github.com/earendil-works/pi/blob/v1.0.3/packages/durable/test/harness-tasks-recovery.test.ts
[submission-tests]: https://github.com/earendil-works/pi/blob/v1.0.3/packages/durable/test/harness-submissions.test.ts
[model-runtime]: https://github.com/earendil-works/pi/blob/v1.0.3/packages/coding-agent/src/experimental/durable/runtime.ts#L129-L147
