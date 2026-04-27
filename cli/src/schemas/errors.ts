import { z } from "zod";

export const ProgramErrorLabelSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "program error label must be snake_case `[a-z][a-z0-9_]*`");

export const ProgramErrorEntrySchema = z.object({
  code: z.number().int().nonnegative().max(0xffffffff),
  label: ProgramErrorLabelSchema,
  interpretation: z.string().min(1).refine(
    (value) => !value.includes("\n") && !value.includes("\r"),
    "program error interpretation must be a single line"
  ),
}).strict();

export type ProgramErrorEntry = z.infer<typeof ProgramErrorEntrySchema>;

export const ProgramErrorInfoSchema = z.object({
  code: z.number().int().nonnegative().max(0xffffffff),
  label: ProgramErrorLabelSchema.optional(),
  interpretation: z.string().min(1).optional(),
}).strict();

export type ProgramErrorInfo = z.infer<typeof ProgramErrorInfoSchema>;
