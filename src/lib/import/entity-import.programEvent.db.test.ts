// @vitest-environment node
//
// The generic entity importer can actually load a program calendar.
//
// Two halves, deliberately:
//
//   - INLINE fixtures, which always run. They are the spec: what a row becomes,
//     and that re-importing it UPDATES rather than duplicates — on BOTH natural
//     key forms, since an export may or may not carry an external id.
//   - The two REAL files (a CSV and an XLSX with deliberately different
//     headers), read from ~/Downloads and skipped when absent so CI stays
//     green. These are the only thing that proves the synonyms match the
//     columns a human actually exports, which no inline fixture can: a fixture
//     is a copy of what I BELIEVE the file says.
//
// A mocked Prisma would see none of it — the category find-or-create, the
// owner/deliverable lookups and the natural-key read-back are all queries.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prisma } from "@/lib/db/client";
import { runEntityImport } from "./entity-import";
import { getEntityDef, guessFieldForHeader, type EntityDef } from "./entity-fields";
import { parseWorkbook, matrixToObjects, guessHeaderRow } from "./parse-file";

/** The caller, as the engine now requires: name resolution narrows teams and
 *  deliverables to what this context can see. An org ADMIN sees every project,
 *  which is what these fixtures assume. */
const authFor = (userId: string, orgId: string) =>
  ({ userId, orgId, orgRole: "ADMIN", abacRules: [], permissions: -1n, basePermissions: -1n }) as unknown as import("@/lib/rbac/check").AuthContext;


let orgId = "";
let userId = "";
let projectId = "";
let teamId = "";
let memberId = "";
let deliverableId = "";

const def = getEntityDef("programEvent") as EntityDef;

/** `{ orgId, projectId: null, userId, auth: authFor(userId, orgId) }` — an org-scoped import has no project. */
const ctx = () => ({ orgId, projectId: null, userId, auth: authFor(userId, orgId) });

/** Map every header the way the wizard's first pass does. */
function autoMap(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const h of headers) mapping[h] = guessFieldForHeader(def, h) || "__ignore__";
  return mapping;
}

const events = () =>
  prisma.programEvent.findMany({
    where: { orgId },
    select: {
      id: true, title: true, startsAt: true, endsAt: true, allDay: true, timeZone: true,
      externalId: true, showOnDashboard: true, customerAttending: true, recurrence: true,
      description: true, attendees: true, location: true, projectId: true,
      ownerTeamId: true, ownerMemberId: true, deliverableId: true,
      category: { select: { name: true } },
    },
    orderBy: { startsAt: "asc" },
  });

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  userId = (await prisma.user.create({
    data: { email: `pc-${stamp}@test.local`, displayName: "Importing Person" },
  })).id;
  orgId = (await prisma.organization.create({
    data: { name: `pc ${stamp}`, slug: `pc-${stamp}` },
  })).id;
  projectId = (await prisma.project.create({
    data: { orgId, name: "P", key: `PC${stamp.slice(-4).toUpperCase()}` },
  })).id;
  teamId = (await prisma.team.create({ data: { orgId, projectId, name: "Contracts" } })).id;
  const ownerUserId = (await prisma.user.create({
    data: { email: `scott-${stamp}@test.local`, displayName: "Scott Stapp" },
  })).id;
  memberId = (await prisma.orgMember.create({ data: { orgId, userId: ownerUserId } })).id;
  deliverableId = (await prisma.deliverable.create({
    data: { orgId, projectId, code: "CDRL-A001", title: "Monthly Status Report" },
  })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { email: { endsWith: "@test.local" }, id: userId } }).catch(() => undefined);
});

