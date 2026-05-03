import path from "node:path";

import {
  compareSupportLevels,
  createReadinessReport,
  evaluateSupportLevel,
  type ReadinessBoundary,
  type ReadinessEvidence,
  type ReadinessNextAction,
  type ReadinessReason,
  type ReadinessReport,
  type ReadinessSliceRef,
  type ReadinessSemanticHygieneFinding,
  type SupportEvidenceKey,
  type SupportEvidenceSnapshot,
  type SupportLevelId,
} from "./model.js";
import {
  inspectReadinessWorkspace,
  type ReadinessAdapterInspection,
  type ReadinessArtifact,
  type ReadinessInspection,
  type ReadinessRunCollectionInspection,
  type ReadinessRunScenarioInspection,
  type ReadinessSliceInspection,
} from "./inspector.js";

export interface AnalyzeReadinessGapsOptions {
  candidate?: string;
  targetLevel?: SupportLevelId | null;
  sliceName?: string;
}

export interface InspectAndAnalyzeReadinessResult {
  inspection: ReadinessInspection;
  report: ReadinessReport;
}

interface ReadinessFacts {
  evidenceSnapshot: SupportEvidenceSnapshot;
  buildArtifactPaths: string[];
  adapterPaths: string[];
  validAdapters: ReadinessAdapterInspection[];
  invalidAdapters: ReadinessAdapterInspection[];
  semanticAdapters: ReadinessAdapterInspection[];
  unreadableRunCollections: ReadinessRunCollectionInspection[];
  genericRuns: ReadinessRunCollectionInspection[];
  semanticRuns: ReadinessRunCollectionInspection[];
  falsePositiveRuns: ReadinessRunCollectionInspection[];
  validSlices: ReadinessSliceInspection[];
  invalidSlices: ReadinessSliceInspection[];
  reportedSlices: ReadinessSliceInspection[];
  requestedSliceName?: string;
  requestedSliceMissing: boolean;
  riskSliceEvidence: ReadinessSliceInspection[];
  missingSliceEvidence: ReadinessSliceInspection[];
}

type CoreSemanticClass =
  | "lending.v1"
  | "amm.v1"
  | "perps-margin.v1"
  | "lst.v1"
  | "stablecoin.v1";

export async function inspectAndAnalyzeReadiness(
  inputPath: string,
  options: AnalyzeReadinessGapsOptions = {}
): Promise<InspectAndAnalyzeReadinessResult> {
  const inspection = await inspectReadinessWorkspace(inputPath);
  return {
    inspection,
    report: analyzeReadinessInspection(inspection, options),
  };
}

export function analyzeReadinessInspection(
  inspection: ReadinessInspection,
  options: AnalyzeReadinessGapsOptions = {}
): ReadinessReport {
  const facts = collectFacts(inspection, options);
  const evaluation = evaluateSupportLevel(facts.evidenceSnapshot);
  const blockerTarget =
    options.targetLevel && compareSupportLevels(evaluation.current, options.targetLevel) >= 0
      ? null
      : evaluation.next;
  const reasons = buildReasons(inspection, facts, blockerTarget);
  const nextActions = buildNextActions(inspection, facts, reasons.blockers, blockerTarget);
  const warnings = buildWarnings(inspection, facts);
  const semanticHygieneFindings = buildSemanticHygieneFindings(inspection, facts);

  return createReadinessReport({
    repo: {
      candidate: options.candidate ?? path.basename(inspection.rootPath),
      path: inspection.rootPath,
      ...(inspection.repo.remoteUrl ? { remoteUrl: inspection.repo.remoteUrl } : {}),
      ...(inspection.repo.branch ? { branch: inspection.repo.branch } : {}),
      ...(inspection.repo.commit ? { commit: inspection.repo.commit } : {}),
      ...(inspection.repo.dirty !== undefined ? { dirty: inspection.repo.dirty } : {}),
    },
    evidenceSnapshot: facts.evidenceSnapshot,
    targetLevel: options.targetLevel ?? null,
    evidence: buildEvidence(inspection, facts),
    partialReasons: reasons.partial,
    blockedReasons: reasons.blocked,
    blockers: reasons.blockers,
    nextActions,
    warnings,
    boundaries: buildBoundaries(inspection, facts),
    slices: facts.validSlices.map((slice) => buildSliceRef(slice, facts, evaluation.current)),
    semanticHygieneFindings,
  });
}

