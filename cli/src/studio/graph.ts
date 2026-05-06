// Studio diagram graph builder.
//
// Produces a deterministic node/edge JSON payload that explains the
// shape of a Riptide simulation for a given workspace + selection
// (adapter, scenario, campaign, run, pack). The graph is rendered
// by the Studio shell with a static SVG layout — no external layout
// service is used, so the diagram works offline.
//
// Inputs read directly from the workspace:
//   - .riptide/adapters/*.toml       (semantics class, personas, invariants)
//   - .riptide/scenarios/<name>/run-config.json
//   - .riptide/campaigns/*.campaign.toml
//   - .riptide/campaigns/<id>/campaign-summary.json
//   - .riptide/runs/<name>/simulation-result.json
//   - .riptide/pack/<name>/manifest.json
//
// Each node carries a `source_path` so the UI can link back to the
// underlying file, and a `meaning` blurb describing what the node does
// in user-facing terms (not internal jargon).

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import toml from "toml";

export type StudioGraphNodeKind =
  | "workspace"
  | "adapter"
  | "semantics"
  | "persona"
  | "scenario"
  | "campaign"
  | "parameter"
  | "invariant"
  | "engine"
  | "run"
  | "report"
  | "pack";

export interface StudioGraphNode {
  /** Stable id within the graph (column.kind:name). */
  id: string;
  /** Node kind for UI grouping/colour. */
  kind: StudioGraphNodeKind;
  /** Display label shown in the node body. */
  label: string;
  /** Practical sentence explaining what this node does. */
  meaning: string;
  /** Workspace-relative path of the source artifact, when one exists. */
  source_path?: string;
  /** Free-form lightweight metadata (e.g. counts, classes). */
  meta?: Record<string, string | number | boolean | null>;
}

export interface StudioGraphEdge {
  /** Stable id (`from->to:label-slug`). */
  id: string;
  from: string;
  to: string;
  /** User-facing flow description. */
  label: string;
}

export interface StudioGraphPayload {
  schema_version: "studio-graph.v2";
  workspace_id: string;
  workspace_path: string;
  selection: {
    adapter: string | null;
    scenario: string | null;
    campaign: string | null;
    run: string | null;
    pack: string | null;
  };
  nodes: StudioGraphNode[];
  edges: StudioGraphEdge[];
  warnings: { message: string; next_action: string }[];
}

export interface BuildGraphOptions {
  workspaceId: string;
  workspacePath: string;
  /** Adapter file basename (e.g. `lending.toml`). Optional; first adapter is used. */
  adapter?: string;
  /** Scenario name (subfolder under `.riptide/scenarios/`). Optional; first scenario is used. */
  scenario?: string;
  /** Campaign id (subfolder under `.riptide/campaigns/`) or `*.campaign.toml` filename. */
  campaign?: string;
  /** Run name (subfolder under `.riptide/runs/`). */
  run?: string;
  /** Pack name (subfolder under `.riptide/pack/`). */
  pack?: string;
}

interface AdapterModel {
  file: string;
  fileBasename: string;
  semanticsClass: string | null;
  personas: { id: string; label: string }[];
  invariants: { name: string; field?: string; op?: string; value?: number | string }[];
  scheduledActions: { name: string; instruction: string }[];
  protocol?: string;
}

const SEMANTICS_DESCRIPTION: Record<string, string> = {
  "lending.v1":
    "Lending semantics — collateral, debt, health factor and liquidation rules sourced from on-chain reserve and obligation accounts.",
  "amm.v1":
    "AMM semantics — pool reserves, spot price, and liquidity value derived from the swap state.",
  "perps.v1":
    "Perps semantics — position margin, leverage, and funding-rate context derived from market and user accounts.",
  "stablecoin.v1":
    "Stablecoin semantics — peg deviation and reserve health derived from the issuance and reserve accounts."
};

