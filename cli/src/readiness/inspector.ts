import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import TOML from "toml";

import {
  AdapterSchema,
  isSupportedSemanticClass,
  validateAdapter,
  type SemanticClass,
} from "../schemas/adapter.js";
import {
  SliceManifestValidationError,
  parseSliceManifestToml,
  type SliceManifest,
} from "./slices.js";

const execFileAsync = promisify(execFile);

export const READINESS_INSPECTION_SCHEMA_VERSION = "readiness-inspection.v1" as const;

export type ArtifactKind =
  | "anchor-toml"
  | "cargo-toml"
  | "package-json"
  | "program-source"
  | "idl"
  | "program-binary"
  | "test"
  | "migration"
  | "adapter"
  | "scenario"
  | "harness"
  | "slice"
  | "run-collection"
  | "run"
  | "last-run"
  | "report"
  | "pack"
  | "manifest"
  | "guided-sim-manifest"
  | "replay"
  | "campaign-input";

export interface ReadinessArtifact {
  kind: ArtifactKind;
  path: string;
  relativePath: string;
}

export interface ReadinessProgramId {
  name: string;
  cluster: string;
  programId: string;
  sourcePath: string;
}

export interface ReadinessGitMetadata {
  isGitRepo: boolean;
  gitRoot?: string;
  remoteUrl?: string;
  branch?: string;
  commit?: string;
  dirty?: boolean;
}

export interface ReadinessRepoMetadata extends ReadinessGitMetadata {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  stackMarkers: string[];
}

export interface ReadinessBuildInspection {
  anchorToml?: ReadinessArtifact;
  cargoToml?: ReadinessArtifact;
  cargoWorkspace: boolean;
  packageJson?: ReadinessArtifact;
  programSources: ReadinessArtifact[];
  idls: ReadinessArtifact[];
  programBinaries: ReadinessArtifact[];
  tests: ReadinessArtifact[];
  migrations: ReadinessArtifact[];
  programIds: ReadinessProgramId[];
}

export type AdapterValidationStatus = "valid" | "invalid" | "unreadable";

export interface ReadinessAdapterInspection {
  name: string;
  path: string;
  relativePath: string;
  validationStatus: AdapterValidationStatus;
  validationError?: string;
  protocol?: string;
  runtime?: string;
  programSo?: string;
  programSoPath?: string;
  programSoExists?: boolean;
  programId?: string;
  idlPath?: string;
  idlResolvedPath?: string;
  idlExists?: boolean;
  lineage: {
    idlSource?: string;
    idlSourcePath?: string;
    idlSourceExists?: boolean;
    generator?: string;
    inferredAssumptionCount: number;
    unsupportedFieldCount: number;
  };
  instructions: string[];
  actions: string[];
  accounts: string[];
  observations: string[];
  invariants: string[];
  semanticClass?: string;
  semanticClassSupported: boolean;
  semanticRoles: string[];
  derivedObservations: string[];
  expressionInvariants: string[];
  collections: string[];
  replayStateSource?: string;
  replayPackPath?: string;
  errorRegistry: {
    present: boolean;
    count: number;
  };
}

export type SliceValidationStatus = "valid" | "invalid" | "unreadable";

export interface ReadinessSliceInspection {
  name: string;
  path: string;
  relativePath: string;
  validationStatus: SliceValidationStatus;
  validationError?: string;
  class?: SemanticClass;
  supportLevelTarget?: string;
  actions: string[];
  accounts: string[];
  observations: string[];
  invariants: string[];
  scenarios: string[];
  runEvidence: string[];
  runEvidencePaths: ReadinessArtifact[];
  missingRunEvidence: string[];
  knownBoundaries: string[];
  customObservations: string[];
  extensionCandidates: string[];
}

export type CoverageCheckStatus = "pass" | "warn" | "fail" | "missing";

export interface ReadinessRunScenarioInspection {
  name: string;
  status?: string;
  verdict?: string;
  confidence?: string;
  coverage?: string;
  invariantFireCount: number;
  artifactReadability: CoverageCheckStatus;
  stateMovement: CoverageCheckStatus;
  semanticsEvaluated: CoverageCheckStatus;
  simulationResultPath?: string;
  reportPath?: string;
}

export interface ReadinessRunCollectionInspection {
  path: string;
  relativePath: string;
  readable: boolean;
  parseError?: string;
  schemaVersion?: number;
  totalScenarios: number;
  statuses: string[];
  verdicts: string[];
  confidences: string[];
  coverages: string[];
  totalsByStatus: Record<string, number>;
  totalsByVerdict: Record<string, number>;
  totalsByCoverage: Record<string, number>;
  scenarios: ReadinessRunScenarioInspection[];
  evidencePaths: string[];
  hasArtifactReadability: boolean;
  hasStateMovement: boolean;
  hasSemanticsEvaluated: boolean;
}

export interface ReadinessLastRunInspection {
  path: string;
  relativePath: string;
  readable: boolean;
  parseError?: string;
  schemaVersion?: number;
  totalScenarios: number;
  statuses: string[];
}

export interface ReadinessHarnessInspection {
  path: string;
  relativePath: string;
  cargoToml?: ReadinessArtifact;
  rustToolchain?: ReadinessArtifact;
  readme?: ReadinessArtifact;
  sourceEntrypoints: ReadinessArtifact[];
}