describe("entity import — program calendar", () => {
  it("creates an all-day event, creating the category it names", async () => {
    const report = await runEntityImport(ctx(), {
      entity: "programEvent",
      mode: "commit",
      mapping: {
        "External ID": "externalId", Title: "title", Category: "category",
        "Start date": "startDate", "End date": "endDate", "All day": "allDay",
        "Time zone": "timeZone", Description: "description",
        "Show on PM Dashboard": "showOnDashboard",
      },
      rows: [
        {
          "External ID": "lpi-o6-ipr-2026-10-01", Title: "O-6 IPR",
          Category: "LPI Governance & Decisions",
          "Start date": "2026-10-01", "End date": "2026-10-01",
          "All day": "Yes", "Time zone": "America/New_York",
          Description: "Source: FY27 POA&M.", "Show on PM Dashboard": "No",
        },
      ],
    });

    expect(report.errors).toEqual([]);
    expect(report.created).toBe(1);

    // The row is the fact; the report is only the engine's account of itself.
    const rows = await events();
    expect(rows).toHaveLength(1);
    const ev = rows[0];
    expect(ev.title).toBe("O-6 IPR");
    expect(ev.category.name).toBe("LPI Governance & Decisions");
    expect(ev.allDay).toBe(true);
    // Midnight to the NEXT midnight: the end date is inclusive in the sheet.
    expect(ev.startsAt.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(ev.endsAt.toISOString()).toBe("2026-10-02T00:00:00.000Z");
    expect(ev.showOnDashboard).toBe(false);
    // Org-scoped: the import attaches no project, so the whole org can see it.
    expect(ev.projectId).toBeNull();
  });

  it("re-importing the same external id UPDATES it", async () => {
    const run = (title: string, dashboard: string) =>
      runEntityImport(ctx(), {
        entity: "programEvent",
        mode: "commit",
        mapping: {
          "External ID": "externalId", Title: "title", Category: "category",
          "Start date": "startDate", "Show on PM Dashboard": "showOnDashboard",
        },
        rows: [{
          "External ID": "lpi-sundown-2026-11", Title: title,
          Category: "LPI Governance & Decisions", "Start date": "2026-11-16",
          "Show on PM Dashboard": dashboard,
        }],
      });

    const first = await run("TCPT Sundown MARADMIN", "No");
    expect(first.created).toBe(1);
    const second = await run("TCPT/CLC2S Sundown MARADMIN", "Yes");
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);

    const matching = (await events()).filter((e) => e.externalId === "lpi-sundown-2026-11");
    expect(matching).toHaveLength(1);
    expect(matching[0].title).toBe("TCPT/CLC2S Sundown MARADMIN");
    expect(matching[0].showOnDashboard).toBe(true);
  });

  it("re-importing a row with NO external id matches on title + start date", async () => {
    // The xlsx has no external id column at all, so this path is not a nicety:
    // without it every re-export of that file doubles the calendar.
    const run = (location: string) =>
      runEntityImport(ctx(), {
        entity: "programEvent",
        mode: "commit",
        mapping: {
          Event: "title", Category: "category", "Start date": "startDate",
          "End date": "endDate", "All day": "allDay", Location: "location",
        },
        rows: [{
          Event: "OUSW Industry Day", Category: "Engagements",
          "Start date": "11/09/2026", "End date": "11/10/2026",
          "All day": "Y", Location: location,
        }],
      });

    expect((await run("Quantico")).created).toBe(1);
    const second = await run("Crystal City");
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);

    const matching = (await events()).filter((e) => e.title === "OUSW Industry Day");
    expect(matching).toHaveLength(1);
    expect(matching[0].location).toBe("Crystal City");
    expect(matching[0].externalId).toBeNull();
  });

  it("matches the same day written in another date format", async () => {
    // The two files spell the same day differently ("2026-11-09" vs
    // "11/09/2026"). The natural key normalises both, so importing one file
    // after the other updates rather than duplicates.
    const run = (startDate: string, description: string) =>
      runEntityImport(ctx(), {
        entity: "programEvent",
        mode: "commit",
        mapping: {
          Title: "title", Category: "category",
          "Start date": "startDate", Description: "description",
        },
        rows: [{
          Title: "Internal GLADM Testing", Category: "Sprint Related",
          "Start date": startDate, Description: description,
        }],
      });

    expect((await run("11/09/2026", "from the workbook")).created).toBe(1);
    const second = await run("2026-11-09", "from the csv");
    expect(second.updated).toBe(1);

    const matching = (await events()).filter((e) => e.title === "Internal GLADM Testing");
    expect(matching).toHaveLength(1);
    expect(matching[0].description).toBe("from the csv");
  });

  it("updates every column the second file maps, not just the obvious ones", async () => {
    // tsc cannot see a wrong column name in a Prisma `data` object, and the
    // update path writes nine of them. The create path is covered by the specs
    // above; without this, `categoryId`, the owner pair, `deliverableId`,
    // `recurrence`, `attendees` and `customerAttending` are only ever exercised
    // on UPDATE by the real-file specs, which CI skips.
    const mapping = {
      Event: "title", Category: "category", "Start date": "startDate",
      Owner: "owner", Attendees: "attendees", Recurrence: "recurrence",
      Deliverable: "deliverable", "Customer attending": "customerAttending",
      Location: "location", Description: "description",
      "Show on PM Dashboard": "showOnDashboard",
    };
    const row = (over: Record<string, string>) => ({
      Event: "Quarterly review", Category: "Engagements", "Start date": "12/15/2026",
      Owner: "", Attendees: "", Recurrence: "None", Deliverable: "",
      "Customer attending": "N", Location: "", Description: "", "Show on PM Dashboard": "N",
      ...over,
    });

    expect((await runEntityImport(ctx(), {
      entity: "programEvent", mode: "commit", mapping, rows: [row({})],
    })).created).toBe(1);

    const second = await runEntityImport(ctx(), {
      entity: "programEvent",
      mode: "commit",
      mapping,
      rows: [row({
        Category: "Reviews & Demos", Owner: "Scott Stapp",
        Attendees: "col.gonzalez@example.mil", Recurrence: "Quarterly",
        Deliverable: "Monthly Status Report", "Customer attending": "Y",
        Location: "Quantico", Description: "agenda attached",
        "Show on PM Dashboard": "Y",
      })],
    });
    expect(second.errors.filter((e) => !/Owner|Deliverable/.test(e.message))).toEqual([]);
    expect(second.updated).toBe(1);

    const rows = (await events()).filter((e) => e.title === "Quarterly review");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: { name: "Reviews & Demos" },
      ownerMemberId: memberId,
      ownerTeamId: null,
      attendees: "col.gonzalez@example.mil",
      recurrence: "QUARTERLY",
      deliverableId,
      customerAttending: true,
      location: "Quantico",
      description: "agenda attached",
      showOnDashboard: true,
    });
  });

  it("keeps the two natural-key forms apart", async () => {
    // The whole reason the tokens are prefixed. Row 1 carries an external id
    // that is, verbatim, what row 2's title+day key would spell; unprefixed
    // they are one token, and the second row would silently overwrite — or be
    // skipped as a duplicate of — the first.
    const report = await runEntityImport(ctx(), {
      entity: "programEvent",
      mode: "commit",
      mapping: {
        "External ID": "externalId", Title: "title",
        Category: "category", "Start date": "startDate",
      },
      rows: [
        { "External ID": "collider|2027-01-06", Title: "Imported by id", Category: "Engagements", "Start date": "2027-01-06" },
        { "External ID": "", Title: "Collider", Category: "Engagements", "Start date": "2027-01-06" },
      ],
    });

    expect(report.errors).toEqual([]);
    expect(report.created).toBe(2);
    expect(report.skipped).toBe(0);
    const rows = (await events()).filter((e) => /collider/i.test(e.title) || e.externalId === "collider|2027-01-06");
    expect(rows).toHaveLength(2);
  });

  it("does not duplicate a late-evening timed event on re-import", async () => {
    // 9pm Eastern is stored as the NEXT UTC day. A natural key that read the
    // stored instant in UTC would not recognise the row it just wrote, and the
    // second run would add a second event rather than update the first.
    const run = () =>
      runEntityImport(ctx(), {
        entity: "programEvent",
        mode: "commit",
        mapping: {
          Event: "title", Category: "category", "Start date": "startDate",
          "Start time": "startTime", "End time": "endTime",
          "All day": "allDay", "Time zone": "timeZone",
        },
        rows: [{
          Event: "Evening rehearsal", Category: "Engagements",
          "Start date": "11/17/2026", "Start time": "21:00", "End time": "22:00",
          "All day": "N", "Time zone": "Eastern (ET)",
        }],
      });

    expect((await run()).created).toBe(1);
    const again = await run();
    expect(again.created).toBe(0);
    expect(again.updated).toBe(1);

    const rows = (await events()).filter((e) => e.title === "Evening rehearsal");
    expect(rows).toHaveLength(1);
    expect(rows[0].startsAt.toISOString()).toBe("2026-11-18T02:00:00.000Z");
  });

  it("stores a timed event as the instant its own zone describes", async () => {
    const report = await runEntityImport(ctx(), {
      entity: "programEvent",
      mode: "commit",
      mapping: {
        Event: "title", Category: "category", "Start date": "startDate",
        "End date": "endDate", "Start time": "startTime", "End time": "endTime",
        "All day": "allDay", "Time zone": "timeZone", "Customer attending": "customerAttending",
      },
      rows: [{
        Event: "PAE Mission Systems Engagement", Category: "Engagements",
        "Start date": "11/12/2026", "End date": "11/12/2026",
        "Start time": "15:30", "End time": "16:30",
        "All day": "N", "Time zone": "Eastern (ET)", "Customer attending": "Y",
      }],
    });
    expect(report.errors).toEqual([]);

    const ev = (await events()).find((e) => e.title === "PAE Mission Systems Engagement")!;
    expect(ev.allDay).toBe(false);
    expect(ev.startsAt.toISOString()).toBe("2026-11-12T20:30:00.000Z"); // 15:30 EST
    expect(ev.endsAt.toISOString()).toBe("2026-11-12T21:30:00.000Z");
    expect(ev.customerAttending).toBe(true);
    // "Eastern (ET)" is NOT a zone Intl accepts, and the chip hands the stored
    // value straight to it. Storing the label verbatim would break the render.
    expect(ev.timeZone).toBe("America/New_York");
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: ev.timeZone })).not.toThrow();
  });

  it("resolves an owner to a team, and a person to a member", async () => {
    const report = await runEntityImport(ctx(), {
      entity: "programEvent",
      mode: "commit",
      mapping: { Event: "title", Category: "category", "Start date": "startDate", Owner: "owner" },
      rows: [
        { Event: "Invoice Submitted", Category: "Monthly Business Rhythm Dates", "Start date": "11/13/2026", Owner: "contracts" },
        { Event: "Raytheon Investor Briefing", Category: "Engagements", "Start date": "11/09/2026", Owner: "Scott Stapp" },
      ],
    });
    expect(report.errors).toEqual([]);

    const rows = await events();
    const byTeam = rows.find((e) => e.title === "Invoice Submitted")!;
    expect(byTeam.ownerTeamId).toBe(teamId); // matched case-insensitively
    expect(byTeam.ownerMemberId).toBeNull();
    const byPerson = rows.find((e) => e.title === "Raytheon Investor Briefing")!;
    expect(byPerson.ownerMemberId).toBe(memberId);
    expect(byPerson.ownerTeamId).toBeNull();
  });

  it("warns without failing the row when an owner or deliverable is unknown", async () => {
    const report = await runEntityImport(ctx(), {
      entity: "programEvent",
      mode: "commit",
      mapping: {
        Event: "title", Category: "category", "Start date": "startDate",
        Owner: "owner", Deliverable: "deliverable",
      },
      rows: [{
        Event: "ACC-RI Contracts Meeting Placeholder", Category: "Contracts",
        "Start date": "11/13/2026", Owner: "Someone Else", Deliverable: "No Such CDRL",
      }],
    });

    expect(report.created).toBe(1);
    expect(report.skipped).toBe(0);
    expect(report.errors.map((e) => e.message).join(" ")).toMatch(/Someone Else/);
    expect(report.errors.map((e) => e.message).join(" ")).toMatch(/No Such CDRL/);

    const ev = (await events()).find((e) => e.title === "ACC-RI Contracts Meeting Placeholder")!;
    expect(ev.ownerTeamId).toBeNull();
    expect(ev.ownerMemberId).toBeNull();
    expect(ev.deliverableId).toBeNull();
  });

  it("links a deliverable by title", async () => {
    await runEntityImport(ctx(), {
      entity: "programEvent",
      mode: "commit",
      mapping: { Event: "title", Category: "category", "Start date": "startDate", Deliverable: "deliverable" },
      rows: [{
        Event: "CDRL due", Category: "Deliverables",
        "Start date": "11/30/2026", Deliverable: "monthly status report",
      }],
    });
    const ev = (await events()).find((e) => e.title === "CDRL due")!;
    expect(ev.deliverableId).toBe(deliverableId);
  });

  it("skips a row whose start date cannot be read, and says which cell", async () => {
    const report = await runEntityImport(ctx(), {
      entity: "programEvent",
      mode: "validate",
      mapping: { Event: "title", Category: "category", "Start date": "startDate" },
      rows: [{ Event: "Some day", Category: "Engagements", "Start date": "TBD" }],
    });
    expect(report.willCreate).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.errors[0].message).toMatch(/TBD/);
  });

  it("writes nothing in validate mode", async () => {
    const before = (await events()).length;
    const report = await runEntityImport(ctx(), {
      entity: "programEvent",
      mode: "validate",
      mapping: { Event: "title", Category: "category", "Start date": "startDate" },
      rows: [{ Event: "Never written", Category: "Brand New Category", "Start date": "12/01/2026" }],
    });
    expect(report.willCreate).toBe(1);
    expect((await events()).length).toBe(before);
    // Not even the category it would have had to create.
    expect(await prisma.eventCategory.count({ where: { orgId, name: "Brand New Category" } })).toBe(0);
  });

  it("refuses to run as a project-scoped import", async () => {
    // The org door is the only one that supplies a project of null; the project
    // route refuses this entity outright. If it ever got through, the engine
    // must fail loudly rather than write half-scoped rows.
    const report = await runEntityImport(
      { orgId, projectId, userId, auth: authFor(userId, orgId) },
      {
        entity: "deliverable",
        mode: "commit",
        mapping: { Code: "code", Title: "title" },
        rows: [{ Code: "CDRL-ZZZ", Title: "fine here" }],
      },
    );
    expect(report.created).toBe(1); // control: a project-scoped import still works

    await expect(
      runEntityImport(
        { orgId, projectId: null, userId, auth: authFor(userId, orgId) },
        {
          entity: "deliverable",
          mode: "validate",
          mapping: { Code: "code", Title: "title" },
          rows: [{ Code: "CDRL-YYY", Title: "nowhere to put it" }],
        },
      ),
    ).rejects.toThrow(/imports into a project/);
  });
});

