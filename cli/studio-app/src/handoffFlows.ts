export interface HandoffQuestion {
  id: string;
  label: string;
  placeholder: string;
  multiline?: boolean;
}

export interface HandoffFlow {
  id: string;
  label: string;
  title: string;
  objective: string;
  questions: HandoffQuestion[];
  fileTargets: string[];
  gates: string[];
}

export type HandoffAnswers = Record<string, string>;

export const HANDOFF_FLOWS: HandoffFlow[] = [
  {
    id: "setup-configuration",
    label: "Setup",
    title: "Setup / configuration",
    objective: "Configure the repository for a first useful Riptide run.",
    questions: [
      { id: "protocol", label: "Protocol class", placeholder: "lending, AMM, perps, vault, other..." },
      { id: "program", label: "Program or crate", placeholder: "program path, package name, or IDL hint" },
      { id: "risk_goal", label: "Risk goal", placeholder: "what should the first scenario prove or falsify?", multiline: true }
    ],
    fileTargets: [
      ".riptide/adapters/*.toml",
      ".riptide/scenarios/**/run-config.json",
      ".riptide/personas/**/*.toml",
      ".riptide/harness/**"
    ],
    gates: ["riptide doctor", "riptide lint", "riptide run <scenario>", "riptide review <artifact>"]
  },
  {
    id: "scenario-design",
    label: "Scenario",
    title: "Scenario design",
    objective: "Design a bounded scenario that stresses a concrete protocol behavior.",
    questions: [
      { id: "behavior", label: "Behavior to stress", placeholder: "liquidation cascade, pool exit, oracle lag..." },
      { id: "actors", label: "Actors / personas", placeholder: "whales, liquidators, arbitrageurs, LPs..." },
      { id: "bounds", label: "Budget and bounds", placeholder: "ticks, agents, seeds, runtime ceiling", multiline: true }
    ],
    fileTargets: [".riptide/scenarios/**", ".riptide/personas/**", ".riptide/adapters/*.toml"],
    gates: ["riptide lint", "riptide run <scenario> --seeds 1", "riptide review <artifact>"]
  },
  {
    id: "invariant-design",
    label: "Invariant",
    title: "Invariant design",
    objective: "Add or tighten an invariant from existing observations and report evidence.",
    questions: [
      { id: "risk", label: "Risk condition", placeholder: "bad debt, solvency, reserves, queue pressure..." },
      { id: "observations", label: "Available observations", placeholder: "summary fields, semantic observations, events...", multiline: true },
      { id: "severity", label: "Severity / threshold", placeholder: "warn vs error, exact threshold, why it matters" }
    ],
    fileTargets: [".riptide/adapters/*.toml", ".riptide/scenarios/**/run-config.json", "reports/**"],
    gates: ["riptide lint", "riptide run <targeted-scenario>", "riptide review <artifact>"]
  },
  {
    id: "report-explanation",
    label: "Explain",
    title: "Report explanation",
    objective: "Explain a report without editing files unless the user asks for a follow-up patch.",
    questions: [
      { id: "artifact", label: "Report or artifact", placeholder: ".riptide/pack/..., campaign root, report.md..." },
      { id: "audience", label: "Audience", placeholder: "founder, protocol engineer, reviewer, investor..." },
      { id: "decision", label: "Decision needed", placeholder: "ship, rerun, expand campaign, tighten invariant...", multiline: true }
    ],
    fileTargets: ["reports/**", ".riptide/pack/**", ".riptide/campaigns/**", ".riptide/runs/**"],
    gates: ["riptide review <artifact>", "do not edit files unless explicitly requested"]
  },
  {
    id: "scale-campaign",
    label: "Scale",
    title: "Scale campaign planning",
    objective: "Plan a deterministic campaign that increases evidence size without hiding blockers.",
    questions: [
      { id: "target", label: "Scale target", placeholder: "repos x scenarios x seeds x retained cases" },
      { id: "runtime", label: "Runtime / artifact ceiling", placeholder: "max minutes, max disk size, CI/local only..." },
      { id: "retention", label: "Retention strategy", placeholder: "first failure, worst risk, median, outlier...", multiline: true }
    ],
    fileTargets: ["fixtures/campaigns/**", "scripts/ci/**", "reports/real-world-scale/**"],
    gates: ["riptide campaign validate <campaign>", "riptide campaign plan <campaign>", "bash scripts/ci/scale-campaign-smoke.sh"]
  },
  {
    id: "reviewer-packet",
    label: "Packet",
    title: "Reviewer packet",
    objective: "Prepare a bounded packet that preserves raw evidence and claim boundaries.",
    questions: [
      { id: "artifacts", label: "Artifacts to include", placeholder: "packs, campaign roots, reports, stdout files...", multiline: true },
      { id: "claims", label: "Claims to support", placeholder: "what the packet may say and must not imply", multiline: true },
      { id: "recipient", label: "Recipient", placeholder: "judge, protocol team, auditor, collaborator" }
    ],
    fileTargets: ["reports/**", "docs/**", ".riptide/pack/**"],
    gates: ["riptide review <pack-or-campaign>", "grep for audit-equivalent wording in touched copy"]
  }
];

const TRUST_BOUNDARY = [
  "Do not perform hidden execution. Describe every command before using it and report exact stdout/stderr when it matters.",
  "Do not use or expose a generic shell path. Use Riptide allowlisted commands and specific file reads/edits only.",
  "Do not push, publish, create releases, upload Docker images, or run package/cargo/npm publish.",
  "Do not perform live-mainnet writes, deploy programs, use private keys, or send transactions.",
  "Do not claim audit signoff, protocol safety certification, or complete coverage from simulation evidence."
];

export function buildHandoffPrompt(
  flow: HandoffFlow,
  answers: HandoffAnswers,
  workspacePath: string
): string {
  const answerLines = flow.questions.map((q) => {
    const answer = answers[q.id]?.trim() || "(not provided)";
    return `- ${q.label}: ${answer}`;
  });
  return [
    `Riptide guided handoff: ${flow.title}`,
    "",
    `Workspace: ${workspacePath}`,
    `Objective: ${flow.objective}`,
    "",
    "Questionnaire:",
    ...answerLines,
    "",
    "Files and artifacts to inspect or change:",
    ...flow.fileTargets.map((target) => `- ${target}`),
    "",
    "Constraints:",
    ...TRUST_BOUNDARY.map((rule) => `- ${rule}`),
    "",
    "Expected gates:",
    ...flow.gates.map((gate) => `- ${gate}`),
    "",
    "Return format:",
    "- Summary of what changed or what was found.",
    "- Exact files touched or explicitly state no files were edited.",
    "- Commands run and whether they passed.",
    "- Remaining blockers or claim boundaries."
  ].join("\n");
}