function collectFacts(
  inspection: ReadinessInspection,
  options: AnalyzeReadinessGapsOptions
): ReadinessFacts {
  const buildArtifactPaths = uniqueSorted([
    ...(inspection.build.anchorToml ? [inspection.build.anchorToml.relativePath] : []),
    ...(inspection.build.cargoToml ? [inspection.build.cargoToml.relativePath] : []),
    ...inspection.build.programSources.map((entry) => entry.relativePath),
    ...inspection.build.idls.map((entry) => entry.relativePath),
    ...inspection.build.programBinaries.map((entry) => entry.relativePath),
  ]);
  const validAdapters = inspection.riptide.adapters.filter(
    (adapter) => adapter.validationStatus === "valid"
  );
  const invalidAdapters = inspection.riptide.adapters.filter(
    (adapter) => adapter.validationStatus !== "valid"
  );
  const semanticAdapters = validAdapters.filter((adapter) => adapter.semanticClassSupported);
  const unreadableRunCollections = inspection.riptide.runCollections.filter((run) => !run.readable);
  const genericRuns = inspection.riptide.runCollections.filter(isGenericE2eEvidence);
  const semanticRuns = genericRuns.filter(
    (run) => semanticAdapters.length > 0 && isSemanticE2eEvidence(run)
  );
  const falsePositiveRuns = inspection.riptide.runCollections.filter(
    (run) => run.readable && run.totalScenarios > 0 && !isGenericE2eEvidence(run)
  );
  const validSlices = inspection.riptide.slices.filter(
    (slice) =>
      slice.validationStatus === "valid" &&
      (options.sliceName === undefined || slice.name === options.sliceName)
  );
  const invalidSlices = inspection.riptide.slices.filter(
    (slice) =>
      slice.validationStatus !== "valid" &&
      (options.sliceName === undefined || slice.name === options.sliceName)
  );
  const reportedSlices =
    options.sliceName === undefined
      ? inspection.riptide.slices
      : inspection.riptide.slices.filter((slice) => slice.name === options.sliceName);
  const requestedSliceMissing =
    options.sliceName !== undefined &&
    !inspection.riptide.slices.some((slice) => slice.name === options.sliceName);
  const trustworthyRunPaths = new Set(semanticRuns.map((run) => run.relativePath));
  const riskSliceEvidence = validSlices.filter((slice) =>
    slice.runEvidencePaths.some((entry) => trustworthyRunPaths.has(entry.relativePath))
  );
  const missingSliceEvidence = validSlices.filter(
    (slice) => slice.runEvidence.length > 0 && riskSliceEvidence.indexOf(slice) === -1
  );

  return {
    evidenceSnapshot: {
      candidate_record: true,
      local_repo: inspection.repo.exists && inspection.repo.isDirectory,
      build_or_program_artifacts: buildArtifactPaths.length > 0,
      riptide_workspace: inspection.riptide.present,
      generic_e2e_run: genericRuns.length > 0,
      semantic_e2e_run: semanticRuns.length > 0,
      risk_slice_e2e_run: riskSliceEvidence.length > 0,
      campaign_ready_inputs: inspection.riptide.campaignInputs.length > 0,
    },
    buildArtifactPaths,
    adapterPaths: inspection.riptide.adapters.map((adapter) => adapter.relativePath),
    validAdapters,
    invalidAdapters,
    semanticAdapters,
    unreadableRunCollections,
    genericRuns,
    semanticRuns,
    falsePositiveRuns,
    validSlices,
    invalidSlices,
    reportedSlices,
    ...(options.sliceName ? { requestedSliceName: options.sliceName } : {}),
    requestedSliceMissing,
    riskSliceEvidence,
    missingSliceEvidence,
  };
}