export interface ReadinessRiptideInspection {
  present: boolean;
  path?: string;
  adapters: ReadinessAdapterInspection[];
  scenarios: ReadinessArtifact[];
  harnesses: ReadinessHarnessInspection[];
  slices: ReadinessSliceInspection[];
  runCollections: ReadinessRunCollectionInspection[];
  lastRun?: ReadinessLastRunInspection;
  reports: ReadinessArtifact[];
  packs: ReadinessArtifact[];
  manifests: ReadinessArtifact[];
  guidedSimManifests: ReadinessArtifact[];
  replays: ReadinessArtifact[];
  runs: ReadinessArtifact[];
  campaignInputs: ReadinessArtifact[];
}

export interface ReadinessInspection {
  schemaVersion: typeof READINESS_INSPECTION_SCHEMA_VERSION;
  inputPath: string;
  rootPath: string;
  repo: ReadinessRepoMetadata;
  build: ReadinessBuildInspection;
  riptide: ReadinessRiptideInspection;
  warnings: string[];
}

interface InspectionTarget {
  inputPath: string;
  rootPath: string;
  riptidePath?: string;
  exists: boolean;
  isDirectory: boolean;
}

interface FoundPath {
  path: string;
  direntName: string;
}

interface FileSearchOptions {
  maxDepth: number;
  skipDirs?: ReadonlySet<string>;
  include: (filePath: string, basename: string) => boolean;
}

export interface InspectReadinessWorkspaceOptions {
  /**
   * Test seam for repo metadata. Production uses local git commands only;
   * no network operations are performed.
   */
  git?: {
    enabled?: boolean;
  };
  /**
   * Single-repo readiness can inspect local build outputs as support
   * evidence. Corpus readiness disables this so generated-heavy target/
   * trees are not traversed while building launch matrices.
   */
  includeTargetArtifacts?: boolean;
  /**
   * Full adapter validation may read declared IDL lineage. Corpus readiness
   * keeps adapter checks schema-only so generated target/ paths are not opened.
   */
  validateAdapters?: boolean;
}

export async function inspectReadinessWorkspace(
  inputPath: string,
  options: InspectReadinessWorkspaceOptions = {}
): Promise<ReadinessInspection> {
  const target = await resolveInspectionTarget(inputPath);
  const repo = await inspectRepoMetadata(target, options);
  const build = await inspectBuildArtifacts(target.rootPath, options);
  const riptide = await inspectRiptideWorkspace(target.rootPath, target.riptidePath, options);

  return {
    schemaVersion: READINESS_INSPECTION_SCHEMA_VERSION,
    inputPath: target.inputPath,
    rootPath: target.rootPath,
    repo: {
      ...repo,
      stackMarkers: stackMarkers(build, riptide),
    },
    build,
    riptide,
    warnings: [],
  };
}

async function resolveInspectionTarget(inputPath: string): Promise<InspectionTarget> {
  const absoluteInput = path.resolve(inputPath);
  const inputStats = await safeStat(absoluteInput);
  const exists = inputStats !== null;
  const isDirectory = inputStats?.isDirectory() === true;

  if (isDirectory && path.basename(absoluteInput) === ".riptide") {
    return {
      inputPath: absoluteInput,
      rootPath: path.dirname(absoluteInput),
      riptidePath: absoluteInput,
      exists,
      isDirectory,
    };
  }

  const rootPath = exists ? (isDirectory ? absoluteInput : path.dirname(absoluteInput)) : absoluteInput;
  const candidateRiptidePath = path.join(rootPath, ".riptide");
  return {
    inputPath: absoluteInput,
    rootPath,
    riptidePath: existsSync(candidateRiptidePath) ? candidateRiptidePath : undefined,
    exists,
    isDirectory,
  };
}

async function inspectRepoMetadata(
  target: InspectionTarget,
  options: InspectReadinessWorkspaceOptions
): Promise<ReadinessRepoMetadata> {
  const git =
    options.git?.enabled === false
      ? { isGitRepo: false as const }
      : await inspectGitMetadata(target.rootPath);

  return {
    path: target.rootPath,
    exists: target.exists,
    isDirectory: target.isDirectory,
    stackMarkers: [],
    ...git,
  };
}

async function inspectGitMetadata(rootPath: string): Promise<ReadinessGitMetadata> {
  const gitRoot = await gitOutput(rootPath, ["rev-parse", "--show-toplevel"]);
  if (!gitRoot) {
    return { isGitRepo: false };
  }

  const [remoteUrl, branch, commit, status] = await Promise.all([
    gitOutput(rootPath, ["config", "--get", "remote.origin.url"]),
    gitOutput(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitOutput(rootPath, ["rev-parse", "HEAD"]),
    gitOutput(rootPath, ["status", "--short"]),
  ]);

  return {
    isGitRepo: true,
    gitRoot,
    ...(remoteUrl ? { remoteUrl } : {}),
    ...(branch ? { branch } : {}),
    ...(commit ? { commit } : {}),
    dirty: (status ?? "").trim().length > 0,
  };
}

async function gitOutput(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: 2_000,
      maxBuffer: 1024 * 1024,
    });
    const stdout = result.stdout;
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

