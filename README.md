# Riptide

<p align="center">
  <img src="docs/assets/riptide-logo.svg" alt="Riptide" width="100%">
</p>

<p align="center">
  <a href="TOOLCHAIN.md"><img src="https://img.shields.io/badge/Rust-1.91.1-orange?style=flat-square&amp;logo=rust" alt="Rust"></a>
  <a href="cli/package.json"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-3c873a?style=flat-square&amp;logo=node.js&amp;logoColor=white" alt="Node.js"></a>
  <a href="TOOLCHAIN.md"><img src="https://img.shields.io/badge/Solana%20SBF-3.0.13-14f195?style=flat-square" alt="Solana SBF"></a>
  <a href="docs/architecture.md"><img src="https://img.shields.io/badge/runtime-LiteSVM-4f8cff?style=flat-square" alt="LiteSVM"></a>
</p>

**Deterministic multi-agent simulation for Solana programs, led by one assessment skill.**

Riptide runs your compiled Solana program in LiteSVM, drives it with declared
agent behavior, and shows where your protocol starts losing economic headroom.
For a first assessment, open your Solana program repo in an agent and invoke
[`riptide-assess`](skills/riptide-assess/SKILL.md). The skill detects the
protocol family, asks up to three scoping questions, uses the existing Riptide
commands to run the campaign, and returns `assessment.md`, `assessment.json`,
the evidence-pack path, and the exact rerun commands.

[Assess With The Skill](#assess-with-the-skill) - [Advanced / Power Users](#advanced--power-users) - [Trust & Review](docs/trust.md) - [Docs](#docs)

<div align="center">
  <video src="https://github.com/user-attachments/assets/7f3475d2-5459-4abc-983a-72d6af0f5f05" width="720" controls></video>
</div>

> [!IMPORTANT]
> Riptide produces simulation evidence, not audit signoff. A failing cell is a
> reproducible point in a declared experiment; your team still decides whether
> that point matters.

## Assess With The Skill

Install Riptide:

```bash
curl -fsSL https://riptide.run/install | sh
```

Windows PowerShell:

```powershell
irm https://riptide.run/install.ps1 | iex
```

Then open the Solana program repo you want to assess in your agent and ask it
to use the front-door skill:

```text
Use riptide-assess on this repo.
```

The agent should do the practitioner work: inspect source, IDL, tests, and any
existing `.riptide/` files; ask only the missing scoping questions; run the
validated Riptide commands; and hand back the report plus the rerun command.
The generated report is simulation evidence over declared inputs, not audit
signoff or complete protocol safety.

## Advanced / Power Users

Use Studio or the CLI directly when you want manual control, a terminal
workflow, CI integration, or a scriptable path after the assessment flow has
shown you the shape of the evidence.

### Studio

Open Studio from the Solana program repo you want to inspect:

```bash
riptide studio --workspace .
```

Studio opens in your browser and stays bound to localhost:

- **Workspace overview** for the active repo, recent runs, reports, queued jobs,
  and next actions.
- **Config handoff** for repos that still need `.riptide/` setup. Studio
  creates a structured handoff prompt; it does not silently edit files or run an
  agent.
- **Launch jobs** for allowlisted Riptide actions such as run, replay,
  campaign, review, and readiness. Studio previews the exact job before it
  starts.
- **Evidence library** for runs, campaigns, packs, retained cases, guided-sim
  artifacts, readiness reports, scenarios, and adapters.
- **Simulation diagram** showing how adapter, semantics, personas, scenarios,
  campaigns, invariants, engine runs, reports, and packs connect.
- **Dashboard drilldown** for opening the run/replay dashboard against a scoped
  artifact.

Studio is not a generic shell, does not push or publish, and stays on the local
machine. See [Studio](docs/studio.md) for flags, job kinds, persistence, and
the trust boundary.

### CLI Verbs

Use the CLI when you want a terminal workflow, CI integration, or a scriptable
path. After Riptide is installed and your repo has `.riptide/` configuration,
the short path is:

```bash
riptide run --serve
riptide campaign run .riptide/campaigns/<risk>.campaign.toml
riptide review <campaign-root>
```

For first-time repo setup, use [Install: First Run In Your Repo](docs/install.md#first-run-in-your-repo).
For the deeper command surface, read [Architecture](docs/architecture.md),
[Campaign Runner](docs/campaigns.md), and [Evidence packs](docs/pack.md).

## What Riptide Needs

Studio and the CLI launch the same local Riptide engine. Riptide needs these
project artifacts on disk:

- A compiled Solana program and IDL.
- An adapter that maps accounts, actions, observations, and invariants.
- Personas and scenarios that describe the experiment.
- An optional setup harness when accounts need custom bytes before tick 0.

Those files stay reviewable in your repo. Riptide reads them, runs declared
experiments, and writes reports, dashboards, and reviewer-ready packs back to
disk.

## Docs

Detailed command-line workflows live in the docs, not in this README.

| Read | Use it for |
| --- | --- |
| [Studio](docs/studio.md) | Studio capabilities, flags, workspace behavior, job launcher, config handoff, and trust boundary. |
| [Install](docs/install.md) | Hosted installer, repository build, Docker, upgrades, and first run in your repo. |
| [Architecture](docs/architecture.md) | The adapter/persona/scenario stack, LiteSVM runtime, determinism, and dashboard artifacts. |
| [Campaign Runner](docs/campaigns.md) | Deterministic campaign sweeps, retained cases, and review handoff. |
| [Evidence packs](docs/pack.md) | Pack shape, canonical hashes, rerun scripts, and reviewer workflow. |
| [Trust and review path](docs/trust.md) | Flagship proof rerun, CI handoff, case-study readiness, Studio, known limits, and reviewer ask. |
| [Audit handoff packet](docs/audit-handoff.md) | Launch/review checklist, reviewer packet template, and follow-up issue format. |
| [Submission package](docs/submission-package.md) | Demo script, shot list, and bounded submission copy for the shipped trust path. |
| [Contributing](CONTRIBUTING.md) | Development setup, project structure, code style, and contribution rules. |