function buildEvidence(
  inspection: ReadinessInspection,
  facts: ReadinessFacts
): ReadinessEvidence[] {
  const evidence: ReadinessEvidence[] = [
    {
      key: "candidate_record",
      present: true,
      label: "candidate",
      paths: [inspection.rootPath],
      notes: ["readiness inspection was requested for this local path"],
    },
    {
      key: "local_repo",
      present: facts.evidenceSnapshot.local_repo === true,
      label: "local repository",
      paths: facts.evidenceSnapshot.local_repo ? [inspection.rootPath] : [],
      notes: repoNotes(inspection),
    },
    {
      key: "build_or_program_artifacts",
      present: facts.evidenceSnapshot.build_or_program_artifacts === true,
      label: "build, IDL, or program artifacts",
      paths: facts.buildArtifactPaths,
      notes: inspection.repo.stackMarkers,
    },
    {
      key: "riptide_workspace",
      present: facts.evidenceSnapshot.riptide_workspace === true,
      label: ".riptide workspace",
      paths: inspection.riptide.path ? [relativeToRoot(inspection, inspection.riptide.path)] : [],
      notes: [
        `${inspection.riptide.adapters.length} adapter(s)`,
        `${inspection.riptide.scenarios.length} scenario artifact(s)`,
        `${inspection.riptide.harnesses.length} harness(es)`,
        `${inspection.riptide.slices.length} slice manifest(s)`,
      ],
    },
    {
      key: "generic_e2e_run",
      present: facts.evidenceSnapshot.generic_e2e_run === true,
      label: "generic E2E run evidence",
      paths: facts.genericRuns.map((run) => run.relativePath),
      notes: facts.genericRuns.map(runSummaryNote),
    },
    {
      key: "semantic_e2e_run",
      present: facts.evidenceSnapshot.semantic_e2e_run === true,
      label: "semantic E2E run evidence",
      paths: facts.semanticRuns.map((run) => run.relativePath),
      notes: facts.semanticAdapters.map(
        (adapter) => `${adapter.relativePath}: ${adapter.semanticClass}`
      ),
    },
    {
      key: "risk_slice_e2e_run",
      present: facts.evidenceSnapshot.risk_slice_e2e_run === true,
      label: "risk-slice E2E run evidence",
      paths: facts.riskSliceEvidence.flatMap((slice) =>
        slice.runEvidencePaths.map((entry) => entry.relativePath)
      ),
      notes: facts.riskSliceEvidence.map((slice) => `${slice.name}: ${slice.class}`),
    },
    {
      key: "campaign_ready_inputs",
      present: facts.evidenceSnapshot.campaign_ready_inputs === true,
      label: "campaign-ready inputs",
      paths: inspection.riptide.campaignInputs.map((entry) => entry.relativePath),
      notes: ["input presence only; readiness does not execute campaigns"],
    },
  ];

  evidence.push({
    key: "custom:readiness.adapters",
    present: inspection.riptide.adapters.length > 0,
    label: "adapter summaries",
    paths: inspection.riptide.adapters.map((adapter) => adapter.relativePath),
    notes: inspection.riptide.adapters.map(adapterSummaryNote),
  });
  evidence.push({
    key: "custom:readiness.slices",
    present: facts.reportedSlices.length > 0,
    label: "slice manifests",
    paths: facts.reportedSlices.map((slice) => slice.relativePath),
    notes: facts.reportedSlices.map(sliceSummaryNote),
  });
  evidence.push({
    key: "custom:readiness.run_collections",
    present: inspection.riptide.runCollections.length > 0,
    label: "run collection summaries",
    paths: inspection.riptide.runCollections.map((run) => run.relativePath),
    notes: inspection.riptide.runCollections.map(runSummaryNote),
  });

  return evidence;
}