async function inspectBuildArtifacts(
  rootPath: string,
  options: InspectReadinessWorkspaceOptions
): Promise<ReadinessBuildInspection> {
  const anchorTomlPath = path.join(rootPath, "Anchor.toml");
  const cargoTomlPath = path.join(rootPath, "Cargo.toml");
  const packageJsonPath = path.join(rootPath, "package.json");
  const riptideIdlDir = path.join(rootPath, ".riptide", "idl");
  const fixturesIdlDir = path.join(rootPath, "fixtures", "idls");
  const localIdlDir = path.join(rootPath, "idls");
  const includeTargetArtifacts = options.includeTargetArtifacts !== false;
  const idlDirs = [
    ...(includeTargetArtifacts ? [path.join(rootPath, "target", "idl")] : []),
    riptideIdlDir,
    fixturesIdlDir,
    localIdlDir,
  ];

  const [programSources, idls, programBinaries, tests, migrations, programIds, cargoWorkspace] =
    await Promise.all([
      findFiles(path.join(rootPath, "programs"), {
        maxDepth: 4,
        skipDirs: DEFAULT_SKIP_DIRS,
        include: (filePath, basename) => basename.endsWith(".rs") && filePath.includes(`${path.sep}src${path.sep}`),
      }),
      findAcrossDirs(idlDirs, {
        maxDepth: 2,
        skipDirs: DEFAULT_SKIP_DIRS,
        include: (_filePath, basename) => basename.endsWith(".json"),
      }),
      includeTargetArtifacts
        ? findFiles(path.join(rootPath, "target", "deploy"), {
            maxDepth: 1,
            skipDirs: DEFAULT_SKIP_DIRS,
            include: (_filePath, basename) => basename.endsWith(".so"),
          })
        : Promise.resolve([]),
      findFiles(path.join(rootPath, "tests"), {
        maxDepth: 3,
        skipDirs: DEFAULT_SKIP_DIRS,
        include: (_filePath, basename) =>
          [".ts", ".tsx", ".js", ".mjs", ".rs"].some((ext) => basename.endsWith(ext)),
      }),
      findFiles(path.join(rootPath, "migrations"), {
        maxDepth: 2,
        skipDirs: DEFAULT_SKIP_DIRS,
        include: (_filePath, basename) =>
          [".ts", ".tsx", ".js", ".mjs", ".rs"].some((ext) => basename.endsWith(ext)),
      }),
      readAnchorProgramIds(anchorTomlPath),
      cargoTomlHasWorkspace(cargoTomlPath),
    ]);

  return {
    ...(existsSync(anchorTomlPath)
      ? { anchorToml: artifact("anchor-toml", anchorTomlPath, rootPath) }
      : {}),
    ...(existsSync(cargoTomlPath)
      ? { cargoToml: artifact("cargo-toml", cargoTomlPath, rootPath) }
      : {}),
    cargoWorkspace,
    ...(existsSync(packageJsonPath)
      ? { packageJson: artifact("package-json", packageJsonPath, rootPath) }
      : {}),
    programSources: programSources.map((entry) => artifact("program-source", entry.path, rootPath)),
    idls: idls.map((entry) => artifact("idl", entry.path, rootPath)),
    programBinaries: programBinaries.map((entry) => artifact("program-binary", entry.path, rootPath)),
    tests: tests.map((entry) => artifact("test", entry.path, rootPath)),
    migrations: migrations.map((entry) => artifact("migration", entry.path, rootPath)),
    programIds,
  };
}

async function readAnchorProgramIds(anchorTomlPath: string): Promise<ReadinessProgramId[]> {
  if (!existsSync(anchorTomlPath)) return [];
  try {
    const parsed = TOML.parse(await readFile(anchorTomlPath, "utf8"));
    const root = asRecord(parsed);
    const programs = root ? asRecord(root["programs"]) : null;
    if (!programs) return [];
    const rows: ReadinessProgramId[] = [];
    for (const [cluster, value] of Object.entries(programs).sort(compareEntries)) {
      const table = asRecord(value);
      if (!table) continue;
      for (const [name, programId] of Object.entries(table).sort(compareEntries)) {
        if (typeof programId === "string" && programId.trim().length > 0) {
          rows.push({
            name,
            cluster,
            programId,
            sourcePath: anchorTomlPath,
          });
        }
      }
    }
    return rows;
  } catch {
    return [];
  }
}

async function cargoTomlHasWorkspace(cargoTomlPath: string): Promise<boolean> {
  if (!existsSync(cargoTomlPath)) return false;
  try {
    const parsed = TOML.parse(await readFile(cargoTomlPath, "utf8"));
    const root = asRecord(parsed);
    return root !== null && asRecord(root["workspace"]) !== null;
  } catch {
    return false;
  }
}

async function inspectRiptideWorkspace(
  rootPath: string,
  riptidePath: string | undefined,
  options: InspectReadinessWorkspaceOptions
): Promise<ReadinessRiptideInspection> {
  if (!riptidePath || !existsSync(riptidePath)) {
    return emptyRiptideInspection();
  }

  const [
    adapters,
    scenarios,
    harnesses,
    slices,
    runCollections,
    lastRun,
    reports,
    packs,
    manifests,
    guidedSimManifests,
    replays,
    runs,
    campaignInputs,
  ] = await Promise.all([
    inspectAdapters(rootPath, path.join(riptidePath, "adapters"), options),
    inspectScenarioArtifacts(rootPath, path.join(riptidePath, "scenarios")),
    inspectHarnesses(rootPath, riptidePath),
    inspectSlices(rootPath, path.join(riptidePath, "slices")),
    inspectRunCollections(rootPath, riptidePath),
    inspectLastRun(rootPath, path.join(riptidePath, "last-run.json")),
    inspectReportArtifacts(rootPath, riptidePath),
    inspectPackArtifacts(rootPath, riptidePath),
    inspectManifestArtifacts(rootPath, riptidePath),
    inspectGuidedSimManifests(rootPath, riptidePath),
    inspectReplayArtifacts(rootPath, riptidePath),
    inspectRunDirectories(rootPath, path.join(riptidePath, "runs")),
    inspectCampaignInputs(rootPath, riptidePath),
  ]);

  return {
    present: true,
    path: riptidePath,
    adapters,
    scenarios,
    harnesses,
    slices,
    runCollections,
    ...(lastRun ? { lastRun } : {}),
    reports,
    packs,
    manifests,
    guidedSimManifests,
    replays,
    runs,
    campaignInputs,
  };
}

