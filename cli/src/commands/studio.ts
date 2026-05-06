// `riptide studio` — local visual control plane.
//
// Localhost-only HTTP server that serves the Studio app and the
// `/api/studio/*` JSON endpoints. The CLI remains the source of
// truth; Studio is the read-mostly surface that makes existing
// workspaces, runs, campaigns, reports, and packs visible.
//
// Trust boundary:
// - Bind defaults to `127.0.0.1`.
// - No generic shell endpoint is exposed.
// - The server only reads the workspace and the optional case-studies
//   root provided on the command line. There is no write path here.

import path from "node:path";

import { Command } from "commander";

import { blockUntilSignal, startStudioServer } from "../studio/server.js";
import { printBanner } from "../banner.js";

interface StudioOptionsRaw {
  port?: string;
  host?: string;
  workspace?: string;
  caseStudiesRoot?: string;
  open?: boolean;
  quiet?: boolean;
}

export function createStudioCommand(): Command {
  return new Command("studio")
    .description(
      "Open the Riptide Studio — a localhost visual control plane for workspaces, evidence artifacts, simulation diagrams, and the riptide-config handoff."
    )
    .argument(
      "[workspace]",
      "Workspace path. Defaults to the current working directory."
    )
    .option("--port <port>", "Preferred port. Defaults to 4173.", undefined)
    .option("--host <host>", "Loopback bind address. Defaults to 127.0.0.1.", undefined)
    .option(
      "--workspace <path>",
      "Workspace path (alias for the positional argument). Defaults to the current working directory.",
      undefined
    )
    .option(
      "--case-studies-root <path>",
      "Optional parent directory whose subfolders become case-study workspaces. Each subfolder must contain a .riptide/.",
      undefined
    )
    .option(
      "--no-open",
      "Do not attempt to open the Studio URL in a browser. Print the URL and block on Ctrl-C. (Phase 1 always behaves as --no-open.)"
    )
    .option("--quiet", "Suppress the interactive banner.", false)
    .action(async (positionalWorkspace: string | undefined, opts: StudioOptionsRaw) => {
      printBanner({ flags: { quiet: Boolean(opts.quiet) } });

      const workspace = path.resolve(opts.workspace ?? positionalWorkspace ?? process.cwd());
      const caseStudiesRoot = opts.caseStudiesRoot
        ? path.resolve(opts.caseStudiesRoot)
        : undefined;
      const port = parsePort(opts.port);
      const host = opts.host ?? "127.0.0.1";

      const handle = await startStudioServer({
        workspace,
        caseStudiesRoot,
        port,
        host
      });

      const lines = [
        `riptide studio: ${handle.url}`,
        `  workspace: ${workspace}`
      ];
      if (caseStudiesRoot) {
        lines.push(`  case studies: ${caseStudiesRoot}`);
      }
      lines.push(`  health:    ${handle.url}/api/studio/health`);
      lines.push(`  ctrl-c to stop.`);
      process.stderr.write(lines.join("\n") + "\n");

      // Phase 1 ships only the `--no-open` path. Browser launching is
      // explicit user opt-in for later sprints; CI and headless
      // environments must never need it.
      await blockUntilSignal(handle);
    });
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `riptide studio: invalid --port ${JSON.stringify(raw)} (expected integer 0..65535)`
    );
  }
  return port;
}
