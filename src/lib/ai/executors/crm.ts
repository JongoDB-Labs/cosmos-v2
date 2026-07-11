import { prisma } from "@/lib/db/client";
import { z } from "zod";
import { Permission } from "@/lib/rbac/permissions";
import { crmStageSchema, DEFAULT_CRM_STAGE } from "@/lib/crm/stages";
import { assertPermission, type ToolContext } from "./_ctx";

/**
 * CRM write executors (contacts) + partner/product reads. Contact READS keep
 * using the existing `query_crm` tool. Every query is org-scoped. Mirrors
 * `api/v1/orgs/[orgId]/crm/contacts/…`, `partners`, `products`.
 */

function invalid(error: z.ZodError): { error: string } {
  return { error: `Invalid input: ${error.issues.map((i) => i.message).join("; ")}` };
}

const CONTACT_SELECT = {
  id: true, stage: true, ownerId: true, name: true, email: true, company: true,
  createdAt: true, updatedAt: true,
} as const;

// ── create_crm_contact ─────────────────────────────────────────────────────
const createContactSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().max(320).nullish(),
  phone: z.string().max(50).nullish(),
  company: z.string().max(200).nullish(),
  title: z.string().max(200).nullish(),
  stage: crmStageSchema,
  ownerId: z.string().uuid().nullish(),
  dealValue: z.number().nullish(),
  notes: z.string().nullish(),
});

export async function createCrmContact(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.CRM_CREATE);
  if (denied) return denied;

  const parsed = createContactSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  const created = await prisma.crmContact.create({
    data: {
      orgId: ctx.orgId,
      name: data.name,
      email: data.email ?? null,
      phone: data.phone ?? null,
      company: data.company ?? null,
      title: data.title ?? null,
      stage: data.stage ?? DEFAULT_CRM_STAGE,
      ownerId: data.ownerId ?? null,
      dealValue: data.dealValue ?? null,
      notes: data.notes ?? null,
    },
    select: CONTACT_SELECT,
  });
  return { created: true, id: created.id, contact: created };
}

// ── update_crm_contact ─────────────────────────────────────────────────────
const updateContactSchema = z.object({
  contactId: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  email: z.string().max(320).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  company: z.string().max(200).nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  stage: crmStageSchema,
  ownerId: z.string().uuid().nullable().optional(),
  dealValue: z.number().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export async function updateCrmContact(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.CRM_UPDATE);
  if (denied) return denied;

  const parsed = updateContactSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  const existing = await prisma.crmContact.findFirst({
    where: { id: data.contactId, orgId: ctx.orgId },
    select: { id: true },
  });
  if (!existing) return { error: "Contact not found" };

  const updated = await prisma.crmContact.update({
    where: { id: existing.id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.email !== undefined && { email: data.email }),
      ...(data.phone !== undefined && { phone: data.phone }),
      ...(data.company !== undefined && { company: data.company }),
      ...(data.title !== undefined && { title: data.title }),
      // `!= null` so an explicit null leaves the stage untouched (mirrors the route).
      ...(data.stage != null && { stage: data.stage }),
      ...(data.ownerId !== undefined && { ownerId: data.ownerId }),
      ...(data.dealValue !== undefined && { dealValue: data.dealValue }),
      ...(data.notes !== undefined && { notes: data.notes }),
    },
    select: CONTACT_SELECT,
  });
  return { updated: true, id: updated.id, contact: updated };
}

// ── list_partners ─────────────────────────────────────────────────────────
const listPartnersSchema = z.object({
  status: z.string().max(40).optional(),
  limit: z.number().int().positive().optional(),
});

export async function listPartners(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.CRM_READ);
  if (denied) return denied;

  const parsed = listPartnersSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { status, limit } = parsed.data;

  const partners = await prisma.partner.findMany({
    where: { orgId: ctx.orgId, ...(status && { status }) },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit ?? 50, 100),
    select: {
      id: true, type: true, status: true, socioEconomic: true, perfRating: true,
      ndaOnFile: true, ndaExpiry: true, name: true, createdAt: true, updatedAt: true,
    },
  });
  return { count: partners.length, partners };
}

// ── list_products ─────────────────────────────────────────────────────────
const listProductsSchema = z.object({
  status: z.string().max(40).optional(),
  limit: z.number().int().positive().optional(),
});

export async function listProducts(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.CRM_READ);
  if (denied) return denied;

  const parsed = listProductsSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { status, limit } = parsed.data;

  const products = await prisma.product.findMany({
    where: { orgId: ctx.orgId, ...(status && { status }) },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit ?? 50, 100),
    select: {
      id: true, status: true, currency: true, name: true, category: true,
      createdAt: true, updatedAt: true,
    },
  });
  return { count: products.length, products };
}
