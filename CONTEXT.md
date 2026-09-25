# Riptide

Riptide is an agentic harness that produces a risk assessment for a Solana program. It does this by running deterministic, reproducible simulations against the program's real compiled binary. People use it by invoking a skill on their own codebase.

## Language

**Skill**:
The only way users reach Riptide. It is an agent-facing instruction bundle with exactly one user command, `/riptide-assess`, which users invoke on their own codebase. Setup, repair and narrative are stages inside it, not separate skills.
_Avoid_: plugin, front door, CLI (as a user surface)

**Engine**:
The deterministic simulation machinery (CLI and sim runtime). Only the Skill drives it, and the Skill provisions it on first use; users never install or touch it directly.
_Avoid_: tool, backend, riptide CLI (in user-facing language)

**Internal Artifact**:
A file the Skill writes so it can drive the Engine, such as run configuration, adapter or sim crate. The agent owns it, and the user is never asked to write or edit it.
_Avoid_: config, manual config, user config

**Workspace**:
The `.riptide/` directory inside the user's repo. It holds every Internal Artifact, and it can be committed so that anyone can rerun an Assessment. A later invocation of the Skill reuses the existing Workspace instead of starting over.
_Avoid_: scaffold, managed workspace, project dir

**Version Pin**:
The one exact Engine version that a given Skill release names. Every Assessment records both the Skill and Engine versions, and its rerun commands use that pin.
_Avoid_: engine range, latest

**Assessment**:
The report the Skill delivers: simulation evidence over a declared, fixed-seed region, together with the exact commands that reproduce it. It is not an audit signoff.
_Avoid_: audit, audit report, verdict

**Engine Output**:
The deterministic, byte-reproducible part of an Assessment, produced by the Engine for a given region and set of seeds.
_Avoid_: report, results

**Assessment Context**:
The part of an Assessment that the agent writes, kept separate from Engine Output: Scope Declaration, Coverage, Gaps, invariant provenance and Delta. It is checked for structure, not pinned byte-for-byte.
_Avoid_: metadata, annotations

**Scope Declaration**:
The section at the top of an Assessment that lists every assumption the Skill made in place of asking the user, and how to override each one. The Skill never blocks on user questions.
_Avoid_: scoped questions, clarifications

**Coverage**:
The instructions and actors of the target program that the simulation actually exercised. Every Assessment is graded by its Coverage.
_Avoid_: completeness, score

**Gap**:
A named part of the program that the simulation did not exercise, with the reason and what would unblock it. A Gap is never evidence of safety.
_Avoid_: skipped, unsupported, N/A

**Blocker Report**:
What the Skill delivers instead of an Assessment when Coverage is zero. It names each Gap and does not describe any risk surface.
_Avoid_: failed assessment, empty report

**Delta**:
The section of an Assessment that compares it with the previous Assessment in the same Workspace over the same declared region: metrics that moved, Gaps that opened or closed, and Coverage of new instructions.
_Avoid_: diff, regression report

**Floor Invariant**:
An invariant that the family library (or the generic Economic Protocol fallback) requires in every Assessment of that shape. Invariants the agent adds on top are labeled as agent-authored.
_Avoid_: default invariant, catalog invariant

**Sensitivity Check**:
Deliberately injecting a known violation to prove an invariant can fire. An invariant only counts as evidence that something "held" after it passes this check. Otherwise it is reported as a Gap.
_Avoid_: mutation test, invariant validation

**Breach**:
A Sensitivity-Checked invariant that failed during a run. A Breach always carries its seed replay command and a Causal Trace.
_Avoid_: bug, vulnerability, finding (use Breach for simulation evidence)

**Causal Trace**:
A short account of a Breach, written by the agent from the replay log and citing specific ticks and transactions.
_Avoid_: narrative report, write-up

**Economic Protocol**:
A program with a value-bearing economic mechanism (pooled assets, prices, solvency). Only Economic Protocols are in scope for the Skill. Protocols outside the known families are still in scope.
_Avoid_: DeFi program, supported family

**Out-of-Scope Note**:
The short output the Skill delivers, early, when the target is not an Economic Protocol. It points the user to code-level auditing tools instead.
_Avoid_: rejection, unsupported error

**Steering Hint**:
Optional free text the user passes when invoking the Skill, such as a program path or a focus area. It narrows scope up front. It is the only input channel the user has.
_Avoid_: flags, options, config

**Depth**:
How far a run goes. **Default** covers the critical instructions on one stress axis within a fixed budget. **Deep**, which the user requests through a Steering Hint, adds multiple and interacting axes and a larger budget. The Scope Declaration records which Depth ran.
_Avoid_: mode, quick scan, full audit