function buildSliceRef(
  slice: ReadinessSliceInspection,
  facts: ReadinessFacts,
  currentLevel: SupportLevelId
): ReadinessSliceRef {
  const hasTrustworthyEvidence = facts.riskSliceEvidence.includes(slice);
  const notes = slice.missingRunEvidence.map(
    (entry) => `missing declared evidence: ${entry}`
  );
  if (!hasTrustworthyEvidence && slice.runEvidencePaths.length > 0) {
    notes.push(
      "declared run evidence was found but did not satisfy trustworthy risk-slice E2E checks"
    );
  }

  return {
    name: slice.name,
    class: slice.class!,
    supportLevelTarget: slice.supportLevelTarget as SupportLevelId,
    currentLevel: sliceCurrentLevel(currentLevel, hasTrustworthyEvidence),
    evidence: [
      {
        key: "risk_slice_e2e_run",
        present: hasTrustworthyEvidence,
        label: `slice ${slice.name} run evidence`,
        paths: hasTrustworthyEvidence
          ? slice.runEvidencePaths.map((entry) => entry.relativePath)
          : [],
        notes,
      },
    ],
    boundaries: slice.knownBoundaries,
  };
}

function sliceCurrentLevel(
  currentLevel: SupportLevelId,
  hasTrustworthyEvidence: boolean
): SupportLevelId {
  if (hasTrustworthyEvidence) return "L6";
  return compareSupportLevels(currentLevel, "L5") > 0 ? "L5" : currentLevel;
}