export async function buildStudioGraph(
  options: BuildGraphOptions
): Promise<StudioGraphPayload> {
  const root = path.resolve(options.workspacePath);
  const warnings: { message: string; next_action: string }[] = [];
  const adapter = await selectAdapter(root, options.adapter, warnings);
  const scenario = await selectScenario(root, options.scenario, warnings);
  const campaign = await selectCampaign(root, options.campaign, warnings);
  const run = await selectRun(root, options.run);
  const pack = await selectPack(root, options.pack);

  const nodes: StudioGraphNode[] = [];
  const edges: StudioGraphEdge[] = [];
  const seenNodeIds = new Set<string>();
  const seenEdgeIds = new Set<string>();

  function addNode(node: StudioGraphNode): void {
    if (seenNodeIds.has(node.id)) return;
    seenNodeIds.add(node.id);
    nodes.push(node);
  }
  function addEdge(edge: StudioGraphEdge): void {
    if (seenEdgeIds.has(edge.id)) return;
    seenEdgeIds.add(edge.id);
    edges.push(edge);
  }
  function edgeId(from: string, to: string, label: string): string {
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return `${from}->${to}:${slug}`;
  }

  // 1) Workspace anchor.
  const workspaceLabel = path.basename(root) || options.workspaceId;
  const workspaceId = `workspace:${options.workspaceId}`;
  addNode({
    id: workspaceId,
    kind: "workspace",
    label: workspaceLabel,
    meaning: "Riptide workspace — the repo Riptide reads adapters, scenarios, and runs from.",
    meta: { workspace_id: options.workspaceId }
  });

  // 2) Engine — always present so flows have a center.
  const engineId = "engine:riptide";
  addNode({
    id: engineId,
    kind: "engine",
    label: "Riptide engine",
    meaning: "Deterministic LiteSVM-backed runner. Executes the program on each tick under persona actions and the active scenario.",
    meta: { backend: "litesvm" }
  });

  // 3) Adapter + semantics + personas + invariants.
  if (adapter) {
    const adapterId = `adapter:${adapter.fileBasename}`;
    addNode({
      id: adapterId,
      kind: "adapter",
      label: adapter.fileBasename,
      source_path: adapter.file,
      meaning: "Adapter — points the engine at the program, declares accounts, instructions, personas, and invariants.",
      meta: {
        protocol: adapter.protocol ?? null,
        personas: adapter.personas.length,
        invariants: adapter.invariants.length
      }
    });
    addEdge({
      id: edgeId(workspaceId, adapterId, "uses adapter"),
      from: workspaceId,
      to: adapterId,
      label: "uses adapter"
    });
    addEdge({
      id: edgeId(adapterId, engineId, "drives engine"),
      from: adapterId,
      to: engineId,
      label: "drives engine"
    });

    // Semantics class.
    if (adapter.semanticsClass) {
      const semanticsId = `semantics:${adapter.semanticsClass}`;
      addNode({
        id: semanticsId,
        kind: "semantics",
        label: adapter.semanticsClass,
        meaning:
          SEMANTICS_DESCRIPTION[adapter.semanticsClass] ??
          "Semantic class — names the protocol pattern so the engine binds the right invariants and observation set.",
        source_path: adapter.file,
        meta: { class: adapter.semanticsClass }
      });
      addEdge({
        id: edgeId(adapterId, semanticsId, "tags as"),
        from: adapterId,
        to: semanticsId,
        label: "tags as"
      });
    }

    // Personas (sorted by id for determinism).
    const personas = [...adapter.personas].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
    for (const persona of personas) {
      const personaId = `persona:${persona.id}`;
      addNode({
        id: personaId,
        kind: "persona",
        label: persona.label || persona.id,
        meaning: "Persona — an autonomous actor the engine drives during the run. Uses the adapter's actions on each tick.",
        source_path: adapter.file,
        meta: { persona_id: persona.id }
      });
      addEdge({
        id: edgeId(personaId, engineId, "acts on engine"),
        from: personaId,
        to: engineId,
        label: "acts on engine"
      });
    }

    // Invariants.
    const invariants = [...adapter.invariants].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    for (const inv of invariants) {
      const invId = `invariant:${inv.name}`;
      addNode({
        id: invId,
        kind: "invariant",
        label: inv.name,
        meaning: invariantMeaning(inv),
        source_path: adapter.file,
        meta: {
          field: inv.field ?? null,
          op: inv.op ?? null,
          value: inv.value ?? null
        }
      });
      addEdge({
        id: edgeId(engineId, invId, "checks each tick"),
        from: engineId,
        to: invId,
        label: "checks each tick"
      });
    }
  } else {
    warnings.push({
      message: "no adapter selected for this graph",
      next_action: "Run `riptide init` to scaffold an adapter, or copy one into `.riptide/adapters/`."
    });
  }

  // 4) Scenario.
  if (scenario) {
    const scenarioId = `scenario:${scenario.name}`;
    addNode({
      id: scenarioId,
      kind: "scenario",
      label: scenario.name,
      source_path: scenario.runConfigPath ?? scenario.dir,
      meaning: "Scenario — a single run config: agents, ticks, seed, persona mix, and any per-run parameters.",
      meta: {
        agents: scenario.agents ?? null,
        ticks: scenario.ticks ?? null,
        seed: scenario.seed ?? null
      }
    });
    addEdge({
      id: edgeId(scenarioId, engineId, "configures run"),
      from: scenarioId,
      to: engineId,
      label: "configures run"
    });
  }

  // 5) Campaign + parameters.
  if (campaign) {
    const campaignId = `campaign:${campaign.name}`;
    addNode({
      id: campaignId,
      kind: "campaign",
      label: campaign.name,
      source_path: campaign.tomlPath ?? campaign.outputDir,
      meaning: "Campaign — sweeps a parameter grid across one or more scenarios and retains representative runs as evidence.",
      meta: {
        run_budget: campaign.runBudget ?? null,
        risk_objective: campaign.riskObjective ?? null,
        retention: campaign.retention ?? null
      }
    });
    if (campaign.outputDir) {
      const summaryNodeId = `pack:campaign:${campaign.name}`;
      addNode({
        id: summaryNodeId,
        kind: "pack",
        label: `${campaign.name} retained cases`,
        source_path: campaign.outputDir,
        meaning: "Retained campaign runs — every kept run includes the full simulation-result.json plus the run config used to reproduce it.",
        meta: {
          retained_runs: campaign.retainedRuns ?? null,
          dominant_verdict: campaign.dominantVerdict ?? null
        }
      });
      addEdge({
        id: edgeId(campaignId, summaryNodeId, "retains evidence"),
        from: campaignId,
        to: summaryNodeId,
        label: "retains evidence"
      });
    }
    addEdge({
      id: edgeId(campaignId, engineId, "schedules engine"),
      from: campaignId,
      to: engineId,
      label: "schedules engine"
    });

    // Parameters as small leaf nodes.
    for (const parameter of campaign.parameters.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    )) {
      const paramId = `parameter:${campaign.name}:${parameter.name}`;
      addNode({
        id: paramId,
        kind: "parameter",
        label: parameter.name,
        meaning: parameter.distribution
          ? `Sweep parameter — ${parameter.distribution}.`
          : "Sweep parameter — varied across the campaign run grid.",
        source_path: campaign.tomlPath ?? undefined,
        meta: {
          distribution: parameter.distribution ?? null,
          unit: parameter.unit ?? null
        }
      });
      addEdge({
        id: edgeId(paramId, campaignId, "sweeps"),
        from: paramId,
        to: campaignId,
        label: "sweeps"
      });
    }
  }

  // 6) Run + report (concrete artifact for the selected run, or a representative one).
  if (run) {
    const runId = `run:${run.name}`;
    addNode({
      id: runId,
      kind: "run",
      label: run.name,
      source_path: run.dir,
      meaning: "Run artifact — the deterministic simulation-result.json the engine wrote for this scenario execution.",
      meta: {
        invariant_fires: run.invariantFires,
        ticks: run.totalTicks ?? null,
        seed: run.seed ?? null
      }
    });
    addEdge({
      id: edgeId(engineId, runId, "produces"),
      from: engineId,
      to: runId,
      label: "produces"
    });
    if (run.reportPath) {
      const reportId = `report:${run.name}`;
      addNode({
        id: reportId,
        kind: "report",
        label: "report.md",
        source_path: run.reportPath,
        meaning: "Generated Markdown report — human-readable summary of the run's metrics, invariant fires, and notable events."
      });
      addEdge({
        id: edgeId(runId, reportId, "summarized in"),
        from: runId,
        to: reportId,
        label: "summarized in"
      });
    }
  }

  // 7) Pack (if explicitly selected or if a single pack matches the run name).
  if (pack) {
    const packId = `pack:${pack.name}`;
    addNode({
      id: packId,
      kind: "pack",
      label: pack.name,
      source_path: pack.dir,
      meaning: "Replay pack — frozen inputs/outputs and a rerun.sh so this run can be re-executed byte-identically later.",
      meta: { canonical_hash: pack.canonicalHash ?? null }
    });
    if (run) {
      addEdge({
        id: edgeId(`run:${run.name}`, packId, "packed as"),
        from: `run:${run.name}`,
        to: packId,
        label: "packed as"
      });
    } else {
      addEdge({
        id: edgeId(engineId, packId, "packed as"),
        from: engineId,
        to: packId,
        label: "packed as"
      });
    }
  }

  return {
    schema_version: "studio-graph.v2",
    workspace_id: options.workspaceId,
    workspace_path: root,
    selection: {
      adapter: adapter?.fileBasename ?? null,
      scenario: scenario?.name ?? null,
      campaign: campaign?.name ?? null,
      run: run?.name ?? null,
      pack: pack?.name ?? null
    },
    nodes,
    edges,
    warnings
  };
}

