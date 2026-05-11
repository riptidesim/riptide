// Studio config-intent generator.
//
// Produces a structured config intent JSON, a copyable
// `riptide-config` handoff prompt, proposed file targets, and
// suggested validation commands. The server NEVER mutates files
// from this surface; the user copies the prompt into their
// `riptide-config` skill flow. This is the explicit Sprint 31
// trust boundary documented in spec.md.

export interface ConfigIntentInput {
  workspace_id: string;
  protocol_class: string;
  repo_path: string;
  risk_goal: string;
  scenario_target: string;
  evidence_boundary: string;
  notes?: string;
}

export interface ConfigIntentResponse {
  schema_version: "studio-config-intent.v1";
  intent: ConfigIntentInput & { generated_at: string };
  proposed_files: { path: string; purpose: string }[];
  validation_commands: string[];
  handoff_prompt: string;
  notes: string[];
}

export interface ConfigIntentValidationError {
  status: number;
  payload: Record<string, unknown>;
}

const PROTOCOL_CLASSES = new Set([
  "lending",
  "amm",
  "perps",
  "vault",
  "stablecoin",
  "yield",
  "bridge",
  "other"
]);

const EVIDENCE_BOUNDARIES = new Set([
  "current-state-only",
  "current-state-plus-replay",
  "campaign-grid",
  "guided-sim",
  "case-study"
]);

export function generateConfigIntent(
  raw: unknown
): ConfigIntentResponse | ConfigIntentValidationError {
  const errs: string[] = [];
  if (!raw || typeof raw !== "object") {
    return error(400, "invalid_payload", "request body must be a JSON object with config intent fields");
  }
  const body = raw as Record<string, unknown>;
  const requireString = (key: string): string => {
    const v = body[key];
    if (typeof v !== "string" || v.trim().length === 0) {
      errs.push(`missing or empty field: ${key}`);
      return "";
    }
    return v.trim();
  };
  const workspaceId = requireString("workspace_id");
  const protocolClass = requireString("protocol_class");
  const repoPath = requireString("repo_path");
  const riskGoal = requireString("risk_goal");
  const scenarioTarget = requireString("scenario_target");
  const evidenceBoundary = requireString("evidence_boundary");
  const notes = typeof body.notes === "string" ? body.notes.trim() : "";

  if (errs.length > 0) {
    return error(400, "missing_fields", errs.join("; "));
  }
  if (!PROTOCOL_CLASSES.has(protocolClass)) {
    return error(
      400,
      "invalid_protocol_class",
      `protocol_class ${JSON.stringify(protocolClass)} is not in the supported set: ${[...PROTOCOL_CLASSES].join(", ")}`
    );
  }
  if (!EVIDENCE_BOUNDARIES.has(evidenceBoundary)) {
    return error(
      400,
      "invalid_evidence_boundary",
      `evidence_boundary ${JSON.stringify(evidenceBoundary)} is not supported. Pick one of ${[...EVIDENCE_BOUNDARIES].join(", ")}.`
    );
  }
  if (/[\n\r]/.test(repoPath)) {
    return error(400, "invalid_repo_path", "repo_path must not contain newlines");
  }

  const intent: ConfigIntentInput & { generated_at: string } = {
    workspace_id: workspaceId,
    protocol_class: protocolClass,
    repo_path: repoPath,
    risk_goal: riskGoal,
    scenario_target: scenarioTarget,
    evidence_boundary: evidenceBoundary,
    notes,
    generated_at: new Date().toISOString()
  };

  const proposedFiles = proposeFiles(protocolClass, scenarioTarget);
  const validationCommands = suggestCommands(protocolClass, scenarioTarget);
  const handoffPrompt = renderHandoffPrompt(intent, proposedFiles, validationCommands);

  const noteLines: string[] = [
    "Studio did not edit any files. Run the prompt through the riptide-config skill to apply.",
    "Validation commands are suggestions; review them before pasting into a terminal."
  ];

  return {
    schema_version: "studio-config-intent.v1",
    intent,
    proposed_files: proposedFiles,
    validation_commands: validationCommands,
    handoff_prompt: handoffPrompt,
    notes: noteLines
  };
}

