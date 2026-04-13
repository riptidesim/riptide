// Prompt loader (Sprint 3 · T07).
//
// Prompts live as real files under `src/llm/prompts/*.md`, not inline
// template strings, so prompt iteration is a file edit — not a TS
// recompile. The build pipeline (`scripts/copy-prompts.mjs`, wired
// into `npm run build`) copies the directory into `dist/` next to the
// compiled JS so `readFileSync` can find it at runtime regardless of
// the caller's cwd.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const promptsDir = path.join(here, "prompts");

function loadPrompt(name: string): string {
  const file = path.join(promptsDir, name);
  return readFileSync(file, "utf8");
}

export interface PromptBundle {
  classify: string;
  generateLending: string;
  generateGeneric: string;
  retrySuffix: string;
}

export function loadPrompts(): PromptBundle {
  return {
    classify: loadPrompt("classify.md"),
    generateLending: loadPrompt("generate-lending.md"),
    generateGeneric: loadPrompt("generate-generic.md"),
    retrySuffix: loadPrompt("retry-suffix.md")
  };
}

export function buildRetrySuffix(
  template: string,
  previous: string,
  error: string
): string {
  return template.replace("{{previous}}", previous).replace("{{error}}", error);
}
