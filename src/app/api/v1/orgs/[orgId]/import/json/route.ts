import { NextRequest } from "next/server";
import { z } from "zod";
import { RevenueType, Visibility } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { ForbiddenError, requirePermission, type AuthContext } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { requireProjectVisible } from "@/lib/rbac/require-project-read";
import { assertRefsInScope } from "@/lib/rbac/foreign-refs";
import { logAudit } from "@/lib/audit";

/**
 * Import records from a JSON archive (the shape the org export writes).
 *
 * Each row is read through an ALLOWLIST: the fields a person may type into the
 * form that creates that record, and nothing else. The import used to copy
 * every column it was handed, so a row could arrive already APPROVED by
 * someone else, attached to an invoice, "written" by another member, or
 * pointing at another org's records. Now:
 *
 *  - who: the importer creates every row. `createdById` / `authorId` are theirs.
 *  - where in the workflow: the start. An expense is a DRAFT; status, approver,
 *    approval and submission times, and the invoice link are never written.
 *  - which ids: fresh ones. A row's own `id` and `orgId` are ignored; a
 *    `projectId` or `clinId` must be this org's and visible to the importer,
 *    and a row naming another org's CLIN or invoice is skipped
 *    (lib/rbac/foreign-refs.ts).
 *  - who may: each entity needs the bit that creating one needs -- an archive
 *    is not a way round the form's gate.
 *
 * Bad rows are skipped and counted, not fatal; one audit row records the lot.
 *
 * Amounts and prices accept numeric strings, because that is how the export
 * writes a decimal.
 */

const money = z.coerce.number();
const day = z.string().min(1);

const ROWS = {
  notes: z.object({
    title: z.string().min(1).max(500),
    content: z.string().nullish(),
    visibility: z.nativeEnum(Visibility).optional(),
  }),
  partners: z.object({
    name: z.string().min(1).max(200),
    type: z.string().nullish(),
    status: z.string().nullish(),
    website: z.string().nullish(),
    contactName: z.string().max(200).nullish(),
    contactEmail: z.string().nullish(),
    contactPhone: z.string().max(50).nullish(),
    notes: z.string().nullish(),
  }),
  products: z.object({
    name: z.string().min(1).max(200),
    description: z.string().nullish(),
    sku: z.string().max(100).nullish(),
    price: money.nullish(),
    currency: z.string().max(10).nullish(),
    status: z.string().nullish(),
    category: z.string().max(100).nullish(),
  }),
  expenses: z.object({
    amount: money.pipe(z.number().positive()),
    currency: z.string().max(10).nullish(),
    date: day,
    category: z.string().min(1),
    vendor: z.string().nullish(),
    description: z.string().nullish(),
    recurring: z.boolean().optional(),
    clinId: z.string().uuid().nullish(),
    projectId: z.string().uuid().nullish(),
    reimbursable: z.boolean().optional(),
  }),
  revenues: z.object({
    amount: money.pipe(z.number().positive()),
    currency: z.string().max(10).nullish(),
    date: day,
    client: z.string().nullish(),
    product: z.string().nullish(),
    type: z.nativeEnum(RevenueType).optional(),
    description: z.string().nullish(),
  }),
};
type Entity = keyof typeof ROWS;
const ENTITIES = Object.keys(ROWS) as Entity[];

/** The bit the form that creates one of these needs. */
const CREATE_BIT: Record<Entity, bigint> = {
  notes: Permission.NOTE_CREATE,
  partners: Permission.CRM_CREATE,
  products: Permission.CRM_CREATE,
  expenses: Permission.FINANCE_MANAGE,
  revenues: Permission.FINANCE_MANAGE,
};

const schema = z.object(
  Object.fromEntries(ENTITIES.map((e) => [e, z.array(z.unknown()).optional()])) as Record<
    Entity,
    z.ZodOptional<z.ZodArray<z.ZodUnknown>>
  >,
);