function emptyRiptideInspection(): ReadinessRiptideInspection {
  return {
    present: false,
    adapters: [],
    scenarios: [],
    harnesses: [],
    slices: [],
    runCollections: [],
    reports: [],
    packs: [],
    manifests: [],
    guidedSimManifests: [],
    replays: [],
    runs: [],
    campaignInputs: [],
  };
}

async function inspectAdapters(
  rootPath: string,
  adaptersDir: string,
  options: InspectReadinessWorkspaceOptions
): Promise<ReadinessAdapterInspection[]> {
  const files = await findFiles(adaptersDir, {
    maxDepth: 1,
    include: (_filePath, basename) => basename.endsWith(".toml"),
  });
  const adapters = await Promise.all(
    files.map((entry) => inspectAdapter(rootPath, entry.path, options))
  );
  return adapters.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
}

async function inspectAdapter(
  rootPath: string,
  adapterPath: string,
  options: InspectReadinessWorkspaceOptions
): Promise<ReadinessAdapterInspection> {
  const name = path.basename(adapterPath, ".toml");
  let raw: string;
  try {
    raw = await readFile(adapterPath, "utf8");
  } catch (err) {
    return {
      name,
      path: adapterPath,
      relativePath: relativeToRoot(rootPath, adapterPath),
      validationStatus: "unreadable",
      validationError: errorMessage(err),
      lineage: { inferredAssumptionCount: 0, unsupportedFieldCount: 0 },
      instructions: [],
      actions: [],
      accounts: [],
      observations: [],
      invariants: [],
      semanticClassSupported: false,
      semanticRoles: [],
      derivedObservations: [],
      expressionInvariants: [],
      collections: [],
      errorRegistry: { present: false, count: 0 },
    };
  }

  let parsed: unknown;
  let validationStatus: AdapterValidationStatus = "valid";
  let validationError: string | undefined;
  try {
    parsed = TOML.parse(raw);
    validateAdapterForInspection(parsed, adapterPath, options);
  } catch (err) {
    validationStatus = "invalid";
    validationError = errorMessage(err);
    if (parsed === undefined) parsed = {};
  }

  return summarizeAdapter(rootPath, adapterPath, name, parsed, validationStatus, validationError, options);
}

function validateAdapterForInspection(
  parsed: unknown,
  adapterPath: string,
  options: InspectReadinessWorkspaceOptions
): void {
  if (options.validateAdapters !== false) {
    validateAdapter(parsed, adapterPath);
    return;
  }

  const result = AdapterSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const key = first?.path.join(".") ?? "";
    throw new Error(
      `${adapterPath}: \`${key || "(root)"}\`: ${first?.message ?? "adapter schema validation failed"}`
    );
  }
}

