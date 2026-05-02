import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(process.cwd(), "..");

test("riptide-scenarios prompt keeps user-repo personas inline, not fixture policies", async () => {
  const prompt = await readFile(
    path.join(REPO_ROOT, "skills", "riptide-scenarios", "prompts", "propose.md"),
    "utf8"
  );

  assert.match(prompt, /User repo mode/);
  assert.match(prompt, /Do not write `policies\.json` in user repo mode/);
  assert.match(prompt, /personas stay inline in the adapter/);
  assert.match(
    prompt,
    /riptide run <slug> --adapter <adapter> --harness \.riptide\/harness --seeds 1 --seed-root 1337/
  );
  assert.doesNotMatch(prompt, /`personas` is a list whose length equals `agents`/);
  assert.doesNotMatch(prompt, /must match policies\.json entries/);
  assert.match(prompt, /`policies\.json` is fixture-mode only/);
  assert.match(prompt, /`riptide scenarios --validate` are fixture-mode only/);
});