function proposeFiles(protocolClass: string, scenarioTarget: string): { path: string; purpose: string }[] {
  const safeScenario = scenarioTarget.replace(/[^A-Za-z0-9._-]/g, "-").toLowerCase() || "default";
  return [
    {
      path: `.riptide/adapters/${protocolClass}.toml`,
      purpose: `Adapter binding the ${protocolClass} program to Riptide's economic semantics, personas, and invariants.`
    },
    {
      path: `.riptide/scenarios/${safeScenario}/run-config.json`,
      purpose: "Scenario presets: tick budget, persona mix, environment seeds."
    },
    {
      path: `.riptide/scenarios/${safeScenario}/README.md`,
      purpose: "Operator-facing description of what this scenario stresses and why."
    },
    {
      path: `.riptide/personas/${protocolClass}-base.toml`,
      purpose: "Optional persona pack tailored to this protocol class."
    },
    {
      path: `.riptide/harness/setup.toml`,
      purpose: "Optional setup harness if the program needs Anchor/Cargo deployment hooks before tick 0."
    }
  ];
}

function suggestCommands(_protocolClass: string, scenarioTarget: string): string[] {
  const safeScenario = scenarioTarget.replace(/[^A-Za-z0-9._-]/g, "-").toLowerCase() || "";
  const commands: string[] = [
    "riptide doctor",
    "riptide lint",
    "riptide compile",
    safeScenario.length > 0 ? `riptide run ${safeScenario}` : "riptide run",
    "riptide review",
    "riptide readiness"
  ];
  return commands;
}

function renderHandoffPrompt(
  intent: ConfigIntentInput & { generated_at: string },
  proposedFiles: { path: string; purpose: string }[],
  validationCommands: string[]
): string {
  const fileLines = proposedFiles.map((f) => `- ${f.path} — ${f.purpose}`).join("\n");
  const commandLines = validationCommands.map((c) => `- ${c}`).join("\n");
  const notesBlock = intent.notes
    ? `\nOperator notes:\n${intent.notes}\n`
    : "";
  return [
    "Use the riptide-config skill to apply the following Studio handoff in the target repo.",
    "If this session says the skill is unavailable, do not proceed from memory; read and follow the first existing local instructions file at .claude/skills/riptide-config/SKILL.md, .codex/skills/riptide-config/SKILL.md, ~/.codex/skills/riptide-config/SKILL.md, or ~/.claude/skills/riptide-config/SKILL.md.",
    "",
    `- Repository: ${intent.repo_path}`,
    `- Protocol class: ${intent.protocol_class}`,
    `- Risk goal: ${intent.risk_goal}`,
    `- Scenario or campaign target: ${intent.scenario_target}`,
    `- Evidence boundary: ${intent.evidence_boundary}`,
    `- Workspace id: ${intent.workspace_id}`,
    `- Generated at: ${intent.generated_at}`,
    notesBlock.trim().length > 0 ? notesBlock : "",
    "Files to create or update (do not silently overwrite without asking):",
    fileLines,
    "",
    "Validation commands the operator should run after you finish:",
    commandLines,
    "",
    "Constraints:",
    "- Do not push or publish anything.",
    "- Do not modify files outside the listed targets without explicit confirmation.",
    "- Reuse existing personas/invariants where they fit. Prefer adapters that already pass `riptide lint`.",
    "- Land changes in a single feature branch and stop short of `git push` so a human reviews diffs."
  ]
    .filter((line) => line.trim().length > 0 || line === "")
    .join("\n");
}

function error(status: number, code: string, message: string): ConfigIntentValidationError {
  return { status, payload: { error: code, message } };
}