function buildReasons(
  inspection: ReadinessInspection,
  facts: ReadinessFacts,
  nextLevel: SupportLevelId | null
): { partial: ReadinessReason[]; blocked: ReadinessReason[]; blockers: ReadinessReason[] } {
  const blocked: ReadinessReason[] = [];
  const partial: ReadinessReason[] = [];

  if (!inspection.repo.exists || !inspection.repo.isDirectory) {
    blocked.push({
      code: "local-repo-not-found",
      layer: "repo",
      message:
        "No local repository directory was discovered at the requested path. Add or clone the repo locally before readiness can inspect protocol support.",
      evidence: [inspection.inputPath],
    });
  }

  if (inspection.repo.exists && facts.buildArtifactPaths.length === 0) {
    blocked.push({
      code: "missing-build-or-program-artifacts",
      layer: "build",
      message:
        "No Anchor, Rust program source, IDL, or SBF artifact was discovered yet. This means adapter work has no local program surface to bind to.",
    });
  }

  if (facts.evidenceSnapshot.build_or_program_artifacts && !inspection.riptide.present) {
    blocked.push({
      code: "missing-riptide-workspace",
      layer: "adapter",
      message:
        "Program artifacts exist, but no .riptide workspace was discovered. Initialize local support artifacts before claiming Riptide workspace support.",
    });
  }

  if (inspection.riptide.present && inspection.riptide.adapters.length === 0) {
    blocked.push({
      code: "missing-adapter",
      layer: "adapter",
      message:
        "The .riptide workspace has no adapter TOML. Add an adapter that maps local program instructions and state into Riptide.",
      evidence: inspection.riptide.path ? [relativeToRoot(inspection, inspection.riptide.path)] : [],
    });
  }

  if (facts.requestedSliceMissing) {
    const sliceName = facts.requestedSliceName!;
    blocked.push({
      code: "requested-slice-not-found",
      layer: "slice",
      message: `Slice ${sliceName} was requested, but .riptide/slices/${sliceName}.toml is not currently wired in this repo-local workspace.`,
      evidence: [`.riptide/slices/${sliceName}.toml`],
    });
  }

  for (const adapter of facts.invalidAdapters) {
    blocked.push({
      code: "adapter-unreadable-or-invalid",
      layer: "adapter",
      message: `Adapter ${adapter.relativePath} exists but is not yet machine-readable: ${adapter.validationError ?? "unknown validation error"}.`,
      evidence: [adapter.relativePath],
    });
  }

  if (inspection.riptide.present && inspection.riptide.harnesses.length === 0) {
    partial.push({
      code: "missing-harness",
      layer: "harness",
      message:
        "No .riptide harness was discovered. Some adapters may still be inspectable, but local E2E execution will need a harness entry point.",
    });
  }

  if (inspection.riptide.present && inspection.riptide.scenarios.length === 0) {
    partial.push({
      code: "missing-scenarios",
      layer: "scenario",
      message:
        "No scenario artifacts were discovered under .riptide/scenarios. Runs need at least one scenario to become evidence.",
    });
  }

  if (
    nextLevel === "L4" &&
    inspection.riptide.adapters.length > 0 &&
    inspection.riptide.runCollections.length === 0
  ) {
    blocked.push({
      code: "adapter-without-run-evidence",
      layer: "run-evidence",
      message:
        "An adapter exists, but no run collection or last-run evidence was discovered. This is not yet E2E support.",
      evidence: facts.adapterPaths,
    });
  }

  for (const run of facts.unreadableRunCollections) {
    blocked.push({
      code: "run-collection-unreadable",
      layer: "run-evidence",
      message: `Run collection ${run.relativePath} exists but is not machine-readable: ${run.parseError ?? "unknown parse error"}. Treat it as no E2E evidence until the JSON can be parsed and checked.`,
      evidence: [run.relativePath],
    });
  }

  for (const run of facts.falsePositiveRuns) {
    if (!run.hasArtifactReadability) {
      blocked.push({
        code: "run-artifacts-unreadable",
        layer: "run-evidence",
        message: `Run collection ${run.relativePath} exists, but artifact readability did not pass. Treat it as partial evidence until simulation-result.json and report.md are readable.`,
        evidence: [run.relativePath],
      });
    }
    if (!run.hasStateMovement) {
      blocked.push({
        code: "run-without-state-movement",
        layer: "run-evidence",
        message: `Run collection ${run.relativePath} exists, but no passing state-movement check was observed. A passing run with no state movement is not meaningful economic stress evidence yet.`,
        evidence: [run.relativePath],
      });
    }
  }

  if (nextLevel === "L5" && facts.genericRuns.length > 0 && facts.semanticRuns.length === 0) {
    blocked.push({
      code: "generic-e2e-without-semantic-mapping",
      layer: "semantics",
      message:
        "Generic E2E run evidence exists, but no semantic E2E evidence was observed. This means the repo may execute locally without yet mapping economic meaning.",
      evidence: facts.genericRuns.map((run) => run.relativePath),
    });
  }

  for (const adapter of facts.validAdapters) {
    const inferred = inferCoreSemanticClassCandidate(adapter);
    if (!adapter.semanticClassSupported && inferred) {
      partial.push({
        code: "core-semantic-class-available",
        layer: "semantics",
        message: `Adapter ${adapter.relativePath} looks compatible with the existing ${inferred} semantic class. Migrate the adapter mapping before proposing new core semantics.`,
        evidence: [adapter.relativePath],
      });
    }
    if (adapter.semanticClassSupported && adapter.expressionInvariants.length === 0) {
      partial.push({
        code: "semantic-mapping-without-expression-invariants",
        layer: "invariants",
        message: `Adapter ${adapter.relativePath} declares ${adapter.semanticClass}, but no semantic expression invariants were discovered.`,
        evidence: [adapter.relativePath],
      });
    }
  }

  if (nextLevel === "L6") {
    if (facts.validSlices.length === 0) {
      blocked.push({
        code: "missing-risk-slice-manifest",
        layer: "slice",
        message:
          "Semantic E2E evidence exists, but no valid risk-slice manifest was discovered. Declare the economic path before claiming risk-slice E2E support.",
      });
    }
    for (const slice of facts.invalidSlices) {
      blocked.push({
        code: "slice-manifest-invalid",
        layer: "slice",
        message: `Slice manifest ${slice.relativePath} is not valid yet: ${slice.validationError ?? "unknown validation error"}.`,
        evidence: [slice.relativePath],
      });
    }
    for (const slice of facts.missingSliceEvidence) {
      blocked.push({
        code: "slice-run-evidence-missing",
        layer: "run-evidence",
        message: `Slice ${slice.name} declares run evidence, but no trustworthy matching run collection was observed. Add or rerun the declared slice scenario.`,
        evidence: [slice.relativePath, ...slice.missingRunEvidence],
      });
    }
  }

  if (nextLevel === "L7" && inspection.riptide.campaignInputs.length === 0) {
    blocked.push({
      code: "campaign-inputs-missing",
      layer: "campaign",
      message:
        "Risk-slice evidence exists, but campaign-ready input files were not discovered. This is only an input gap; readiness does not execute campaign internals.",
    });
  }

  return { partial, blocked, blockers: blocked };
}