function invariantMeaning(inv: {
  name: string;
  field?: string;
  op?: string;
  value?: number | string;
}): string {
  if (inv.field && inv.op && inv.value !== undefined && inv.value !== null) {
    return `Invariant — fires when \`${inv.field} ${inv.op} ${inv.value}\` no longer holds.`;
  }
  return "Invariant — fires when its declared condition no longer holds.";
}

// ---- selection ----

interface SelectedScenario {
  name: string;
  dir: string;
  runConfigPath?: string;
  agents?: number;
  ticks?: number;
  seed?: number;
}

interface SelectedCampaign {
  name: string;
  tomlPath?: string;
  outputDir?: string;
  runBudget?: number;
  riskObjective?: string;
  retention?: string;
  retainedRuns?: number;
  dominantVerdict?: string;
  parameters: { name: string; distribution?: string; unit?: string }[];
}

interface SelectedRun {
  name: string;
  dir: string;
  reportPath?: string;
  totalTicks?: number;
  seed?: number;
  invariantFires: number;
}

interface SelectedPack {
  name: string;
  dir: string;
  canonicalHash?: string;
}

async function selectAdapter(
  root: string,
  requested: string | undefined,
  warnings: { message: string; next_action: string }[]
): Promise<AdapterModel | null> {
  const dir = path.join(root, ".riptide", "adapters");
  const entries = await readdirSafe(dir);
  const tomls = entries
    .filter((e) => e.isFile() && e.name.endsWith(".toml"))
    .map((e) => e.name)
    .sort(compareStrings);
  if (tomls.length === 0) {
    warnings.push({
      message: "no adapter TOML found under .riptide/adapters/",
      next_action: "Run `riptide init` or copy an adapter file into `.riptide/adapters/`."
    });
    return null;
  }
  const choice = requested && tomls.includes(requested) ? requested : tomls[0]!;
  return parseAdapterToml(path.join(dir, choice));
}

