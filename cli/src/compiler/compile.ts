import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import TOML from "toml";

import { getFallbackPolicy } from "./fallback.js";
import { validatePolicy, type Policy } from "./schema.js";

interface PersonaDescription {
  persona_id: string;
  persona_label: string;
  description: string;
  risk_posture: string;
}

interface CompileOptions {
  llmUrl?: string;
  fetchImpl?: typeof fetch;
  llmTimeoutMs?: number;
  warn?: (message: string) => void;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PERSONA_DIR_CANDIDATES = [
  path.resolve(MODULE_DIR, "personas"),
  path.resolve(MODULE_DIR, "../../../src/compiler/personas")
];
const DEFAULT_LLM_TIMEOUT_MS = 30_000;
const POLICY_PROMPT_SCHEMA = {
  persona_id: "persona-id",
  persona_label: "Persona Label",
  risk_tolerance: 0.5,
  action_weights: {
    deposit: 0.8,
    withdraw: 0.3,
    borrow: 0.2,
    repay: 0.6,
    liquidate: 0.1
  },
  triggers: [
    {
      condition: {
        type: "portfolio_drawdown",
        threshold: 0.2
      },
      response: "reduce_exposure",
      severity: 7,
      cooldown_ticks: 3
    }
  ],
  position_sizing: {
    strategy: "fixed",
    params: {
      amount: 100
    }
  },
  max_exposure: 0.5
};

let personaDirPromise: Promise<string> | undefined;

export async function compilePersonas(personaIds: string[], options: CompileOptions = {}): Promise<Policy[]> {
  const warn = options.warn ?? console.warn;
  if (!options.llmUrl) {
    warn("LLM unavailable — using default policies");
    return personaIds.map(getFallbackPolicy);
  }

  const personas = await Promise.all(personaIds.map(loadPersonaDescription));
  return Promise.all(
    personas.map(async (persona) => {
      try {
        return await compilePersona(persona, options);
      } catch (error) {
        warn(`Falling back for ${persona.persona_id}: ${(error as Error).message}`);
        return getFallbackPolicy(persona.persona_id);
      }
    })
  );
}

export async function loadPersonaDescription(personaId: string): Promise<PersonaDescription> {
  const raw = await readFile(path.join(await getPersonaDir(), `${personaId}.toml`), "utf8");
  return TOML.parse(raw) as PersonaDescription;
}

async function compilePersona(persona: PersonaDescription, options: CompileOptions): Promise<Policy> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const prompt = buildPrompt(persona);
  const timeoutMs = options.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const first = await requestPolicy(fetchImpl, options.llmUrl!, prompt, timeoutMs);

  try {
    return validatePolicy(repairJson(first));
  } catch (error) {
    const retry = await requestPolicy(
      fetchImpl,
      options.llmUrl!,
      `${prompt}\nReturn valid JSON only. Do not wrap the response in markdown fences or prose.`,
      timeoutMs
    );

    try {
      return validatePolicy(repairJson(retry));
    } catch (retryError) {
      throw new Error(
        `Policy compilation failed after retry: ${(retryError as Error).message} (initial parse: ${(error as Error).message})`
      );
    }
  }
}

async function requestPolicy(
  fetchImpl: typeof fetch,
  llmUrl: string,
  prompt: string,
  timeoutMs: number
): Promise<string> {
  const response = await fetchImpl(llmUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: "riptide-persona-compiler",
      messages: [
        {
          role: "system",
          content: "You are a persona compiler. Respond with JSON only."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`LLM request failed with ${response.status}`);
  }

  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM response missing content");
  }
  return content;
}

function buildPrompt(persona: PersonaDescription): string {
  return [
    `Persona ID: ${persona.persona_id}`,
    `Persona Label: ${persona.persona_label}`,
    `Description: ${persona.description}`,
    `Risk Posture: ${persona.risk_posture}`,
    "Return a Policy JSON object matching this schema:",
    JSON.stringify(POLICY_PROMPT_SCHEMA, null, 2),
    "Use TriggerCondition variants only from: portfolio_drawdown, utilization_above, price_drop_percent, exposure_above, health_factor_below.",
    "Example fallback:",
    JSON.stringify(getFallbackPolicy(persona.persona_id), null, 2)
  ].join("\n");
}

export function repairJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const cleaned = (fenced?.[1] ?? raw).trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const candidate = extractFirstJsonObject(cleaned);
    if (candidate) {
      return JSON.parse(candidate);
    }
    throw new Error("Unable to repair JSON");
  }
}

function extractFirstJsonObject(input: string): string | undefined {
  let start = -1;
  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (start < 0) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (isEscaped) {
      isEscaped = false;
      continue;
    }

    if (char === "\\") {
      isEscaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return input.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

async function getPersonaDir(): Promise<string> {
  personaDirPromise ??= resolvePersonaDir().catch((error) => {
    personaDirPromise = undefined;
    throw error;
  });
  return personaDirPromise;
}

async function resolvePersonaDir(): Promise<string> {
  for (const candidate of PERSONA_DIR_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error(
    `Persona directory not found. Checked: ${PERSONA_DIR_CANDIDATES.join(", ")}`
  );
}