function buildNextActions(
  inspection: ReadinessInspection,
  facts: ReadinessFacts,
  blockers: ReadinessReason[],
  nextLevel: SupportLevelId | null
): ReadinessNextAction[] {
  const actions: ReadinessNextAction[] = [];
  const add = (layer: ReadinessNextAction["layer"], action: string) => {
    if (!actions.some((entry) => entry.layer === layer && entry.action === action)) {
      actions.push({ layer, action });
    }
  };

  for (const blocker of blockers) {
    switch (blocker.code) {
      case "local-repo-not-found":
        add("repo", "Create or clone the protocol repo locally, then rerun readiness against that path.");
        break;
      case "missing-build-or-program-artifacts":
        add(
          "build",
          "Add or point readiness at local Anchor/Rust program sources, target/idl JSON, or target/deploy SBF artifacts."
        );
        break;
      case "missing-riptide-workspace":
        add(
          "adapter",
          "Create a .riptide workspace with an adapter, scenario directory, and harness metadata for the discovered program."
        );
        break;
      case "missing-adapter":
        add(
          "adapter",
          "Author .riptide/adapters/<protocol>.toml with instruction, account, observation, and lineage mappings."
        );
        break;
      case "adapter-unreadable-or-invalid":
        add("adapter", "Fix the adapter TOML parse or schema error reported in the blocker evidence.");
        break;
      case "adapter-without-run-evidence":
        add(
          "run-evidence",
          "Run a smoke scenario and keep .riptide/run-collection.json plus scenario artifacts in the workspace."
        );
        break;
      case "run-collection-unreadable":
        add(
          "run-evidence",
          "Fix or regenerate the unreadable run-collection.json file, then rerun readiness so artifact readability and state movement can be checked."
        );
        break;
      case "run-artifacts-unreadable":
        add(
          "run-evidence",
          "Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files."
        );
        break;
      case "run-without-state-movement":
        add(
          "scenario",
          "Adjust the scenario, personas, or adapter dispatch so the run produces a passing state_movement coverage check."
        );
        break;
      case "generic-e2e-without-semantic-mapping":
        add(
          "semantics",
          semanticMappingAction(facts.validAdapters)
        );
        break;
      case "missing-risk-slice-manifest":
        add(
          "slice",
          "Add .riptide/slices/<name>.toml declaring the risk path, semantic class, actions, accounts, observations, invariants, scenarios, and boundaries."
        );
        break;
      case "requested-slice-not-found":
        add(
          "slice",
          "Add the requested repo-local .riptide/slices/<name>.toml file or rerun readiness with an existing slice name."
        );
        break;
      case "slice-manifest-invalid":
        add("slice", "Fix the slice manifest validation diagnostics before using it as support evidence.");
        break;
      case "slice-run-evidence-missing":
        add(
          "run-evidence",
          "Rerun the declared slice scenario and update slice.run_evidence to the resulting run collection path."
        );
        break;
      case "campaign-inputs-missing":
        add(
          "campaign",
          "Add campaign-ready input files after Sprint 25 campaign schema lands; do not treat this as campaign execution evidence."
        );
        break;
    }
  }

  if (nextLevel === "L5" && facts.genericRuns.length > 0 && facts.semanticRuns.length === 0) {
    add("semantics", semanticMappingAction(facts.validAdapters));
  }

  if (actions.length === 0 && inspection.riptide.present && facts.validAdapters.length > 0) {
    add("documentation", "Record the inspected support level and evidence paths in the readiness task note.");
  }

  return actions;
}

function buildWarnings(inspection: ReadinessInspection, facts: ReadinessFacts): string[] {
  const warnings: string[] = [];
  if (inspection.repo.dirty) {
    warnings.push("repo has uncommitted or untracked local changes; readiness evidence may include local-only work");
  }
  for (const adapter of facts.validAdapters) {
    if (adapter.protocol === "generic" && !adapter.semanticClassSupported) {
      warnings.push(`${adapter.relativePath}: generic runtime adapter has no supported semantic class yet`);
    }
    if (adapter.semanticClass && !adapter.semanticClassSupported) {
      warnings.push(`${adapter.relativePath}: semantic class ${adapter.semanticClass} is not a supported core class`);
    }
    if (adapter.errorRegistry.count === 0) {
      warnings.push(`${adapter.relativePath}: no program error registry entries discovered`);
    }
  }
  for (const run of facts.unreadableRunCollections) {
    warnings.push(`${run.relativePath}: run collection is not machine-readable`);
  }
  for (const run of facts.falsePositiveRuns) {
    warnings.push(`${run.relativePath}: run collection exists but did not satisfy E2E evidence checks`);
  }
  return warnings;
}

