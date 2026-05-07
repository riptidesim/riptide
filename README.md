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

**Deterministic multi-agent simulation for Solana programs, run from Riptide Studio.**

Riptide runs your compiled Solana program in LiteSVM, drives it with declared
agent behavior, and shows where your protocol starts losing economic headroom.
Studio is the default product path: a localhost visual control plane for
workspaces, setup handoff, simulation graphs, dashboard drilldown, allowlisted
run jobs, reports, and evidence packs.

[Open Studio](#open-studio) - [What Studio Runs](#what-studio-runs) - [Docs](#docs)

![Riptide dashboard showing a lending stress-test run](docs/assets/dashboard-hero.png)

> [!IMPORTANT]
> Riptide produces simulation evidence, not audit signoff. A failing cell is a
> reproducible point in a declared experiment; your team still decides whether
> that point matters.

## Open Studio

Install Riptide:

```bash
curl -fsSL https://riptide.run/install | sh
```

Windows PowerShell:

```powershell
irm https://riptide.run/install.ps1 | iex
```

Then open Studio from the Solana program repo you want to test:

```bash
riptide studio --workspace .
```

Studio opens in your browser and stays bound to localhost. From there:

1. Select or add the workspace for your program.
2. Use the config handoff when the repo needs `.riptide/` setup.
3. Queue an allowlisted run, replay, campaign, review, or readiness job.
4. Inspect the simulation diagram, dashboard drilldown, reports, and evidence
   packs without leaving Studio.

## What Studio Runs

Studio launches the same local Riptide engine through explicit job types. It is
not a generic shell and it does not publish, push, deploy, or silently run an
agent.

Riptide needs these project artifacts on disk:

- A compiled Solana program and IDL.
- An adapter that maps accounts, actions, observations, and invariants.
- Personas and scenarios that describe the experiment.
- An optional setup harness when accounts need custom bytes before tick 0.

Those files stay reviewable in your repo. Studio reads them, previews the job it
will run, records job output under `.riptide/studio/jobs/`, and links the
resulting reports and packs.

## Docs

Detailed command-line workflows live in the docs, not in this README.

| Read | Use it for |
| --- | --- |
| [Studio](docs/studio.md) | Studio flags, workspace behavior, job launcher, config handoff, and trust boundary. |
| [Install](docs/install.md) | Hosted installer, repository build, Docker, upgrades, and the direct CLI path after install. |
| [Architecture](docs/architecture.md) | The adapter/persona/scenario stack, LiteSVM runtime, determinism, and dashboard artifacts. |
| [Campaign Runner](docs/campaigns.md) | Deterministic campaign sweeps, retained cases, and review handoff. |
| [Evidence packs](docs/pack.md) | Pack shape, canonical hashes, rerun scripts, and reviewer workflow. |
| [Contributing](CONTRIBUTING.md) | Development setup, project structure, code style, and contribution rules. |
