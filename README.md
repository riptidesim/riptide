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
workspaces, setup handoff, simulation graphs, allowlisted run jobs, reports,
and evidence packs. The CLI remains available for terminal and CI workflows.

[Open Studio](#open-studio) - [What Studio Offers](#what-studio-offers) - [Run From CLI](#run-from-cli) - [Docs](#docs)

<p align="center">
  <video src="docs/assets/studio-demo.mp4" poster="docs/assets/studio-demo-poster.png" autoplay loop muted playsinline controls width="100%">
    <img src="docs/assets/studio-demo-poster.png" alt="Riptide Studio touring the AMM workspace dashboard, campaigns, library, and reports" width="100%">
  </video>
</p>

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

Studio opens in your browser and stays bound to localhost. From there you can
select a workspace, prepare setup handoff, queue jobs, and inspect the artifacts
Riptide writes back to `.riptide/`.

## What Studio Offers

Studio is the fastest way to operate Riptide locally:

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

## Run From CLI

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
| [Contributing](CONTRIBUTING.md) | Development setup, project structure, code style, and contribution rules. |