async function parseAdapterToml(file: string): Promise<AdapterModel> {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = toml.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const personasObj = (parsed["personas"] as Record<string, Record<string, unknown>>) ?? {};
  const personas = Object.entries(personasObj).map(([id, value]) => ({
    id,
    label: typeof value?.label === "string" ? value.label : id
  }));
  const invariantsArr = (parsed["invariants"] as Array<Record<string, unknown>>) ?? [];
  const invariants = invariantsArr.map((row) => ({
    name: typeof row?.name === "string" ? row.name : "invariant",
    field: typeof row?.field === "string" ? row.field : undefined,
    op: typeof row?.op === "string" ? row.op : undefined,
    value: (typeof row?.value === "number" || typeof row?.value === "string"
      ? row.value
      : undefined) as number | string | undefined
  }));
  const scheduledArr =
    (parsed["scheduled_actions"] as Array<Record<string, unknown>>) ?? [];
  const scheduledActions = scheduledArr.map((row) => ({
    name: typeof row?.name === "string" ? row.name : "scheduled",
    instruction: typeof row?.instruction === "string" ? row.instruction : ""
  }));
  const semantics = (parsed["semantics"] as Record<string, unknown>) ?? {};
  const semanticsClass = typeof semantics?.class === "string" ? semantics.class : null;
  const protocol = typeof parsed["protocol"] === "string" ? (parsed["protocol"] as string) : undefined;

  return {
    file,
    fileBasename: path.basename(file),
    semanticsClass,
    personas,
    invariants,
    scheduledActions,
    protocol
  };
}