function summarizeAdapter(
  rootPath: string,
  adapterPath: string,
  name: string,
  raw: unknown,
  validationStatus: AdapterValidationStatus,
  validationError: string | undefined,
  options: InspectReadinessWorkspaceOptions
): ReadinessAdapterInspection {
  const root = asRecord(raw) ?? {};
  const instructions = asRecord(root["instructions"]) ?? {};
  const actionsTable = asRecord(root["actions"]) ?? {};
  const accounts = asRecord(root["accounts"]) ?? {};
  const observations = asRecord(root["observations"]) ?? {};
  const stateMapping = asRecord(root["state_mapping"]) ?? {};
  const semantics = asRecord(root["semantics"]) ?? {};
  const semanticRoles = asRecord(semantics["roles"]) ?? {};
  const derived = asRecord(semantics["derived"]) ?? {};
  const collections = asRecord(semantics["collections"]) ?? {};
  const replay = asRecord(semantics["replay"]) ?? {};
  const semanticInvariantRows = readArray(semantics["invariants"]);
  const legacyInvariantRows = readArray(root["invariants"]);
  const errors = readArray(root["errors"]);
  const lineage = asRecord(root["lineage"]) ?? {};

  const programSo = readString(root["program_so"]);
  const idlPath = readString(root["idl_path"]);
  const idlSource = readString(lineage["idl_source"]);
  const programSoResolved =
    programSo && shouldResolveDeclaredPath(programSo, options)
      ? resolveDeclaredPath(rootPath, adapterPath, programSo)
      : undefined;
  const idlResolved =
    idlPath && shouldResolveDeclaredPath(idlPath, options)
      ? resolveDeclaredPath(rootPath, adapterPath, idlPath)
      : undefined;
  const idlSourceResolved =
    idlSource && shouldResolveDeclaredPath(idlSource, options)
      ? resolveDeclaredPath(rootPath, adapterPath, idlSource)
      : undefined;
  const programSoInspectable = inspectableDeclaredPath(rootPath, programSoResolved, options);
  const idlInspectable = inspectableDeclaredPath(rootPath, idlResolved, options);
  const idlSourceInspectable = inspectableDeclaredPath(rootPath, idlSourceResolved, options);
  const semanticClass = readString(semantics["class"]);
  const instructionActions = Object.values(instructions)
    .map((value) => readString(asRecord(value)?.["action"]))
    .filter(isString);
  const stateMappingObservations = Object.values(stateMapping).filter(isString);

  const expressionInvariantNames = semanticInvariantRows
    .map((value, index) => readString(asRecord(value)?.["name"]) ?? `semantic-invariant-${index}`)
    .sort(compareStrings);
  const legacyInvariantNames = legacyInvariantRows
    .map((value, index) => readString(asRecord(value)?.["name"]) ?? `invariant-${index}`)
    .sort(compareStrings);

  return {
    name,
    path: adapterPath,
    relativePath: relativeToRoot(rootPath, adapterPath),
    validationStatus,
    ...(validationError ? { validationError } : {}),
    ...(readString(root["protocol"]) ? { protocol: readString(root["protocol"]) } : {}),
    ...(inferRuntime(root) ? { runtime: inferRuntime(root) } : {}),
    ...(programSo ? { programSo } : {}),
    ...(programSoInspectable ? { programSoPath: programSoInspectable } : {}),
    ...(programSoInspectable ? { programSoExists: existsSync(programSoInspectable) } : {}),
    ...(readString(root["program_id"]) ? { programId: readString(root["program_id"]) } : {}),
    ...(idlPath ? { idlPath } : {}),
    ...(idlInspectable ? { idlResolvedPath: idlInspectable } : {}),
    ...(idlInspectable ? { idlExists: existsSync(idlInspectable) } : {}),
    lineage: {
      ...(idlSource ? { idlSource } : {}),
      ...(idlSourceInspectable ? { idlSourcePath: idlSourceInspectable } : {}),
      ...(idlSourceInspectable ? { idlSourceExists: existsSync(idlSourceInspectable) } : {}),
      ...(readString(lineage["generator"]) ? { generator: readString(lineage["generator"]) } : {}),
      inferredAssumptionCount: readArray(lineage["inferred_assumptions"]).length,
      unsupportedFieldCount: readArray(lineage["unsupported_fields"]).length,
    },
    instructions: Object.keys(instructions).sort(compareStrings),
    actions: uniqueSorted([...Object.keys(actionsTable), ...instructionActions]),
    accounts: Object.keys(accounts).sort(compareStrings),
    observations: uniqueSorted([...Object.keys(observations), ...stateMappingObservations]),
    invariants: uniqueSorted([...legacyInvariantNames, ...expressionInvariantNames]),
    ...(semanticClass ? { semanticClass } : {}),
    semanticClassSupported: semanticClass !== undefined && isSupportedSemanticClass(semanticClass),
    semanticRoles: Object.keys(semanticRoles).sort(compareStrings),
    derivedObservations: Object.keys(derived).sort(compareStrings),
    expressionInvariants: expressionInvariantNames,
    collections: Object.keys(collections).sort(compareStrings),
    ...(readString(replay["state_source"]) ? { replayStateSource: readString(replay["state_source"]) } : {}),
    ...(readString(replay["pack_path"]) ? { replayPackPath: readString(replay["pack_path"]) } : {}),
    errorRegistry: {
      present: errors.length > 0,
      count: errors.length,
    },
  };
}

function inferRuntime(root: Record<string, unknown>): string | undefined {
  const programSo = readString(root["program_so"]);
  const idlPath = readString(root["idl_path"]);
  if (programSo && idlPath) return "generic";
  return readString(root["protocol"]);
}

async function inspectScenarioArtifacts(
  rootPath: string,
  scenariosDir: string
): Promise<ReadinessArtifact[]> {
  const files = await findFiles(scenariosDir, {
    maxDepth: 5,
    skipDirs: DEFAULT_SKIP_DIRS,
    include: (_filePath, basename) =>
      [".toml", ".json", ".yaml", ".yml"].some((ext) => basename.endsWith(ext)),
  });
  return files.map((entry) => artifact("scenario", entry.path, rootPath));
}

async function inspectHarnesses(
  rootPath: string,
  riptidePath: string
): Promise<ReadinessHarnessInspection[]> {
  const harnessDir = path.join(riptidePath, "harness");
  if (!existsSync(harnessDir)) return [];
  const sourceEntrypoints = await findFiles(path.join(harnessDir, "src"), {
    maxDepth: 2,
    skipDirs: DEFAULT_SKIP_DIRS,
    include: (_filePath, basename) => basename.endsWith(".rs"),
  });
  const cargoToml = path.join(harnessDir, "Cargo.toml");
  const rustToolchain = path.join(harnessDir, "rust-toolchain.toml");
  const readme = path.join(harnessDir, "README.md");
  return [
    {
      path: harnessDir,
      relativePath: relativeToRoot(rootPath, harnessDir),
      ...(existsSync(cargoToml) ? { cargoToml: artifact("harness", cargoToml, rootPath) } : {}),
      ...(existsSync(rustToolchain)
        ? { rustToolchain: artifact("harness", rustToolchain, rootPath) }
        : {}),
      ...(existsSync(readme) ? { readme: artifact("harness", readme, rootPath) } : {}),
      sourceEntrypoints: sourceEntrypoints.map((entry) => artifact("harness", entry.path, rootPath)),
    },
  ];
}

async function inspectSlices(rootPath: string, slicesDir: string): Promise<ReadinessSliceInspection[]> {
  const files = await findFiles(slicesDir, {
    maxDepth: 1,
    include: (_filePath, basename) => basename.endsWith(".toml"),
  });
  const slices = await Promise.all(files.map((entry) => inspectSlice(rootPath, entry.path)));
  return slices.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
}

