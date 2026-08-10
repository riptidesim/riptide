// IDL facts `riptide init` needs to write a defaulted adapter.
//
// This is deliberately narrower than `cli/src/sim/idl.ts` (codegen) and
// `cli/src/lint/index.ts` (cross-checking): init only needs the declared
// facts that let it decide what it may write down without inventing
// anything — instruction account slots, argument types, account field
// layouts, and whether a struct has a fixed Borsh size.
//
// Every helper here answers "what did the IDL declare?" and returns
// `undefined` rather than a best guess when the answer is not declared.

import { readFileSync } from "node:fs";

export interface IdlAccountSlot {
  name: string;
  signer: boolean;
  optional: boolean;
  address?: string;
}

export interface IdlArg {
  name: string;
  type: unknown;
}

export interface IdlInstructionFacts {
  name: string;
  args: IdlArg[];
  accounts: IdlAccountSlot[];
}

export interface IdlFieldFacts {
  name: string;
  type: unknown;
}

export interface IdlAccountFacts {
  name: string;
  /** `accounts[].size` when the IDL declares it. */
  declaredSize?: number;
  /** Length of the declared account discriminator, when present. */
  discriminatorLength?: number;
  fields: IdlFieldFacts[];
}

export interface IdlFacts {
  instructions: IdlInstructionFacts[];
  accounts: IdlAccountFacts[];
  /** Struct field layouts by normalized type name, for size resolution. */
  typeFields: Map<string, IdlFieldFacts[]>;
}

/** Anchor's default account discriminator width, used when the IDL omits one. */
export const DEFAULT_DISCRIMINATOR_BYTES = 8;

export function normalizeIdlName(value: string): string {
  return value.replace(/-/g, "_").toLowerCase();
}

export function readIdlFacts(idlPath: string): IdlFacts | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(idlPath, "utf8"));
  } catch {
    return undefined;
  }
  return collectIdlFacts(parsed);
}

export function collectIdlFacts(parsed: unknown): IdlFacts | undefined {
  const root = record(parsed);
  if (!root) return undefined;

  const typeFields = new Map<string, IdlFieldFacts[]>();
  for (const entry of array(root.types)) {
    const type = record(entry);
    const name = nonEmptyString(type?.name);
    if (!type || !name) continue;
    typeFields.set(normalizeIdlName(name), fieldFacts(type));
  }

  const accounts: IdlAccountFacts[] = [];
  for (const entry of array(root.accounts)) {
    const account = record(entry);
    const name = nonEmptyString(account?.name);
    if (!account || !name) continue;
    const inline = fieldFacts(account);
    accounts.push({
      name,
      declaredSize: positiveInteger(account.size),
      discriminatorLength: array(account.discriminator).length || undefined,
      fields: inline.length > 0 ? inline : (typeFields.get(normalizeIdlName(name)) ?? [])
    });
  }

  const instructions: IdlInstructionFacts[] = [];
  for (const entry of array(root.instructions)) {
    const instruction = record(entry);
    const name = nonEmptyString(instruction?.name);
    if (!instruction || !name) continue;
    instructions.push({
      name,
      args: array(instruction.args).flatMap((raw): IdlArg[] => {
        const arg = record(raw);
        const argName = nonEmptyString(arg?.name);
        return arg && argName ? [{ name: argName, type: arg.type }] : [];
      }),
      accounts: accountSlots(array(instruction.accounts))
    });
  }

  for (const account of accounts) {
    typeFields.set(normalizeIdlName(account.name), account.fields);
  }

  return accounts.length > 0 || instructions.length > 0
    ? { instructions, accounts, typeFields }
    : undefined;
}

// Nested account groups (`{ name, accounts: [...] }`) are flattened the
// same way the linter flattens them, so a grouped slot still counts as a
// slot the adapter has to satisfy.
function accountSlots(entries: unknown[]): IdlAccountSlot[] {
  const slots: IdlAccountSlot[] = [];
  const visit = (values: unknown[]): void => {
    for (const value of values) {
      const entry = record(value);
      if (!entry) continue;
      if (Array.isArray(entry.accounts)) {
        visit(entry.accounts);
        continue;
      }
      const name = nonEmptyString(entry.name);
      if (!name) continue;
      slots.push({
        name,
        signer: entry.signer === true || entry.isSigner === true,
        optional: entry.optional === true,
        address: nonEmptyString(entry.address) ?? undefined
      });
    }
  };
  visit(entries);
  return slots;
}