function buildBoundaries(
  inspection: ReadinessInspection,
  facts: ReadinessFacts
): ReadinessBoundary[] {
  const boundaries: ReadinessBoundary[] = [];
  if (facts.genericRuns.length > 0 && facts.semanticRuns.length === 0) {
    boundaries.push({
      scope: "semantic",
      description:
        "Generic execution evidence does not claim semantic economic coverage until a supported [semantics] mapping is exercised.",
    });
  }
  if (facts.validSlices.length === 0) {
    boundaries.push({
      scope: "slice",
      description:
        "No declared risk slice was validated, so the report does not claim coverage of a specific economic path.",
    });
  }
  if (facts.requestedSliceMissing) {
    boundaries.push({
      scope: "slice",
      description: `Requested slice ${facts.requestedSliceName} is not currently wired in .riptide/slices/.`,
    });
  }
  for (const slice of facts.validSlices) {
    for (const boundary of slice.knownBoundaries) {
      boundaries.push({ scope: "slice", description: `${slice.name}: ${boundary}` });
    }
  }
  if (inspection.riptide.campaignInputs.length === 0) {
    boundaries.push({
      scope: "campaign",
      description:
        "Campaign-ready status is an input check only and is not inferred from smoke, semantic, or slice runs.",
    });
  }
  return boundaries;
}

function buildSemanticHygieneFindings(
  inspection: ReadinessInspection,
  facts: ReadinessFacts
): ReadinessSemanticHygieneFinding[] {
  const findings: ReadinessSemanticHygieneFinding[] = [];
  for (const adapter of facts.validAdapters) {
    const inferred = inferCoreSemanticClassCandidate(adapter);
    if (!adapter.semanticClassSupported && inferred) {
      findings.push({
        concept: inferred,
        classification: "adapter",
        severity: "info",
        recommendedLocation: "adapter",
        message: `Core semantic class ${inferred} already exists; ${adapter.relativePath} should migrate through adapter semantics instead of adding protocol-specific core concepts.`,
      });
    }
    if (adapter.semanticClass && !adapter.semanticClassSupported) {
      findings.push({
        concept: adapter.semanticClass,
        classification: "extension_candidate",
        severity: "warn",
        recommendedLocation: "extension_candidates",
        message:
          "Unsupported semantic class names need reuse evidence before they become reusable core extensions; otherwise keep the concept in adapter, custom observation, or slice scope.",
      });
    }
  }
  if (facts.validAdapters.length === 0 && inspection.riptide.adapters.length > 0) {
    findings.push({
      concept: "adapter-validation",
      classification: "adapter",
      severity: "warn",
      recommendedLocation: "adapter",
      message:
        "Adapters are present but not valid enough to evaluate semantic hygiene. Fix adapter parsing before changing core semantics.",
    });
  }
  return findings;
}

function isGenericE2eEvidence(run: ReadinessRunCollectionInspection): boolean {
  if (!run.readable || run.totalScenarios <= 0) return false;
  return run.scenarios.some(isGenericE2eScenario);
}

function isSemanticE2eEvidence(run: ReadinessRunCollectionInspection): boolean {
  if (!run.readable || run.totalScenarios <= 0) return false;
  return run.scenarios.some(
    (scenario) => isGenericE2eScenario(scenario) && scenario.semanticsEvaluated === "pass"
  );
}

function isGenericE2eScenario(scenario: ReadinessRunScenarioInspection): boolean {
  return (
    (scenario.status === "pass" || scenario.status === "fail") &&
    scenario.artifactReadability === "pass" &&
    scenario.stateMovement === "pass"
  );
}