// ── The real files ──────────────────────────────────────────────────────────
//
// Skipped when absent (they are a developer's downloads, not fixtures in the
// repo), so CI stays green — but when they ARE present they are the only check
// that the registry's synonyms match the headers a person actually exports.
const DOWNLOADS = join(homedir(), "Downloads");
const CSV = join(DOWNLOADS, "pm-calendar-import-fy27.csv");
const XLSX = join(DOWNLOADS, "program-calendar-2026-11-10.xlsx");

/** Read a file from disk through the SAME parser the wizard uses. */
async function parseLocalFile(path: string) {
  const file = new File([new Uint8Array(readFileSync(path))], path.split("/").pop()!);
  const wb = await parseWorkbook(file);
  const sheet = wb.sheets[0];
  return matrixToObjects(sheet.matrix, guessHeaderRow(sheet.matrix));
}

describe.skipIf(!existsSync(CSV) && !existsSync(XLSX))("the real export files", () => {
  // Their OWN org. The inline fixtures above are drawn from these very files,
  // so sharing one would make "created === rows" read as a failure when the
  // importer had correctly UPDATED a row an earlier test created.
  let fileOrgId = "";
  const fileCtx = () => ({ orgId: fileOrgId, projectId: null, userId, auth: authFor(userId, fileOrgId) });
  const fileEvents = () =>
    prisma.programEvent.findMany({ where: { orgId: fileOrgId }, select: { id: true, timeZone: true } });

  beforeAll(async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fileOrgId = (await prisma.organization.create({
      data: { name: `pc files ${stamp}`, slug: `pc-files-${stamp}` },
    })).id;
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: fileOrgId } }).catch(() => undefined);
  });

  it.skipIf(!existsSync(CSV))("imports pm-calendar-import-fy27.csv", async () => {
    const parsed = await parseLocalFile(CSV);
    expect(parsed.rows.length).toBeGreaterThan(10); // the file really parsed

    const mapping = autoMap(parsed.headers);
    // Every column this file carries that the model has a home for.
    expect(mapping).toMatchObject({
      "External ID": "externalId", Title: "title", Category: "category",
      "Start date": "startDate", "End date": "endDate", "Start time": "startTime",
      "End time": "endTime", "All day": "allDay", "Time zone": "timeZone",
      Location: "location", Owner: "owner", Attendees: "attendees",
      Recurrence: "recurrence", Description: "description",
      "Show on PM Dashboard": "showOnDashboard",
    });
    // `Excluded dates` has no destination on ProgramEvent. It stays UNMAPPED on
    // purpose, so the wizard shows it as ignored and nobody believes it landed.
    expect(mapping["Excluded dates"]).toBe("__ignore__");

    const first = await runEntityImport(fileCtx(), { entity: "programEvent", mode: "commit", mapping, rows: parsed.rows });
    const blocking = first.errors.filter((e) => /Missing required|is not a date/.test(e.message));
    expect(blocking).toEqual([]);
    expect(first.created).toBe(parsed.rows.length);

    // Re-import: the same file must not grow the calendar.
    const before = (await fileEvents()).length;
    const again = await runEntityImport(fileCtx(), { entity: "programEvent", mode: "commit", mapping, rows: parsed.rows });
    expect(again.created).toBe(0);
    expect(again.updated).toBe(parsed.rows.length);
    expect((await fileEvents()).length).toBe(before);
  });

  it.skipIf(!existsSync(XLSX))("imports program-calendar-2026-11-10.xlsx", async () => {
    const parsed = await parseLocalFile(XLSX);
    expect(parsed.rows.length).toBeGreaterThan(5);

    const mapping = autoMap(parsed.headers);
    // Different headers from the CSV — `Event` not `Title`, plus three columns
    // the CSV does not have at all.
    expect(mapping).toMatchObject({
      Event: "title", Category: "category", "Start date": "startDate",
      "End date": "endDate", "Start time": "startTime", "End time": "endTime",
      "All day": "allDay", "Time zone": "timeZone", Location: "location",
      Owner: "owner", Attendees: "attendees", Recurrence: "recurrence",
      "Show on PM Dashboard": "showOnDashboard",
      "Customer attending": "customerAttending", Deliverable: "deliverable",
      Description: "description",
    });
    // Like `Excluded dates`: this one has no destination either, and guessing
    // that it means the time zone would be a guess.
    expect(mapping["Entered in"]).toBe("__ignore__");

    const first = await runEntityImport(fileCtx(), { entity: "programEvent", mode: "commit", mapping, rows: parsed.rows });
    const blocking = first.errors.filter((e) => /Missing required|is not a date/.test(e.message));
    expect(blocking).toEqual([]);
    expect(first.created! + first.updated!).toBe(parsed.rows.length);

    const before = (await fileEvents()).length;
    const again = await runEntityImport(fileCtx(), { entity: "programEvent", mode: "commit", mapping, rows: parsed.rows });
    expect(again.created).toBe(0);
    expect(again.updated).toBe(parsed.rows.length);
    expect((await fileEvents()).length).toBe(before);

    // Every stored zone must be one Intl will accept — the workbook's own
    // column says "Eastern (ET)".
    for (const ev of await fileEvents()) {
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: ev.timeZone })).not.toThrow();
    }
  });
});

