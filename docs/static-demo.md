# Static Demo

The hosted `riptide.run` root is a static browser demo. It shows the product
path from product setup through mocked AI configuration, mocked run progress,
and report review without running Riptide, agents, subprocesses, or filesystem
operations.

The demo source lives in [`../demo`](../demo). It renders the real
[`cli/studio-app`](../cli/studio-app) React UI and swaps the Studio API for a
browser-local mock layer, so the hosted page keeps Studio's layout instead of a
separate dashboard skin. Build it with:

```bash
npm run demo:build
```

The deploy artifact is `demo/dist/`.

## Hosting Contract

Deploy `demo/dist/` at the `https://riptide.run/` root. Keep these installer
routes outside the SPA fallback:

- `https://riptide.run/install`
- `https://riptide.run/install.ps1`

All other demo routes may fall back to `index.html`.

## Demo Boundary

The demo stores state in browser `localStorage` and uses only static mocked
data. It must not call `/api/studio/*`, invoke agents, read local files, or
start jobs. The "Run simulation" step intentionally locks the UI for a few
seconds while browser timers simulate queued, running, and report-writing
states.