/**
 * Byte size of an IDL type when Borsh encodes it at a fixed width.
 * Returns `undefined` for anything variable-length (`vec`, `string`,
 * `bytes`) or unresolvable (`defined` types with no struct declaration,
 * enums), because a fixed allocation for those would be an invention.
 */
export function fixedTypeSize(
  type: unknown,
  typeFields: Map<string, IdlFieldFacts[]>,
  depth = 0
): number | undefined {
  if (depth > 8) return undefined;

  if (typeof type === "string") return scalarSize(type);

  const shape = record(type);
  if (!shape) return undefined;

  if ("array" in shape) {
    const spec = array(shape.array);
    if (spec.length !== 2) return undefined;
    const element = fixedTypeSize(spec[0], typeFields, depth + 1);
    const count = positiveInteger(spec[1]) ?? (spec[1] === 0 ? 0 : undefined);
    if (element === undefined || count === undefined) return undefined;
    return element * count;
  }

  if ("option" in shape || "coption" in shape) {
    const inner = fixedTypeSize("option" in shape ? shape.option : shape.coption, typeFields, depth + 1);
    return inner === undefined ? undefined : 1 + inner;
  }

  if ("defined" in shape) {
    const name = definedTypeName(shape.defined);
    if (!name) return undefined;
    const fields = typeFields.get(normalizeIdlName(name));
    if (!fields) return undefined;
    return fixedFieldsSize(fields, typeFields, depth + 1);
  }

  return undefined;
}

export function fixedFieldsSize(
  fields: IdlFieldFacts[],
  typeFields: Map<string, IdlFieldFacts[]>,
  depth = 0
): number | undefined {
  let total = 0;
  for (const field of fields) {
    const size = fixedTypeSize(field.type, typeFields, depth + 1);
    if (size === undefined) return undefined;
    total += size;
  }
  return total;
}

/** Riptide observation type for a declared scalar IDL field type. */
export function observationTypeFor(type: unknown): "int" | "uint" | "bool" | "pubkey" | undefined {
  if (typeof type !== "string") return undefined;
  if (type === "bool") return "bool";
  if (type === "pubkey" || type === "publicKey") return "pubkey";
  if (/^i(8|16|32|64|128)$/.test(type)) return "int";
  if (/^u(8|16|32|64|128)$/.test(type)) return "uint";
  return undefined;
}

/** True when the runtime can bind its per-decision amount to this arg. */
export function isRuntimeAmountType(type: unknown): boolean {
  const observation = observationTypeFor(type);
  return observation === "uint" || observation === "int";
}

function scalarSize(type: string): number | undefined {
  switch (type) {
    case "bool":
    case "u8":
    case "i8":
      return 1;
    case "u16":
    case "i16":
      return 2;
    case "u32":
    case "i32":
    case "f32":
      return 4;
    case "u64":
    case "i64":
    case "f64":
      return 8;
    case "u128":
    case "i128":
      return 16;
    case "u256":
    case "i256":
      return 32;
    case "pubkey":
    case "publicKey":
      return 32;
    default:
      return undefined;
  }
}

function definedTypeName(value: unknown): string | null {
  if (typeof value === "string") return value;
  const shape = record(value);
  return shape ? nonEmptyString(shape.name) : null;
}

function fieldFacts(owner: Record<string, unknown>): IdlFieldFacts[] {
  const direct = Array.isArray(owner.fields) ? owner.fields : undefined;
  const nested = record(owner.type);
  const fields = direct ?? (Array.isArray(nested?.fields) ? nested.fields : []);
  return fields.flatMap((entry): IdlFieldFacts[] => {
    const field = record(entry);
    const name = nonEmptyString(field?.name);
    return field && name ? [{ name, type: field.type }] : [];
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
