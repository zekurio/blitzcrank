# Write review

The agent applies the fix the evidence supports without asking first. What
it isn't allowed to do is decided by a second model, the gate model, set
with `BLITZCRANK_GATE_MODEL`. It works like Claude Code's auto mode. Before a
write that can remove or change media runs, the gate model reviews it.

## Which writes it reviews

Every server write is reviewed unless the server marks it
`destructiveHint: false`. These run without review:

- Sonarr and Radarr refreshes and rescans
- A Matinee library scan
- Retrying, pausing, resuming, or reprioritizing a SABnzbd job

Everything else is reviewed. That includes searches, because a search can
replace files, and Matinee title refreshes, match fixes, request retries, and
new requests. The [server README](../packages/mcp/README.md#writes) explains
how each write is classified.

The server refuses to grab a release it never listed, whatever the review
decides.

## What it sees

For each review the gate model gets:

- the prompt the run is answering, plus the thread's earlier prompts and
  replies
- the writes it already decided earlier in the run, and how each came out
- for each pending write, its arguments, the agent's one-sentence `reason`,
  and the server's `write_preview` of what it would touch

It sees no other tool results and none of the agent's reasoning. Text the
agent read from a service, a file name or a release title for example, can't
argue with it directly.

Admin status comes from the gateway's check of the sender, never from
anything the model wrote.

## What it allows and holds

It decides all writes from one model response in one request.

It allows fixes on the reported media, such as replacing files that lack the
subtitles someone asked about. It holds:

- writes nobody asked for
- writes beyond what was reported. A season pack to fix a few episodes counts.
- removing media with no defect, unless the sender is an admin
- writes whose target it can't see, or that the conversation leaves ambiguous
- deleting a file that still plays before the grab of its replacement has
  succeeded. A grab in the same response doesn't count yet, and neither does
  one that failed.

## When it holds a write

A held write never runs and never reaches the journal, so it leaves nothing
uncertain behind. The agent gets the reason as an error result and says in
its reply what it didn't do.

After 3 held writes in a row, or 10 in one run, every further write in that
run is held.

A review that fails, times out, or comes back without a verdict holds the
write.

## Seeing decisions

`blitzcrank run` prints a `review` line for each decision with the tool,
whether it was allowed, and the rule it hit. The logs record the same as
`review.decided`, and each gate model request as `review.judged` with its
tokens and cost. That cost doesn't appear in the reply footer.