async function createOne(ctx: AuthContext, entity: Entity, raw: unknown): Promise<boolean> {
  const orgId = ctx.orgId;
  switch (entity) {
    case "notes": {
      const r = ROWS.notes.parse(raw);
      await prisma.note.create({
        data: { orgId, authorId: ctx.userId, title: r.title, content: r.content ?? "", visibility: r.visibility ?? "PRIVATE" },
      });
      return true;
    }
    case "partners": {
      const r = ROWS.partners.parse(raw);
      await prisma.partner.create({
        data: {
          orgId, name: r.name, type: r.type ?? "vendor", status: r.status ?? "active",
          website: r.website || null, contactName: r.contactName ?? null, contactEmail: r.contactEmail || null,
          contactPhone: r.contactPhone ?? null, notes: r.notes ?? null,
        },
      });
      return true;
    }
    case "products": {
      const r = ROWS.products.parse(raw);
      await prisma.product.create({
        data: {
          orgId, name: r.name, description: r.description ?? null, sku: r.sku ?? null, price: r.price ?? null,
          currency: r.currency ?? "USD", status: r.status ?? "active", category: r.category ?? null,
        },
      });
      return true;
    }
    case "expenses": {
      const r = ROWS.expenses.parse(raw);
      // Filing it under a project is writing to that project.
      if (r.projectId) await requireProjectVisible(ctx, r.projectId);
      // Every id the row names must be this org's, and its CLIN on its project
      // (with no project, one the importer can see) -- the expense form's rule.
      // The invoice is checked too, so a row naming another org's is skipped,
      // and then not linked all the same: an import starts a draft.
      const named = raw as { invoiceId?: unknown };
      await assertRefsInScope(
        { orgId, projectId: r.projectId ?? null, viewer: ctx },
        { clin: r.clinId ?? null, invoice: typeof named.invoiceId === "string" ? named.invoiceId : null },
      );
      if (r.reimbursable && !r.projectId) return false; // billable needs a project, as on the form
      await prisma.expense.create({
        data: {
          orgId, amount: r.amount, currency: r.currency ?? "USD", date: new Date(r.date), category: r.category,
          vendor: r.vendor ?? null, description: r.description ?? "", recurring: r.recurring ?? false,
          clinId: r.clinId ?? null, projectId: r.projectId ?? null, reimbursable: r.reimbursable ?? false,
          status: "DRAFT", createdById: ctx.userId,
        },
      });
      return true;
    }
    case "revenues": {
      const r = ROWS.revenues.parse(raw);
      await prisma.revenue.create({
        data: {
          orgId, amount: r.amount, currency: r.currency ?? "USD", date: new Date(r.date), client: r.client ?? null,
          product: r.product ?? null, type: r.type ?? "ONE_TIME", description: r.description ?? "",
          createdById: ctx.userId,
        },
      });
      return true;
    }
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_IMPORT);

    const body = schema.parse(await request.json());
    const present = ENTITIES.filter((e) => body[e]?.length);
    // Checked for every entity BEFORE anything is written, so a refused import
    // creates nothing rather than half of what it was given.
    const refused = present.filter((e) => !hasPermission(ctx.permissions, CREATE_BIT[e]));
    if (refused.length) throw new ForbiddenError(`Importing ${refused.join(", ")} needs permission to create them`);

    const imported = Object.fromEntries(ENTITIES.map((e) => [e, 0])) as Record<Entity, number>;
    const skipped = Object.fromEntries(ENTITIES.map((e) => [e, 0])) as Record<Entity, number>;
    for (const entity of present) {
      for (const raw of body[entity] ?? []) {
        let ok = false;
        try {
          ok = await createOne(ctx, entity, raw);
        } catch {
          ok = false; // a bad row (invalid, not visible, not this org's) is skipped, not fatal
        }
        if (ok) imported[entity]++;
        else skipped[entity]++;
      }
    }

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "org.data_imported",
      entity: "organization",
      entityId: orgId,
      metadata: {
        ...Object.fromEntries(ENTITIES.map((e) => [e, String(imported[e])])),
        ...Object.fromEntries(ENTITIES.map((e) => [`${e}Skipped`, String(skipped[e])])),
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success({ imported, skipped });
  } catch (e) {
    return handleApiError(e);
  }
}
