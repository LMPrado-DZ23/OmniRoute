import { z } from "zod";

/** Request bodies of the `/api/workspaces/**` management routes. */

const budgetSchema = z
  .object({
    /** `null` removes the budget at this level. */
    limitUsd: z.number().positive().max(1_000_000_000).nullable().optional(),
    interval: z.enum(["daily", "weekly", "monthly"]).optional(),
    warningThreshold: z.number().min(0.01).max(1).optional(),
  })
  .strict();

const nameSchema = z.string().trim().min(1).max(100);
const descriptionSchema = z.string().trim().max(500).nullable().optional();

export const createHierarchyNodeSchema = z
  .object({ name: nameSchema, description: descriptionSchema, budget: budgetSchema.optional() })
  .strict();

export const updateHierarchyNodeSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema,
    budget: budgetSchema.optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.name !== undefined || body.description !== undefined || body.budget !== undefined,
    { message: "Provide at least one of name, description or budget" }
  );

export const setProjectKeysSchema = z
  .object({ apiKeyIds: z.array(z.string().trim().min(1).max(200)).max(500) })
  .strict();

/** `api_key:<id>` or `access_token:<id>`: the only principals that can be members. */
export const MEMBER_PRINCIPAL_PATTERN = /^(api_key|access_token):[A-Za-z0-9._-]{1,200}$/;

export const upsertMemberSchema = z
  .object({
    principal: z
      .string()
      .regex(MEMBER_PRINCIPAL_PATTERN, "Expected api_key:<id> or access_token:<id>"),
    role: z.enum(["admin", "viewer"]),
  })
  .strict();
