// (e2e DB) SECURITY. `hasAttachments` is an existence filter over `Document`,
// and a Document carries `visibility` and `classificationLevel` — so the naive
// `{ documents: { some: {} } }` would answer "yes, there is a file on this
// ticket" to somebody not allowed to see that file. files/access.ts states the
// principle for the LIST queries: a restricted file has to be ABSENT from
// results, not merely refused on download, because a filename is often the
// secret. This field reuses that fragment rather than writing a second one.
//
// Every ABSENCE below is paired with a positive control in the same spec, so a
// query that simply returned nothing could not pass any of them.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { OrgRole } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { executeCql } from "../execute.server";
import { seedWorld, type World } from "./cql-fixture";

const NOW = new Date("2026-10-15T15:00:00Z");

describe("CQL: hasAttachments never discloses a file you may not see (e2e DB)", () => {
  let w: World;
  let restrictedDocId = "";

  beforeAll(async () => {
    w = await seedWorld();
    const item = async (title: string, n: number) =>
      (
        await prisma.workItem.create({
          data: {
            orgId: w.orgA,
            projectId: w.P1.id,
            ticketNumber: n,
            title,
            description: "",
            columnKey: "todo",
            workItemTypeId: w.typeTask,
            createdById: w.actor.id,
          },
          select: { id: true },
        })
      ).id;
    const doc = (workItemId: string, visibility: "INHERIT" | "RESTRICTED", filename: string) =>
      prisma.document.create({
        data: {
          orgId: w.orgA,
          projectId: w.P1.id,
          workItemId,
          visibility,
          title: filename,
          filename,
          storageKey: `k/${w.stamp}/${filename}`,
          contentType: "application/pdf",
          size: 10,
          // Bob uploaded it, not the actor: the actor has no claim of their own
          // on either file, so only the visibility rule can decide.
          uploadedById: w.bob.id,
        },
        select: { id: true },
      });

    const secret = await item("att-restricted", 81);
    const normal = await item("att-normal", 82);
    await item("att-none", 83);
    restrictedDocId = (await doc(secret, "RESTRICTED", `settlement-${w.stamp}.pdf`)).id;
    await doc(normal, "INHERIT", `spec-${w.stamp}.pdf`);
  }, 60_000);

  afterAll(async () => {
    await w?.cleanup();
  });

  /**
   * An ordinary member's mask. The CQL fixture's context carries ITEM_READ
   * alone, which is below every role but GUEST; project-scoped file visibility
   * is decided by PROJECT_READ (getVisibleProjectIds), so a realistic member
   * has to carry it.
   */
  const member = (role: OrgRole = OrgRole.MEMBER): AuthContext => {
    const base = w.ctx({ role });
    const permissions = base.permissions | Permission.PROJECT_READ;
    return { ...base, permissions, basePermissions: permissions };
  };

  const keys = async (ctx: AuthContext, cql: string) => {
    const r = await executeCql(ctx, { cql }, { now: NOW, pageSize: 100 });
    return r.data.map((x) => String(x.title).replace(`-${w.stamp}`, "")).sort();
  };

  it("hides the restricted-only item from `= true`, while still finding the ordinary one", async () => {
    const got = await keys(member(), "attachments = true");
    // The positive control and the leak, in one assertion pair: the probe DOES
    // see an attachment when it is allowed to.
    expect(got).toContain("att-normal");
    expect(got).not.toContain("att-restricted");
  });

  it("counts the restricted-only item as having NO attachment, which leaks nothing", async () => {
    const got = await keys(member(), "attachments = false");
    expect(got).toContain("att-restricted");
    expect(got).toContain("att-none");
    expect(got).not.toContain("att-normal");
  });

  it("an org administrator DOES see it — the decision recorded in readableDocument", async () => {
    const admin = member(OrgRole.ADMIN);
    const yes = await keys(admin, "hasAttachments = true");
    expect(yes).toContain("att-restricted");
    expect(yes).toContain("att-normal");
    const no = await keys(admin, "hasAttachments = false");
    expect(no).not.toContain("att-restricted");
    expect(no).toContain("att-none");
  });

  it("sharing the file with the viewer flips it — proof the fragment is consulted, not a blanket rule", async () => {
    await prisma.documentShare.create({
      data: { orgId: w.orgA, documentId: restrictedDocId, userId: w.actor.id, grantedById: w.bob.id },
    });
    expect(await keys(member(), "attachments = true")).toContain("att-restricted");
    expect(await keys(member(), "attachments = false")).not.toContain("att-restricted");
    // Put it back, so the suite's later state is the restricted one again.
    await prisma.documentShare.deleteMany({ where: { documentId: restrictedDocId } });
    expect(await keys(member(), "attachments = true")).not.toContain("att-restricted");
  });

  it("fails CLOSED without PROJECT_READ: no attachments, rather than every attachment", async () => {
    // A GUEST carries ITEM_READ and no PROJECT_READ, so getVisibleProjectIds
    // hands back nothing and only files filed against no project stay
    // reachable. Conservative by design, and recorded here so that it cannot
    // change into "matches everything" without a test going red.
    const guest = w.ctx();
    expect(await keys(guest, "attachments = true")).toEqual([]);
    // Positive control: this same actor CAN read these items.
    const all = await keys(guest, "");
    expect(all).toContain("att-normal");
    expect(all).toContain("att-restricted");
  });
});
