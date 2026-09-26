# Causal Trace

Every Breach carries a Causal Trace: a short account, written by the agent from
the replay log, of how the failure unfolded, citing specific ticks and
transactions. Its job is to explain *why* the invariant fired, so a reader does
not have to read hundreds of ticks of logs. It retells one seed; it is never a
verdict on the program.

## Inputs

- The replay log for the Breach's seed:

  ```bash
  riptide sim debug .riptide/sim --seed <hex>
  ```

  This reruns one seed with verbose labelled transaction logging. The same
  command is the Breach's replay command in the Assessment.
- The run's `guided-sim-run.json` (flow table, labelled transaction outcomes,
  retained failing seed, failure reason) and the review output for the run.
- The adapter and `.riptide/sim/src/invariants.rs`, for the invariant's
  declared name, observation and threshold.

These are agreed facts. The trace must not contradict them.

## Shape

Keep each trace to a few short parts:

1. **Frame** — one or two sentences: the invariant (by its exact declared
   name), the seed, the swept coordinate, and the one-sentence claim the trace
   lands ("bad debt appears at tick 10 because the oracle drop passed the
   liquidator's headroom").
2. **Mechanism** — one to three paragraphs, each opening with the mechanism
   name in bold ("**The liquidation cascade.**"). Each paragraph cites at
   least one tick, one transaction label or count, and one recorded metric,
   and wires them to the claim. When a metric is zero, say why.
3. **Timeline** — at most eight to twelve bullets, each starting `**T<n>**` or
   `**T<start>–T<end>**`, for the ticks that matter: the first occurrence of an
   action, a price or reserve crossing a round threshold, a failed-transaction
   cluster, the first invariant firing, and the first and last ticks. State
   action → outcome shapes ("5 `liquidate` succeed, 10 fail"), not raw events.
4. **Close** — one sentence restating the claim for this seed and coordinate,
   and one naming the next useful experiment (a narrower axis, another persona
   mix, a longer run).

## Evidence rules

1. **Every number must be traceable** to the replay log, the run artifacts or
   the adapter, or be an obvious computation from them ("5 whales × 720
   shortfall = 3 600 bad debt"). Drop any number you cannot cite.
2. **Name agents by persona label** when plural ("the five whales") and by
   persona label plus agent ID when singular ("whale agent-001").
3. **Invariant names come from the run.** Cite `no_bad_debt` as
   `no_bad_debt`, never as a paraphrase.
4. **No claims outside the run.** No mainnet or historical context the run
   does not stand on, and no "this proves the program is broken or safe". The
   trace describes one seed at one coordinate; the reader draws the verdict.
5. **Mechanism, not metrics.** Pair every number with a why. Do not restate
   the Engine Output's tables in prose.
6. **Flat register.** No "impressive", "comprehensive", "demonstrates",
   "showcases", and no rerun instructions beyond the replay command.

## Cold-read gate

Before writing a trace into the Assessment Context, reread it as if you had no
prior context for the run:

1. Do tick numbers appear in the mechanism paragraphs, not only the timeline?
2. Does it name the mechanism that produced the numbers, or only restate them?
3. Could a non-technical reader say in one sentence what happened?
4. Could the same text describe a different seed or program and stay
   coherent? If so, it is reading this file, not the run.
5. Is there any claim a reader could challenge with "how do you know"? Cite
   the tick or drop the claim.

Revise once if any answer is wrong. If the second draft still fails, record
the Breach with its replay command and mark its Causal Trace as not
synthesized, with the reason, rather than shipping a restatement of the
numbers.
