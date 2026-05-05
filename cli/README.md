# @riptide/cli

Node.js command-line front end for [Riptide](../README.md).

The CLI handles the user-facing workflow around the Rust engine: project initialization, adapter linting, scenario discovery, replay orchestration, dashboard serving, and reviewer-pack validation.

## Install

The public npm package is not published yet. Use the monorepo installer for now:

```bash
git clone https://github.com/riptidesim/riptide
cd riptide
./install.sh
```

After publication, the intended package path is:

```bash
npm install -g @riptide/cli
riptide --help
```

For the npm package, the current postinstall binary map targets Linux
x86_64 first. macOS and Windows users should use the hosted release
installer, a source checkout, or the repo Dockerfile until npm binaries
are added for those platforms.

## Commands

| Command | Purpose |
| --- | --- |
| `riptide doctor` | Static environment and adapter health check. |
| `riptide init` | Create the thin `.riptide/` bootstrap in the current repo. |
| `/riptide-config` | Default skill-first setup after init: adapter, harness, scenarios, campaign, validation. |
| `riptide list` | List discovered scenarios. |
| `riptide run [pattern-or-path]` | Run all scenarios, a filtered set, or one JSON config. |
| `riptide replay <config>` | Replay a declared trajectory. |
| `riptide lint <adapter>` | Validate a JSON-IDL-backed adapter. |
| `riptide lineage <adapter>` | Print adapter provenance and assumptions. |
| `riptide review <pack>` | Validate an evidence pack without running the engine. |

Most users should start from the root [README](../README.md) and [Install guide](../docs/install.md).
