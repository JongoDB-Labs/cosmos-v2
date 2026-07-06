import { prisma } from "@/lib/db/client";
import { ClassificationLevel, type Prisma } from "@prisma/client";
import { SECTOR_FIELD_TEMPLATES } from "./sector-field-templates";

export interface SeedSectorFieldsResult {
  sector: string;
  created: number;
  /** Keys that already existed for the org — left untouched (a user may have
   *  edited or deliberately deleted bindings; seeding never overwrites). */
  skipped: string[];
}

/**
 * Seed a sector's field set into an org (FR 454637a9). Idempotent by field key:
 * existing keys are skipped, so re-applying (or a template-created project in an
 * org that already has the set) is a no-op. Fields are ORG-scoped (the
 * custom_fields unique is (orgId, key)); scoping to the right items happens via
 * TYPE BINDINGS to the sector's built-in item types — govcon (no sector types)
 * binds to every built-in type.
 */
export async function seedSectorFields(
  orgId: string,
  sector: string,
): Promise<SeedSectorFieldsResult> {
  const defs = SECTOR_FIELD_TEMPLATES[sector];
  if (!defs || defs.length === 0) return { sector, created: 0, skipped: [] };

  // The sector's built-in types (or all built-ins for govcon).
  const types = await prisma.workItemType.findMany({
    where: {
      isBuiltIn: true,
      ...(sector === "govcon" ? {} : { key: { startsWith: `${sector}.` } }),
    },
    select: { id: true, key: true },
  });
  if (types.length === 0) return { sector, created: 0, skipped: [] };

  const existing = await prisma.customField.findMany({
    where: { orgId, key: { in: defs.map((d) => d.key) } },
    select: { key: true },
  });
  const existingKeys = new Set(existing.map((f) => f.key));

  // The org's classification vocabulary — the ClassificationLevel enum is the
  // source of truth the Classifications settings use.
  const classificationOptions = Object.values(ClassificationLevel);

  let created = 0;
  const skipped: string[] = [];
  let sortOrder = 0;

  for (const def of defs) {
    if (existingKeys.has(def.key)) {
      skipped.push(def.key);
      sortOrder++;
      continue;
    }

    const boundTypes = def.bindTo
      ? types.filter((t) => def.bindTo!.some((suffix) => t.key.endsWith(`.${suffix}`)))
      : types;

    // A bindTo that matches NO types (e.g. a "bug"-only field where the org has
    // no bug type) must SKIP the field — creating it unbound would make it show
    // on every item (fieldAppliesToType treats no-bindings as show-everywhere),
    // the opposite of the intent.
    if (def.bindTo && boundTypes.length === 0) {
      skipped.push(def.key);
      sortOrder++;
      continue;
    }

    const options = def.optionsFromClassifications
      ? classificationOptions
      : (def.options ?? []);

    await prisma.customField.create({
      data: {
        orgId,
        projectId: null,
        name: def.name,
        key: def.key,
        fieldType: def.fieldType,
        options: options as Prisma.InputJsonValue,
        required: false,
        sortOrder: sortOrder++,
        typeBindings: {
          create: boundTypes.map((t) => ({ workItemTypeId: t.id })),
        },
      },
    });
    created++;
  }

  return { sector, created, skipped };
}
