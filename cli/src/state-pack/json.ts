import crypto from "node:crypto";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function canonicalJson(value: JsonValue): string {
  return stableStringify(value) + "\n";
}

export function sha256Hex(bytes: string | Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function stableStringify(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`cannot serialize non-finite JSON number ${value}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key]!)}`)
    .join(",")}}`;
}
