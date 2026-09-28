---
name: Bug report
about: Report something Riptide does that it shouldn't
title: "[bug] "
labels: bug
---

## What happened

A one-line description of the bug.

## How it was invoked

The exact `/riptide-assess` invocation, including any Steering Hint, and the
agent host (Claude Code, Codex, ...).

## Expected behavior

What should have happened instead.

## What was delivered

The Assessment, Blocker Report or Out-of-Scope Note the Skill delivered (the
`.md` and its `.json`), or where the run stopped. A committed `.riptide/`
Workspace is the fastest path to a repro on our end.

## Environment

- Skill and Engine versions (`skill_version` and `engine_version` in the delivered `.json`):
- OS (Linux distro + kernel / macOS version):
- Rust toolchain (`rustc --version`):
- Solana CLI (`solana --version`):
- Node version (`node --version`):

## Additional context

Anything else: a determinism mismatch between two runs, a minimal program that
reproduces the issue, etc.
