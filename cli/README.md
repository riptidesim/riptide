# @riptide/cli

The Riptide Engine: deterministic guided simulation of a Solana program's
compiled binary.

This package is an agent API. The [`/riptide-assess`](https://github.com/riptidesim/riptide)
Skill resolves it at the exact version it pins and drives every command with
`--json`. It is not meant to be installed or run by hand: install the Skill
instead, as the [Riptide README](https://github.com/riptidesim/riptide#install-the-skill)
describes.

Contributors: the command contract lives in
[docs/architecture.md](https://github.com/riptidesim/riptide/blob/main/docs/architecture.md).

Licensed under MIT or Apache-2.0.