function repoNotes(inspection: ReadinessInspection): string[] {
  const notes: string[] = [];
  if (inspection.repo.isGitRepo) {
    if (inspection.repo.remoteUrl) notes.push(`remote: ${inspection.repo.remoteUrl}`);
    if (inspection.repo.branch) notes.push(`branch: ${inspection.repo.branch}`);
    if (inspection.repo.commit) notes.push(`commit: ${inspection.repo.commit}`);
    if (inspection.repo.dirty !== undefined) notes.push(`dirty: ${inspection.repo.dirty}`);
  } else {
    notes.push("not a git worktree");
  }
  return notes;
}

function adapterSummaryNote(adapter: ReadinessAdapterInspection): string {
  const parts = [
    adapter.validationStatus,
    adapter.runtime ? `runtime=${adapter.runtime}` : null,
    adapter.semanticClass ? `semantic=${adapter.semanticClass}` : "semantic=none",
    `${adapter.actions.length} action(s)`,
    `${adapter.observations.length} observation(s)`,
    `${adapter.invariants.length} invariant(s)`,
  ].filter((part): part is string => part !== null);
  return `${adapter.relativePath}: ${parts.join(", ")}`;
}

function sliceSummaryNote(slice: ReadinessSliceInspection): string {
  const status = slice.validationStatus === "valid" ? `${slice.class} target=${slice.supportLevelTarget}` : slice.validationStatus;
  return `${slice.relativePath}: ${status}`;
}

function runSummaryNote(run: ReadinessRunCollectionInspection): string {
  const statuses = run.statuses.length > 0 ? run.statuses.join("/") : "no-status";
  const coverages = run.coverages.length > 0 ? run.coverages.join("/") : "no-coverage";
  const confidences = run.confidences.length > 0 ? run.confidences.join("/") : "no-confidence";
  return `${run.relativePath}: ${run.totalScenarios} scenario(s), status=${statuses}, coverage=${coverages}, confidence=${confidences}`;
}

function semanticMappingAction(adapters: ReadinessAdapterInspection[]): string {
  const supported = uniqueSorted(
    adapters
      .filter((adapter) => adapter.semanticClassSupported && adapter.semanticClass)
      .map((adapter) => adapter.semanticClass!)
  );
  if (supported.length > 0) {
    return `Rerun or adjust a scenario using the existing ${supported.join(", ")} [semantics] mapping until semantics_evaluated, artifact_readability, and state_movement all pass in the same scenario.`;
  }
  const inferred = uniqueSorted(
    adapters
      .map(inferCoreSemanticClassCandidate)
      .filter((value): value is CoreSemanticClass => value !== null)
  );
  if (inferred.length > 0) {
    return `Add a [semantics] block using the existing ${inferred.join(", ")} core class and rerun until semantics_evaluated passes.`;
  }
  return "Add a supported [semantics] mapping to the adapter and rerun until semantics_evaluated passes.";
}

function inferCoreSemanticClassCandidate(
  adapter: ReadinessAdapterInspection
): CoreSemanticClass | null {
  if (adapter.semanticClassSupported) return adapter.semanticClass as CoreSemanticClass;
  const tokens = [
    adapter.name,
    ...adapter.actions,
    ...adapter.accounts,
    ...adapter.observations,
    ...adapter.derivedObservations,
  ].map((token) => token.toLowerCase());
  const has = (...needles: string[]) =>
    needles.some((needle) => tokens.some((token) => token.includes(needle)));
  const hasAll = (...needles: string[]) =>
    needles.every((needle) => tokens.some((token) => token.includes(needle)));

  if (has("liquidate") || hasAll("borrow", "collateral")) return "lending.v1";
  if (has("stable", "peg", "psm") || hasAll("mint", "redeem", "collateral")) return "stablecoin.v1";
  if (has("swap") && has("liquidity", "reserve", "lp")) return "amm.v1";
  if (has("perp", "funding") || hasAll("margin", "collateral")) return "perps-margin.v1";
  if (has("lst", "exchange_rate", "withdrawal_queue") || hasAll("stake", "reserve")) return "lst.v1";
  return null;
}

function relativeToRoot(inspection: ReadinessInspection, filePath: string): string {
  const relative = path.relative(inspection.rootPath, filePath);
  if (relative === "") return ".";
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  return filePath;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
