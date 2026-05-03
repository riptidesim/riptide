import {
  SEMANTIC_CLASS_REQUIREMENTS,
  SUPPORTED_SEMANTIC_CLASSES,
  type SemanticClass,
} from "../schemas/adapter.js";
import type { ReadinessSemanticHygieneFinding } from "./model.js";

export type SemanticConceptLocation =
  | "core_semantics"
  | "adapter"
  | "custom_observations"
  | "slice_manifest"
  | "extension_candidates";

export interface SemanticConceptInput {
  name: string;
  description?: string;
  semanticClass?: SemanticClass;
  requestedLocation?: SemanticConceptLocation;
  reuseEvidence?: string[];
}

export interface SemanticConceptClassification extends ReadinessSemanticHygieneFinding {
  protocolSpecific: boolean;
  reusableAcrossProtocols: boolean;
}

export interface SemanticHygieneValidation {
  findings: SemanticConceptClassification[];
  errors: SemanticConceptClassification[];
}

const PROTOCOL_SPECIFIC_PATTERNS = [
  /\bmarinade\b/i,
  /\bmango\b/i,
  /\bdrift\b/i,
  /\borca\b/i,
  /\bloopscale\b/i,
  /\bkamino\b/i,
  /\bsolend\b/i,
  /\bwhirlpool\b/i,
  /\bhealth[_ -]?cache\b/i,
  /\bvalidator[_ -]?account/i,
  /\bvalidator[_ -]?score\b/i,
  /\bopen[_ -]?orders\b/i,
  /\bserum[_ -]?market\b/i,
];

const REUSABLE_STRUCTURAL_PATTERNS = [
  /\bclmm\b/i,
  /\bconcentrated[_ -]?liquidity\b/i,
  /\btick[_ -]?array\b/i,
  /\btick[_ -]?range\b/i,
  /\brange[_ -]?liquidity\b/i,
];

export function classifySemanticConcept(
  concept: SemanticConceptInput
): SemanticConceptClassification {
  const text = conceptText(concept);
  const protocolSpecific = PROTOCOL_SPECIFIC_PATTERNS.some((pattern) => pattern.test(text));
  const reusableAcrossProtocols = hasReusableEvidence(concept.reuseEvidence);
  const structural = REUSABLE_STRUCTURAL_PATTERNS.some((pattern) => pattern.test(text));
  const coreObservation = concept.semanticClass
    ? isCoreSemanticObservation(concept.semanticClass, concept.name)
    : isKnownCoreSemanticName(concept.name);

  if (coreObservation && !protocolSpecific) {
    return {
      concept: concept.name,
      classification: "core",
      severity: "info",
      message: `${concept.name} is already part of the supported generic semantic surface.`,
      recommendedLocation: "core_semantics",
      protocolSpecific,
      reusableAcrossProtocols,
    };
  }

  if (protocolSpecific) {
    const requestedCore = concept.requestedLocation === "core_semantics";
    return {
      concept: concept.name,
      classification: concept.requestedLocation === "custom_observations"
        ? "custom_observation"
        : concept.requestedLocation === "adapter"
          ? "adapter"
          : "slice_manifest",
      severity: requestedCore ? "error" : "warn",
      message:
        `${concept.name} looks protocol-specific; keep it in an adapter mapping, ` +
        "custom observation, or slice manifest instead of adding it to core semantics.",
      recommendedLocation: concept.requestedLocation === "custom_observations"
        ? "custom_observations"
        : concept.requestedLocation === "adapter"
          ? "adapter"
          : "slice_manifest",
      protocolSpecific,
      reusableAcrossProtocols,
    };
  }

  if (structural && reusableAcrossProtocols) {
    return {
      concept: concept.name,
      classification: "extension_candidate",
      severity: "info",
      message:
        `${concept.name} describes a structural pattern repeated across protocols; ` +
        "record it as a reusable extension candidate before promoting it to core semantics.",
      recommendedLocation: "extension_candidates",
      protocolSpecific,
      reusableAcrossProtocols,
    };
  }

  return {
    concept: concept.name,
    classification: concept.requestedLocation === "adapter"
      ? "adapter"
      : concept.requestedLocation === "custom_observations"
        ? "custom_observation"
        : "slice_manifest",
    severity: concept.requestedLocation === "core_semantics" ? "error" : "warn",
    message:
      `${concept.name} is not part of ${SUPPORTED_SEMANTIC_CLASSES.join(", ")}; ` +
      "keep it out of core semantics until repeated structural reuse is demonstrated.",
    recommendedLocation: concept.requestedLocation === "adapter"
      ? "adapter"
      : concept.requestedLocation === "custom_observations"
        ? "custom_observations"
        : "slice_manifest",
    protocolSpecific,
    reusableAcrossProtocols,
  };
}

export function validateSemanticHygiene(
  concepts: SemanticConceptInput[]
): SemanticHygieneValidation {
  const findings = concepts.map(classifySemanticConcept);
  return {
    findings,
    errors: findings.filter((finding) => finding.severity === "error"),
  };
}

export function isCoreSemanticObservation(
  semanticClass: SemanticClass,
  observation: string
): boolean {
  const localName = stripSemanticClassPrefix(observation, semanticClass);
  const requirements = SEMANTIC_CLASS_REQUIREMENTS[semanticClass];
  return (requirements.requiredDerived as readonly string[]).includes(localName);
}

export function hasProtocolSpecificSemanticBloat(value: string): boolean {
  return PROTOCOL_SPECIFIC_PATTERNS.some((pattern) => pattern.test(value));
}

function isKnownCoreSemanticName(value: string): boolean {
  const localName = value.includes(".") ? value.slice(value.lastIndexOf(".") + 1) : value;
  return Object.values(SEMANTIC_CLASS_REQUIREMENTS).some((requirements) =>
    (requirements.requiredDerived as readonly string[]).includes(localName) ||
    (requirements.requiredRoles as readonly string[]).includes(localName)
  );
}

function stripSemanticClassPrefix(value: string, semanticClass: SemanticClass): string {
  const prefix = `${semanticClass}.`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function conceptText(concept: SemanticConceptInput): string {
  return [concept.name, concept.description ?? "", ...(concept.reuseEvidence ?? [])].join(" ");
}

function hasReusableEvidence(values: string[] | undefined): boolean {
  if (!values || values.length < 2) return false;
  const families = new Set<string>();
  for (const value of values) {
    const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (normalized.length > 0) families.add(normalized);
  }
  return families.size >= 2;
}
