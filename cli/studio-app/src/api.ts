// Thin typed wrappers over the localhost Studio API.

export type Protocol = "amm" | "lending" | "perpetuals" | "liquid-staking" | "stablecoin" | "custom";

export interface ProtocolChoice {
  value: Protocol;
  label: string;
}

export interface AgentProbe {
  id: string;
  label: string;
  binary: string;
  recommended: boolean;
  detected: boolean;
  version: string | null;
  path: string | null;
}

export interface StudioWorkspace {
  id: string;
  label: string;
  source: "current" | "case-study";
  path: string;
  riptide_path: string;
  has_riptide: boolean;
  warnings: { message: string; next_action: string }[];
}

export type DetectSource = "anchor" | "cargo-workspace" | "cargo-package";

export interface DetectedCandidate {
  programName: string;
  source: DetectSource;
  manifestPath: string;
}

export interface ProgramDetection {
  schema_version: "studio-detect-program.v1";
  programName: string | null;
  source: DetectSource | null;
  manifestPath: string | null;
  candidates: DetectedCandidate[];
}

export interface InitRequest {
  programName: string;
  protocol: Protocol;
}

export interface InitResponse {
  schema_version: "studio-init.v1";
  program_name: string;
  protocol: Protocol;
  created: string[];
  warnings: string[];
  workspaces: StudioWorkspace[];
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly payload: unknown, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  });
  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "message" in (body as Record<string, unknown>)
        ? String((body as Record<string, unknown>).message)
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, body, msg);
  }
  return body as T;
}

export const api = {
  workspaces: () =>
    request<{ schema_version: "studio-workspaces.v1"; workspaces: StudioWorkspace[] }>("/api/studio/workspaces"),
  agents: () =>
    request<{ schema_version: "studio-agents.v1"; agents: AgentProbe[] }>("/api/studio/agents"),
  protocols: () =>
    request<{ schema_version: "studio-protocols.v1"; protocols: ProtocolChoice[] }>("/api/studio/protocols"),
  detectProgram: () => request<ProgramDetection>("/api/studio/detect-program"),
  init: (body: InitRequest) =>
    request<InitResponse>("/api/studio/init", {
      method: "POST",
      body: JSON.stringify({ program_name: body.programName, protocol: body.protocol })
    })
};
