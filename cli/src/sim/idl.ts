import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";

const DefinedRefSchema = z.union([
  z.string(),
  z.object({ name: z.string().min(1) }).passthrough()
]);

export type GenericTypeRef =
  | string
  | { vec: GenericTypeRef }
  | { defined: string | { name: string } }
  | { option: GenericTypeRef }
  | { array: [GenericTypeRef, number] };

export const GenericTypeRefSchema: z.ZodType<GenericTypeRef> = z.lazy(() =>
  z.union([
    z.string(),
    z.object({ vec: GenericTypeRefSchema }).strict(),
    z.object({ defined: DefinedRefSchema }).strict(),
    z.object({ option: GenericTypeRefSchema }).strict(),
    z.object({ array: z.tuple([GenericTypeRefSchema, z.number().int().nonnegative()]) }).strict()
  ])
);

export const GenericArgSchema = z.object({
  name: z.string().min(1),
  type: GenericTypeRefSchema
}).passthrough();
export type GenericArg = z.infer<typeof GenericArgSchema>;

export const GenericInstructionAccountSchema = z.object({
  name: z.string().min(1),
  signer: z.boolean().default(false),
  writable: z.boolean().default(false),
  isSigner: z.boolean().optional(),
  isMut: z.boolean().optional(),
  address: z.string().min(1).optional()
}).passthrough().transform((value) => ({
  name: value.name,
  signer: value.isSigner ?? value.signer,
  writable: value.isMut ?? value.writable,
  address: value.address
}));
export type GenericInstructionAccount = z.infer<typeof GenericInstructionAccountSchema>;

export const GenericInstructionSchema = z.object({
  name: z.string().min(1),
  discriminator: z.array(z.number().int().min(0).max(255)).default([]),
  accounts: z.array(GenericInstructionAccountSchema).default([]),
  args: z.array(GenericArgSchema).default([])
}).passthrough();
export type GenericInstruction = z.infer<typeof GenericInstructionSchema>;

export const GenericFieldSchema = GenericArgSchema;
export type GenericField = GenericArg;

export interface GenericEnumVariantField {
  name?: string;
  type: GenericTypeRef;
}

export const GenericEnumVariantFieldSchema: z.ZodType<GenericEnumVariantField> = z.union([
  GenericArgSchema.transform((value) => ({
    name: value.name,
    type: value.type
  })),
  GenericTypeRefSchema.transform((type) => ({ type }))
]);

export const GenericEnumVariantSchema = z.object({
  name: z.string().min(1),
  fields: z.array(GenericEnumVariantFieldSchema).default([])
}).passthrough();
export type GenericEnumVariant = z.infer<typeof GenericEnumVariantSchema>;

export const GenericTypeDefinitionSchema = z.object({
  kind: z.string().min(1),
  fields: z.array(GenericFieldSchema).default([]),
  variants: z.array(GenericEnumVariantSchema).default([])
}).passthrough();
export type GenericTypeDefinition = z.infer<typeof GenericTypeDefinitionSchema>;

export const GenericAccountTypeSchema = z.object({
  name: z.string().min(1),
  discriminator: z.array(z.number().int().min(0).max(255)).optional(),
  fields: z.array(GenericFieldSchema).default([]),
  type: GenericTypeDefinitionSchema.optional()
}).passthrough();

export const GenericDefinedTypeSchema = z.object({
  name: z.string().min(1),
  fields: z.array(GenericFieldSchema).default([]),
  type: GenericTypeDefinitionSchema.optional()
}).passthrough();
export type GenericDefinedType = z.infer<typeof GenericDefinedTypeSchema>;

export const GenericIdlSchema = z.object({
  address: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  instructions: z.array(GenericInstructionSchema),
  accounts: z.array(GenericAccountTypeSchema).default([]),
  types: z.array(GenericDefinedTypeSchema).default([])
}).passthrough();
export type GenericIdl = z.infer<typeof GenericIdlSchema>;

export async function loadGenericIdl(idlPath: string): Promise<GenericIdl> {
  const raw = await readFile(idlPath, "utf8");
  const parsed = GenericIdlSchema.parse(JSON.parse(raw));
  normalizeLegacyAnchorDiscriminators(parsed);
  return parsed;
}

function normalizeLegacyAnchorDiscriminators(idl: GenericIdl): void {
  for (const instruction of idl.instructions) {
    if (instruction.discriminator.length === 0) {
      instruction.discriminator = anchorDiscriminator("global", toAnchorSnakeCase(instruction.name));
    }
  }
  for (const account of idl.accounts) {
    if (account.discriminator === undefined && account.type !== undefined && account.fields.length === 0) {
      account.discriminator = anchorDiscriminator("account", account.name);
    }
  }
}

function anchorDiscriminator(namespace: string, name: string): number[] {
  const hash = createHash("sha256").update(`${namespace}:${name}`).digest();
  return Array.from(hash.subarray(0, 8));
}

function toAnchorSnakeCase(value: string): string {
  let out = "";
  let previousWasLowerOrDigit = false;
  for (const char of value) {
    if (char === "-" || char === " " || char === "_") {
      if (!out.endsWith("_")) out += "_";
      previousWasLowerOrDigit = false;
      continue;
    }
    if (/[A-Z]/.test(char)) {
      if (previousWasLowerOrDigit && !out.endsWith("_")) out += "_";
      out += char.toLowerCase();
      previousWasLowerOrDigit = false;
      continue;
    }
    out += char;
    previousWasLowerOrDigit = /[a-z0-9]/.test(char);
  }
  return out;
}
