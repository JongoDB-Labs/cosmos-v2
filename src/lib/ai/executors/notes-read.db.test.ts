// @vitest-environment node
//
// `list_notes` is the read the notes surface never had: create/update/delete all
// shipped and nothing could list one, so the two tools taking a `noteId` had no
// way to learn an id.
//
// THE VISIBILITY RULE IS THE RISK, not the listing. `Note.visibility` defaults to
// PRIVATE, so a plain org-scoped list hands every member everybody else's private
// notes. These specs use TWO real members from the database and assert the
// boundary between them, which a single-actor fixture cannot show.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { listNotes, createNote } from "./notes";
import { memberToolCtx } from "@/lib/testing/tool-auth";
import type { ToolContext } from "@/lib/ai/executors/_ctx";

describe("list_notes visibility (e2e DB)", () => {
  const cleanup: { orgIds: string[] } = { orgIds: [] };
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: cleanup.orgIds } } }).catch(() => undefined);
  });

  let mine: ToolContext;
  let theirs: ToolContext;

  beforeAll(async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const a = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const b = await prisma.user.findFirstOrThrow({ where: { email: "bob@test.local" } });
    const org = await prisma.organization.create({
      data: { name: `notes-vis ${stamp}`, slug: `notes-vis-${stamp}` },
    });
    cleanup.orgIds.push(org.id);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: a.id, role: "OWNER" } });
    await prisma.orgMember.create({ data: { orgId: org.id, userId: b.id, role: "MEMBER" } });
    mine = await memberToolCtx(org.id, a.id);
    theirs = await memberToolCtx(org.id, b.id);

    // Through the TOOL, so the default visibility is whatever create_note
    // really applies rather than whatever this spec assumes.
    await createNote({ title: "alice-private" }, mine);
    await createNote({ title: "alice-org", visibility: "ORG" }, mine);
    await createNote({ title: "bob-private" }, theirs);
  });

  const titles = async (ctx: ToolContext, input: Record<string, unknown> = {}) => {
    const out = (await listNotes(input, ctx)) as { notes?: { title: string }[]; error?: string };
    expect(out.error).toBeUndefined();
    return (out.notes ?? []).map((n) => n.title).sort();
  };

  it("create_note really does default to PRIVATE", async () => {
    // The premise of every assertion below. If the default were ORG, the
    // leak specs would pass while proving nothing.
    const row = await prisma.note.findFirstOrThrow({ where: { title: "alice-private" } });
    expect(row.visibility).toBe("PRIVATE");
  });

  it("does NOT leak another member's private note", async () => {
    // The whole reason this tool needed the route's clause rather than an
    // org scope.
    expect(await titles(mine)).toEqual(["alice-org", "alice-private"]);
    expect(await titles(theirs)).toEqual(["alice-org", "bob-private"]);
  });

  it("visibility=PRIVATE returns only the caller's own", async () => {
    expect(await titles(mine, { visibility: "PRIVATE" })).toEqual(["alice-private"]);
    expect(await titles(theirs, { visibility: "PRIVATE" })).toEqual(["bob-private"]);
  });

  it("visibility=ORG returns the shared note to both", async () => {
    expect(await titles(mine, { visibility: "ORG" })).toEqual(["alice-org"]);
    expect(await titles(theirs, { visibility: "ORG" })).toEqual(["alice-org"]);
  });

  it("never returns the note BODY", async () => {
    // Free text; excluded from EXPOSABLE_FIELDS and so dropped on a withheld
    // tenant anyway. A list answer must not dump prose.
    const out = (await listNotes({}, mine)) as { notes: Record<string, unknown>[] };
    expect(out.notes.length).toBeGreaterThan(0);
    for (const n of out.notes) expect(n).not.toHaveProperty("content");
    // Control: it does return the fields it claims to.
    expect(out.notes[0]).toHaveProperty("title");
    expect(out.notes[0]).toHaveProperty("visibility");
  });

  it("refuses a caller without NOTE_READ", async () => {
    const NON_MEMBER = "00000000-0000-0000-0000-000000000000";
    const org = cleanup.orgIds[0];
    const out = await listNotes({}, await memberToolCtx(org, NON_MEMBER));
    expect(out).toEqual({ error: "Insufficient permissions" });
  });

  it("an id from the list is usable by update_note", async () => {
    // The point of the tool: the write tools took a noteId nobody could obtain.
    const out = (await listNotes({ visibility: "PRIVATE" }, mine)) as { notes: { id: string }[] };
    expect(out.notes[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