async function inspectSlice(rootPath: string, slicePath: string): Promise<ReadinessSliceInspection> {
  const fallbackName = path.basename(slicePath, ".toml");
  let raw: string;
  try {
    raw = await readFile(slicePath, "utf8");
  } catch (err) {
    return {
      name: fallbackName,
      path: slicePath,
      relativePath: relativeToRoot(rootPath, slicePath),
      validationStatus: "unreadable",
      validationError: errorMessage(err),
      actions: [],
      accounts: [],
      observations: [],
      invariants: [],
      scenarios: [],
      runEvidence: [],
      runEvidencePaths: [],
      missingRunEvidence: [],
      knownBoundaries: [],
      customObservations: [],
      extensionCandidates: [],
    };
  }

  try {
    return summarizeValidSlice(rootPath, slicePath, parseSliceManifestToml(raw, slicePath));
  } catch (err) {
    return {
      name: fallbackName,
      path: slicePath,
      relativePath: relativeToRoot(rootPath, slicePath),
      validationStatus: "invalid",
      validationError:
        err instanceof SliceManifestValidationError ? err.message : errorMessage(err),
      actions: [],
      accounts: [],
      observations: [],
      invariants: [],
      scenarios: [],
      runEvidence: [],
      runEvidencePaths: [],
      missingRunEvidence: [],
      knownBoundaries: [],
      customObservations: [],
      extensionCandidates: [],
    };
  }
}

function summarizeValidSlice(
  rootPath: string,
  slicePath: string,
  manifest: SliceManifest
): ReadinessSliceInspection {
  const existingEvidence: ReadinessArtifact[] = [];
  const missingEvidence: string[] = [];
  for (const declared of manifest.runEvidence) {
    const resolved = path.isAbsolute(declared) ? declared : path.resolve(rootPath, declared);
    if (existsSync(resolved)) {
      existingEvidence.push(artifact("run-collection", resolved, rootPath));
    } else {
      missingEvidence.push(declared);
    }
  }

  return {
    name: manifest.name,
    path: slicePath,
    relativePath: relativeToRoot(rootPath, slicePath),
    validationStatus: "valid",
    class: manifest.class,
    supportLevelTarget: manifest.supportLevelTarget,
    actions: [...manifest.actions].sort(compareStrings),
    accounts: [...manifest.accounts].sort(compareStrings),
    observations: [...manifest.observations].sort(compareStrings),
    invariants: [...manifest.invariants].sort(compareStrings),
    scenarios: [...manifest.scenarios].sort(compareStrings),
    runEvidence: [...manifest.runEvidence].sort(compareStrings),
    runEvidencePaths: existingEvidence,
    missingRunEvidence: missingEvidence.sort(compareStrings),
    knownBoundaries: [...manifest.knownBoundaries].sort(compareStrings),
    customObservations: manifest.customObservations
      .map((entry) => entry.name)
      .sort(compareStrings),
    extensionCandidates: manifest.extensionCandidates
      .map((entry) => entry.name)
      .sort(compareStrings),
  };
}

async function inspectRunCollections(
  rootPath: string,
  riptidePath: string
): Promise<ReadinessRunCollectionInspection[]> {
  const candidates = uniqueSorted([
    path.join(riptidePath, "run-collection.json"),
    ...(
      await findFiles(path.join(riptidePath, "runs"), {
        maxDepth: 5,
        skipDirs: DEFAULT_SKIP_DIRS,
        include: (_filePath, basename) => basename === "run-collection.json",
      })
    ).map((entry) => entry.path),
  ]).filter((candidate) => existsSync(candidate));

  const collections = await Promise.all(
    candidates.map((candidate) => inspectRunCollection(rootPath, candidate))
  );
  return collections.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
}

async function inspectRunCollection(
  rootPath: string,
  collectionPath: string
): Promise<ReadinessRunCollectionInspection> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(collectionPath, "utf8"));
  } catch (err) {
    return {
      path: collectionPath,
      relativePath: relativeToRoot(rootPath, collectionPath),
      readable: false,
      parseError: errorMessage(err),
      totalScenarios: 0,
      statuses: [],
      verdicts: [],
      confidences: [],
      coverages: [],
      totalsByStatus: {},
      totalsByVerdict: {},
      totalsByCoverage: {},
      scenarios: [],
      evidencePaths: [],
      hasArtifactReadability: false,
      hasStateMovement: false,
      hasSemanticsEvaluated: false,
    };
  }

  const root = asRecord(parsed) ?? {};
  const scenarioRows = readArray(root["scenarios"]);
  const scenarios = scenarioRows.map((value, index) =>
    summarizeRunScenario(value, index)
  );
  const evidencePaths = uniqueSorted(
    scenarios.flatMap((scenario) => [
      ...(scenario.simulationResultPath ? [scenario.simulationResultPath] : []),
      ...(scenario.reportPath ? [scenario.reportPath] : []),
    ])
  );

  return {
    path: collectionPath,
    relativePath: relativeToRoot(rootPath, collectionPath),
    readable: true,
    ...(readNumber(root["schema_version"]) !== undefined
      ? { schemaVersion: readNumber(root["schema_version"]) }
      : {}),
    totalScenarios: readNumber(root["total_scenarios"]) ?? scenarios.length,
    statuses: uniqueSorted(scenarios.map((scenario) => scenario.status).filter(isString)),
    verdicts: uniqueSorted(scenarios.map((scenario) => scenario.verdict).filter(isString)),
    confidences: uniqueSorted(scenarios.map((scenario) => scenario.confidence).filter(isString)),
    coverages: uniqueSorted(scenarios.map((scenario) => scenario.coverage).filter(isString)),
    totalsByStatus: readNumberRecord(root["totals_by_status"]),
    totalsByVerdict: readNumberRecord(root["totals_by_verdict"]),
    totalsByCoverage: readNumberRecord(root["totals_by_coverage"]),
    scenarios: scenarios.sort((left, right) => compareStrings(left.name, right.name)),
    evidencePaths,
    hasArtifactReadability: scenarios.some((scenario) => scenario.artifactReadability === "pass"),
    hasStateMovement: scenarios.some((scenario) => scenario.stateMovement === "pass"),
    hasSemanticsEvaluated: scenarios.some((scenario) => scenario.semanticsEvaluated === "pass"),
  };
}