async function selectScenario(
  root: string,
  requested: string | undefined,
  warnings: { message: string; next_action: string }[]
): Promise<SelectedScenario | null> {
  const dir = path.join(root, ".riptide", "scenarios");
  const entries = await readdirSafe(dir);
  const folders = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(compareStrings);
  if (folders.length === 0) {
    warnings.push({
      message: "no scenario folders under .riptide/scenarios/",
      next_action: "Run `riptide init` to scaffold a scenario or copy one into `.riptide/scenarios/`."
    });
    return null;
  }
  const choice = requested && folders.includes(requested) ? requested : folders[0]!;
  const scenarioDir = path.join(dir, choice);
  const runConfigPath = path.join(scenarioDir, "run-config.json");
  let agents: number | undefined;
  let ticks: number | undefined;
  let seed: number | undefined;
  try {
    const parsed = JSON.parse(await readFile(runConfigPath, "utf8")) as {
      agents?: number;
      ticks?: number;
      seed?: number;
    };
    agents = parsed.agents;
    ticks = parsed.ticks;
    seed = parsed.seed;
  } catch {
    // fine — render without metadata
  }
  return {
    name: choice,
    dir: scenarioDir,
    runConfigPath: (await safeStat(runConfigPath)) ? runConfigPath : undefined,
    agents,
    ticks,
    seed
  };
}

async function selectCampaign(
  root: string,
  requested: string | undefined,
  warnings: { message: string; next_action: string }[]
): Promise<SelectedCampaign | null> {
  const dir = path.join(root, ".riptide", "campaigns");
  const entries = await readdirSafe(dir);
  const tomls = entries
    .filter((e) => e.isFile() && e.name.endsWith(".campaign.toml"))
    .map((e) => e.name)
    .sort(compareStrings);
  const folders = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(compareStrings);
  if (tomls.length === 0 && folders.length === 0) return null;

  if (requested) {
    if (tomls.includes(requested)) return readCampaignToml(path.join(dir, requested));
    if (folders.includes(requested)) return readCampaignDir(path.join(dir, requested));
    warnings.push({
      message: `campaign ${JSON.stringify(requested)} not found`,
      next_action: "Pick a different campaign or omit the parameter."
    });
  }

  if (tomls[0]) return readCampaignToml(path.join(dir, tomls[0]));
  if (folders[0]) return readCampaignDir(path.join(dir, folders[0]));
  return null;
}

async function readCampaignToml(file: string): Promise<SelectedCampaign> {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = toml.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const campaign = (parsed["campaign"] as Record<string, unknown>) ?? {};
  const parametersBlock =
    (campaign?.["parameters"] as Record<string, Record<string, unknown>>) ?? {};
  const parameters = Object.entries(parametersBlock).map(([name, value]) => ({
    name,
    distribution: typeof value?.distribution === "string" ? value.distribution : undefined,
    unit: typeof value?.unit === "string" ? value.unit : undefined
  }));
  return {
    name: typeof campaign?.name === "string" ? campaign.name : path.basename(file, ".campaign.toml"),
    tomlPath: file,
    runBudget: typeof campaign?.run_budget === "number" ? campaign.run_budget : undefined,
    riskObjective:
      typeof campaign?.risk_objective === "string" ? campaign.risk_objective : undefined,
    retention: Array.isArray(campaign?.replay_retention)
      ? (campaign.replay_retention as string[]).join(", ")
      : undefined,
    parameters
  };
}