describe("an import resolves and claims only what its caller may see", () => {
  // Both of these were flagged by review AFTER the importer was written, and
  // neither was reachable by the specs above: they all run as an org ADMIN,
  // who can see every project, so the narrowing is invisible from there.
  // `ORG_IMPORT` is an owner/admin permission by stock roles — but a work role
  // can hand it to an ordinary member, and that is the case these cover.
  let hiddenTeamId = "", hiddenProjectId = "", plainUserId = "", extId = "";

  const memberAuth = () =>
    ({ userId: plainUserId, orgId, orgRole: "MEMBER", abacRules: [], permissions: -1n, basePermissions: -1n }) as unknown as import("@/lib/rbac/check").AuthContext;

  beforeAll(async () => {
    const s = Math.random().toString(36).slice(2, 7);
    extId = `collide-${s}`;
    plainUserId = (await prisma.user.create({
      data: { email: `plain-${s}@test.local`, displayName: "Plain Member" },
    })).id;
    await prisma.orgMember.create({ data: { orgId, userId: plainUserId } });
    hiddenProjectId = (await prisma.project.create({
      data: { orgId, name: "Hidden", key: `HID${s.slice(0, 3).toUpperCase()}`, teamScopedAccess: true },
    })).id;
    hiddenTeamId = (await prisma.team.create({
      data: { orgId, projectId: hiddenProjectId, name: `Hidden Team ${s}` },
    })).id;
  });

  const importOwner = (auth: ReturnType<typeof memberAuth>, owner: string, title: string) =>
    runEntityImport(
      { orgId, projectId: null, userId, auth },
      {
        entity: "programEvent",
        mode: "commit",
        mapping: { Title: "title", Category: "category", "Start date": "startDate", "All day": "allDay", Owner: "owner" },
        rows: [{ Title: title, Category: "Engagements", "Start date": "2026-11-05", "All day": "Yes", Owner: owner }],
      },
    );

  it("does not resolve a team on a project the importer cannot open", async () => {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: hiddenTeamId }, select: { name: true } });
    const report = await importOwner(memberAuth(), team.name, "Hidden owner attempt");
    const row = await prisma.programEvent.findFirstOrThrow({
      where: { orgId, title: "Hidden owner attempt" },
      select: { ownerTeamId: true },
    });
    // Unresolved, and warned rather than failed — the same answer an absent
    // name gets, so the warning cannot be used to probe for the team.
    expect(row.ownerTeamId).toBeNull();
    // A non-blocking warning: the row still imports, the owner is just not set.
    expect(report.created).toBe(1);
    expect(report.errors.map((e) => e.message).join(" ")).toMatch(/Hidden Team/i);
  });

  it("still resolves it for someone who CAN open that project", async () => {
    // The positive control: without this, a lookup that resolved nothing at
    // all would satisfy the assertion above.
    const team = await prisma.team.findUniqueOrThrow({ where: { id: hiddenTeamId }, select: { name: true } });
    await importOwner(authFor(userId, orgId), team.name, "Admin owner attempt");
    const row = await prisma.programEvent.findFirstOrThrow({
      where: { orgId, title: "Admin owner attempt" },
      select: { ownerTeamId: true },
    });
    expect(row.ownerTeamId).toBe(hiddenTeamId);
  });

  it("never UPDATES a project-scoped event, even on an exact external-id match", async () => {
    // The importer only ever creates ORG-LEVEL events, so org-level is the
    // only scope its create-or-update may claim. Without that, a row whose
    // external id collided with a project's event would edit that project's
    // calendar from outside it.
    const victim = await prisma.programEvent.create({
      data: {
        orgId, projectId: hiddenProjectId, title: "Belongs to the hidden project",
        categoryId: (await prisma.eventCategory.findFirstOrThrow({ where: { orgId }, select: { id: true } })).id,
        startsAt: new Date(Date.UTC(2026, 10, 5)), endsAt: new Date(Date.UTC(2026, 10, 6)),
        allDay: true, externalId: extId, createdById: userId,
      },
      select: { id: true },
    });

    const report = await runEntityImport(
      { orgId, projectId: null, userId, auth: authFor(userId, orgId) },
      {
        entity: "programEvent",
        mode: "commit",
        mapping: { "External ID": "externalId", Title: "title", Category: "category", "Start date": "startDate", "All day": "allDay" },
        rows: [{ "External ID": extId, Title: "Imported, not the victim", Category: "Engagements", "Start date": "2026-11-05", "All day": "Yes" }],
      },
    );

    const after = await prisma.programEvent.findUniqueOrThrow({
      where: { id: victim.id },
      select: { title: true, projectId: true },
    });
    expect(after.title).toBe("Belongs to the hidden project");
    expect(after.projectId).toBe(hiddenProjectId);
    // And the row is REFUSED rather than silently creating a second event
    // under the same external id — the unique index is org-wide, so there is
    // no org-level row it could legally take. The message says why.
    expect(report.created).toBe(0);
    expect(report.errors.map((e) => e.message).join(" ")).toMatch(/already belongs to an event filed under a project/);
    const created = await prisma.programEvent.findFirst({
      where: { orgId, title: "Imported, not the victim" },
      select: { projectId: true },
    });
    expect(created).toBeNull();
  });
});
