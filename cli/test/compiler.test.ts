import test from "node:test";
import assert from "node:assert/strict";

import { compilePersonas, loadPersonaDescription, repairJson } from "../src/compiler/compile.js";
import { FALLBACK_POLICIES, getFallbackPolicy } from "../src/compiler/fallback.js";
import { DEFAULT_PERSONAS } from "../src/config.js";

test("all fallback policies are valid", () => {
  assert.equal(Object.keys(FALLBACK_POLICIES).length, 5);
});

test("loads persona descriptions from toml", async () => {
  const persona = await loadPersonaDescription("steady-lp");
  assert.equal(persona.persona_id, "steady-lp");
});

test("every default persona has a fallback policy", () => {
  assert.deepEqual(
    DEFAULT_PERSONAS.map((personaId) => getFallbackPolicy(personaId).persona_id),
    [...DEFAULT_PERSONAS]
  );
});

test("uses fallbacks when llm is unavailable", async () => {
  const warnings: string[] = [];
  const policies = await compilePersonas(["steady-lp", "degen-borrower"], {
    warn: (message) => warnings.push(message)
  });

  assert.equal(policies.length, 2);
  assert.match(warnings[0]!, /LLM unavailable/);
});

test("repairs fenced json", () => {
  const repaired = repairJson("```json\n{\"persona_id\":\"steady-lp\"}\n```") as { persona_id: string };
  assert.equal(repaired.persona_id, "steady-lp");
});

test("repairs fenced json with trailing newline after the fence", () => {
  const repaired = repairJson("```json\n{\"persona_id\":\"steady-lp\"}\n```\n") as { persona_id: string };
  assert.equal(repaired.persona_id, "steady-lp");
});

test("repairs the first balanced json object when prose contains trailing braces", () => {
  const repaired = repairJson(
    'Policy follows: {"persona_id":"steady-lp","persona_label":"Steady LP"} trailing note with }'
  ) as { persona_id: string; persona_label: string };

  assert.equal(repaired.persona_id, "steady-lp");
  assert.equal(repaired.persona_label, "Steady LP");
});