async function readCampaignDir(dir: string): Promise<SelectedCampaign> {
  const summaryFile = path.join(dir, "campaign-summary.json");
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(await readFile(summaryFile, "utf8")) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const totals = (parsed["totals"] as Record<string, unknown>) ?? {};
  const campaignBlock = (parsed["campaign"] as Record<string, unknown>) ?? {};
  return {
    name:
      typeof campaignBlock?.name === "string"
        ? campaignBlock.name
        : path.basename(dir),
    outputDir: dir,
    tomlPath: undefined,
    runBudget:
      typeof campaignBlock?.run_budget === "number" ? campaignBlock.run_budget : undefined,
    riskObjective:
      typeof campaignBlock?.risk_objective === "string"
        ? campaignBlock.risk_objective
        : undefined,
    retention: Array.isArray(campaignBlock?.replay_retention)
      ? (campaignBlock.replay_retention as string[]).join(", ")
      : undefined,
    retainedRuns:
      typeof totals?.retained_runs === "number" ? totals.retained_runs : undefined,
    dominantVerdict:
      typeof parsed?.dominant_verdict === "string"
        ? parsed.dominant_verdict
        : undefined,
    parameters: []
  };
}

async function selectRun(root: string, requested: string | undefined): Promise<SelectedRun | null> {
  const dir = path.join(root, ".riptide", "runs");
  const entries = await readdirSafe(dir);
  const folders = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(compareStrings);
  if (folders.length === 0) return null;
  const choice = requested && folders.includes(requested) ? requested : folders[0]!;
  const runDir = path.join(dir, choice);
  const resultPath = path.join(runDir, "simulation-result.json");
  const reportPath = path.join(runDir, "report.md");
  let totalTicks: number | undefined;
  let seed: number | undefined;
  let invariantFires = 0;
  try {
    const parsed = JSON.parse(await readFile(resultPath, "utf8")) as {
      total_ticks?: number;
      seed?: number;
      events?: Array<{ action?: string }>;
      summary?: { invariants_fired?: Array<{ firings?: number }> };
    };
    totalTicks = parsed.total_ticks;
    seed = parsed.seed;
    invariantFires = countInvariantFires(parsed);
  } catch {
    // fine
  }
  return {
    name: choice,
    dir: runDir,
    reportPath: (await safeStat(reportPath)) ? reportPath : undefined,
    totalTicks,
    seed,
    invariantFires
  };
}

async function selectPack(root: string, requested: string | undefined): Promise<SelectedPack | null> {
  const dir = path.join(root, ".riptide", "pack");
  const entries = await readdirSafe(dir);
  const folders = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(compareStrings);
  if (folders.length === 0) return null;
  const choice = requested && folders.includes(requested) ? requested : folders[0]!;
  const packDir = path.join(dir, choice);
  const manifestPath = path.join(packDir, "manifest.json");
  let canonicalHash: string | undefined;
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as { canonical_hash?: string };
    if (typeof parsed.canonical_hash === "string") canonicalHash = parsed.canonical_hash;
  } catch {
    // fine
  }
  return { name: choice, dir: packDir, canonicalHash };
}

// ---- helpers ----

function countInvariantFires(result: {
  events?: Array<{ action?: string }>;
  summary?: { invariants_fired?: Array<{ firings?: number }> };
}): number {
  let fromEvents = 0;
  if (Array.isArray(result.events)) {
    for (const event of result.events) {
      if (typeof event?.action === "string" && event.action.startsWith("invariant_violation:")) {
        fromEvents += 1;
      }
    }
  }
  if (fromEvents > 0) return fromEvents;
  const rows = Array.isArray(result.summary?.invariants_fired)
    ? result.summary!.invariants_fired
    : [];
  let fromSummary = 0;
  for (const row of rows) {
    if (typeof row?.firings === "number" && row.firings > 0) fromSummary += row.firings;
  }
  return fromSummary;
}

async function readdirSafe(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [] as Awaited<ReturnType<typeof readdir>> & Array<never>;
  }
}

async function safeStat(target: string) {
  try {
    return await stat(target);
  } catch {
    return null;
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
