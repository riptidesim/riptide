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
commands to run the guided simulation, and returns `assessment.md`, `assessment.json`,
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

Use the CLI directly when you want manual control, a terminal workflow, CI
integration, or a scriptable path after the assessment flow has shown you the
shape of the evidence.

### CLI Verbs

After Riptide is installed and your repo has a configured `.riptide/sim/`
guided-sim crate, the guided-sim assessment flow is:

```bash
riptide sim generate --adapter .riptide/adapters/<program>.toml
riptide sim run .riptide/sim --flows 20 --out .riptide/sim/artifacts/run-001
riptide sim surface .riptide/sim/artifacts/run-001 --sim .riptide/sim
riptide assess .riptide/sim
riptide review .riptide/sim/artifacts/run-001
```

For first-time repo setup, use [Install: First Run In Your Repo](docs/install.md#first-run-in-your-repo).
For the deeper command surface, read [Architecture](docs/architecture.md) and
[Guided simulations](docs/guided-sim.md).

## What Riptide Needs

Riptide needs these project artifacts on disk:

- A compiled Solana program and IDL.
- An adapter that maps accounts, actions, observations, and invariants.
- A guided-sim crate (`.riptide/sim/`) with project-owned flows, invariants,
  and services that describe the experiment.

Those files stay reviewable in your repo. Riptide reads them, runs declared
guided simulations, and writes reviewer-ready evidence and assessment reports
back to disk.

## Docs

Detailed command-line workflows live in the docs, not in this README.

| Read | Use it for |
| --- | --- |
| [Install](docs/install.md) | Hosted installer, repository build, Docker, upgrades, and first run in your repo. |
| [Architecture](docs/architecture.md) | The adapter stack, the LiteSVM-backed guided-sim runtime, codegen, and determinism. |
| [Guided simulations](docs/guided-sim.md) | The `.riptide/sim/` crate, the run/surface/assess/review flow, and generated-file ownership. |
| [Trust and review path](docs/trust.md) | The guided-sim evidence path, known limits, and reviewer ask. |
| [Audit handoff packet](docs/audit-handoff.md) | Launch/review checklist, reviewer packet template, and follow-up issue format. |
| [Submission package](docs/submission-package.md) | Demo script and bounded submission copy for the shipped guided-sim path. |
| [Contributing](CONTRIBUTING.md) | Development setup, project structure, code style, and contribution rules. |