function summarizeRunScenario(raw: unknown, index: number): ReadinessRunScenarioInspection {
  const scenario = asRecord(raw) ?? {};
  const interpretation = asRecord(scenario["interpretation"]) ?? {};
  const checks = [
    ...readArray(interpretation["coverage_checks"]),
    ...readArray(scenario["coverage_checks"]),
  ];
  return {
    name: readString(scenario["name"]) ?? `scenario-${index}`,
    ...(readString(scenario["status"]) ? { status: readString(scenario["status"]) } : {}),
    ...(readString(interpretation["verdict"]) ? { verdict: readString(interpretation["verdict"]) } : {}),
    ...(readString(interpretation["confidence"])
      ? { confidence: readString(interpretation["confidence"]) }
      : {}),
    ...(readString(interpretation["coverage"]) ? { coverage: readString(interpretation["coverage"]) } : {}),
    invariantFireCount: readNumber(scenario["invariant_fire_count"]) ?? readArray(scenario["invariant_fires"]).length,
    artifactReadability: coverageStatus(checks, "artifact_readability"),
    stateMovement: coverageStatus(checks, "state_movement"),
    semanticsEvaluated: coverageStatus(checks, "semantics_evaluated"),
    ...(readString(scenario["simulation_result_path"])
      ? { simulationResultPath: readString(scenario["simulation_result_path"]) }
      : {}),
    ...(readString(scenario["report_path"]) ? { reportPath: readString(scenario["report_path"]) } : {}),
  };
}

function coverageStatus(checks: unknown[], name: string): CoverageCheckStatus {
  for (const check of checks) {
    const record = asRecord(check);
    if (!record) continue;
    if (readString(record["name"]) !== name) continue;
    const status = readString(record["status"]);
    if (status === "pass" || status === "warn" || status === "fail") return status;
  }
  return "missing";
}

async function inspectLastRun(
  rootPath: string,
  lastRunPath: string
): Promise<ReadinessLastRunInspection | undefined> {
  if (!existsSync(lastRunPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(lastRunPath, "utf8"));
  } catch (err) {
    return {
      path: lastRunPath,
      relativePath: relativeToRoot(rootPath, lastRunPath),
      readable: false,
      parseError: errorMessage(err),
      totalScenarios: 0,
      statuses: [],
    };
  }
  const root = asRecord(parsed) ?? {};
  const scenarios = readArray(root["scenarios"]);
  const statuses = uniqueSorted(
    scenarios.map((scenario) => readString(asRecord(scenario)?.["status"])).filter(isString)
  );
  return {
    path: lastRunPath,
    relativePath: relativeToRoot(rootPath, lastRunPath),
    readable: true,
    ...(readNumber(root["schema_version"]) !== undefined
      ? { schemaVersion: readNumber(root["schema_version"]) }
      : {}),
    totalScenarios: scenarios.length,
    statuses,
  };
}

async function inspectReportArtifacts(
  rootPath: string,
  riptidePath: string
): Promise<ReadinessArtifact[]> {
  const files = await findFiles(riptidePath, {
    maxDepth: 5,
    skipDirs: new Set([...DEFAULT_SKIP_DIRS, "harness"]),
    include: (_filePath, basename) =>
      basename === "report.md" || basename === "sweep-report.md" || basename.endsWith(".report.md"),
  });
  return files.map((entry) => artifact("report", entry.path, rootPath));
}

async function inspectPackArtifacts(
  rootPath: string,
  riptidePath: string
): Promise<ReadinessArtifact[]> {
  const files = await findAcrossDirs([path.join(riptidePath, "pack"), path.join(riptidePath, "packs")], {
    maxDepth: 3,
    skipDirs: DEFAULT_SKIP_DIRS,
    include: (_filePath, basename) => basename === "manifest.json",
  });
  return files.map((entry) => artifact("pack", entry.path, rootPath));
}

async function inspectManifestArtifacts(
  rootPath: string,
  riptidePath: string
): Promise<ReadinessArtifact[]> {
  const files = await findFiles(riptidePath, {
    maxDepth: 4,
    skipDirs: new Set([...DEFAULT_SKIP_DIRS, "harness"]),
    include: (_filePath, basename) =>
      basename === "manifest.json" ||
      basename === "slice-manifest.toml" ||
      basename === "run-manifest.json",
  });
  return files.map((entry) => artifact("manifest", entry.path, rootPath));
}

async function inspectGuidedSimManifests(
  rootPath: string,
  riptidePath: string
): Promise<ReadinessArtifact[]> {
  const files = await findFiles(path.join(riptidePath, "sim"), {
    maxDepth: 2,
    skipDirs: DEFAULT_SKIP_DIRS,
    include: (_filePath, basename) => basename === "Riptide.toml",
  });
  return files.map((entry) => artifact("guided-sim-manifest", entry.path, rootPath));
}

async function inspectReplayArtifacts(
  rootPath: string,
  riptidePath: string
): Promise<ReadinessArtifact[]> {
  const files = await findFiles(path.join(riptidePath, "replays"), {
    maxDepth: 4,
    skipDirs: DEFAULT_SKIP_DIRS,
    include: (_filePath, basename) =>
      [".json", ".toml", ".md"].some((ext) => basename.endsWith(ext)),
  });
  return files.map((entry) => artifact("replay", entry.path, rootPath));
}

async function inspectRunDirectories(rootPath: string, runsDir: string): Promise<ReadinessArtifact[]> {
  const files = await findFiles(runsDir, {
    maxDepth: 4,
    skipDirs: DEFAULT_SKIP_DIRS,
    include: (_filePath, basename) =>
      basename === "simulation-result.json" ||
      basename === "run-config.json" ||
      basename === "sweep-summary.json",
  });
  return files.map((entry) => artifact("run", entry.path, rootPath));
}

async function inspectCampaignInputs(
  rootPath: string,
  riptidePath: string
): Promise<ReadinessArtifact[]> {
  const files = await findAcrossDirs([riptidePath, path.join(riptidePath, "campaigns")], {
    maxDepth: 2,
    skipDirs: DEFAULT_SKIP_DIRS,
    include: (_filePath, basename) =>
      basename === "campaign.toml" ||
      basename === "campaign.json" ||
      basename.endsWith(".campaign.toml") ||
      basename.endsWith(".campaign.json"),
  });
  return files.map((entry) => artifact("campaign-input", entry.path, rootPath));
}

function stackMarkers(
  build: ReadinessBuildInspection,
  riptide: ReadinessRiptideInspection
): string[] {
  const markers = new Set<string>();
  if (build.anchorToml) markers.add("anchor");
  if (build.cargoToml) markers.add(build.cargoWorkspace ? "rust-workspace" : "rust-crate");
  if (build.packageJson) markers.add("node");
  if (build.programSources.length > 0) markers.add("solana-program-sources");
  if (build.idls.length > 0) markers.add("idl-artifacts");
  if (build.programBinaries.length > 0) markers.add("sbf-program-binaries");
  if (build.tests.length > 0) markers.add("tests");
  if (build.migrations.length > 0) markers.add("anchor-migrations");
  if (riptide.present) markers.add("riptide-workspace");
  if (riptide.adapters.length > 0) markers.add("riptide-adapters");
  if (riptide.runCollections.length > 0) markers.add("riptide-run-evidence");
  if (riptide.slices.length > 0) markers.add("riptide-slices");
  return [...markers].sort(compareStrings);
}

async function findAcrossDirs(
  dirs: string[],
  options: FileSearchOptions
): Promise<FoundPath[]> {
  const found = (
    await Promise.all(dirs.map((dir) => findFiles(dir, options)))
  ).flat();
  const byPath = new Map<string, FoundPath>();
  for (const entry of found) byPath.set(entry.path, entry);
  return [...byPath.values()].sort((left, right) => compareStrings(left.path, right.path));
}

async function findFiles(root: string, options: FileSearchOptions): Promise<FoundPath[]> {
  const rootStats = await safeStat(root);
  if (!rootStats?.isDirectory()) return [];
  const found: FoundPath[] = [];

  async function walk(dir: string, depthRemaining: number): Promise<void> {
    if (depthRemaining < 0) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => compareStrings(left.name, right.name));
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (options.skipDirs?.has(entry.name)) continue;
        await walk(child, depthRemaining - 1);
      } else if (entry.isFile() && options.include(child, entry.name)) {
        found.push({ path: child, direntName: entry.name });
      }
    }
  }

  await walk(root, options.maxDepth);
  return found.sort((left, right) => compareStrings(left.path, right.path));
}

async function safeStat(filePath: string): Promise<import("node:fs").Stats | null> {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

function artifact(kind: ArtifactKind, filePath: string, rootPath: string): ReadinessArtifact {
  return {
    kind,
    path: filePath,
    relativePath: relativeToRoot(rootPath, filePath),
  };
}

function relativeToRoot(rootPath: string, filePath: string): string {
  const relative = path.relative(rootPath, filePath);
  if (relative === "") return ".";
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  return filePath;
}

function resolveDeclaredPath(rootPath: string, declaringFilePath: string, declared: string): string {
  if (path.isAbsolute(declared)) return declared;
  const adapterRelative = path.resolve(path.dirname(declaringFilePath), declared);
  if (existsSync(adapterRelative)) return adapterRelative;
  return path.resolve(rootPath, declared);
}

function shouldResolveDeclaredPath(
  declared: string,
  options: InspectReadinessWorkspaceOptions
): boolean {
  if (options.includeTargetArtifacts !== false) return true;
  return !declared
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0)
    .some((segment) => DEFAULT_SKIP_DIRS.has(segment));
}

function inspectableDeclaredPath(
  rootPath: string,
  resolvedPath: string | undefined,
  options: InspectReadinessWorkspaceOptions
): string | undefined {
  if (!resolvedPath) return undefined;
  if (options.includeTargetArtifacts !== false) return resolvedPath;
  return isUnderSkippedRepoDir(rootPath, resolvedPath) ? undefined : resolvedPath;
}

function isUnderSkippedRepoDir(rootPath: string, filePath: string): boolean {
  const relative = path.relative(rootPath, filePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  return relative.split(path.sep).some((segment) => DEFAULT_SKIP_DIRS.has(segment));
}

function readNumberRecord(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, number> = {};
  for (const [key, child] of Object.entries(record).sort(compareEntries)) {
    if (typeof child === "number" && Number.isFinite(child)) out[key] = child;
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function compareEntries(left: [string, unknown], right: [string, unknown]): number {
  return compareStrings(left[0], right[0]);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const DEFAULT_SKIP_DIRS = new Set([
  ".git",
  "case-study-readiness",
  "dist",
  "node_modules",
  "reports",
  "target",
]);
