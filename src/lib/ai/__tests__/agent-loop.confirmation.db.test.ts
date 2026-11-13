// @vitest-environment node
//
// Confirm-class tools (deletes, member removals, closing a ceremony, bulk
// changes) run only after the USER has answered a preview. This is enforced in
// the agent loop, not left to the prompt: a call without a token gets a
// preview and a token back and changes nothing; the token commits only in a
// later run, started by a new user message, with the same arguments and the
// same resolved targets, once, within five minutes.
//
// The real loop, the real executors and a real database. Only the model (a
// script) and the audit sinks are doubled.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

process.env.SSO_VAULT_KEY = Buffer.alloc(32, 7).toString("base64");

const { runModelTurn, logEgressDecision } = vi.hoisted(() => ({ runModelTurn: vi.fn(), logEgressDecision: vi.fn() }));
vi.mock("../egress", async (importOriginal) => ({ ...(await importOriginal<object>()), runModelTurn, logEgressDecision }));
vi.mock("@/lib/audit", async (importOriginal) => ({ ...(await importOriginal<object>()), logAudit: vi.fn() }));
vi.mock("@/lib/runtime-config", () => ({
  getRuntimeConfig: vi.fn().mockResolvedValue({ enabledConnectors: null, breadthEnabled: true, mcpEnabled: false }),
}));
vi.mock("../policy", () => ({
  getAgentPolicy: vi.fn().mockResolvedValue({ allowedTools: null, deniedTools: [], deniedDomains: [], maxResultLimit: null, allowedProjectIds: null }),
}));

import { prisma } from "@/lib/db/client";
import { memberToolCtx } from "@/lib/testing/tool-auth";
import { withCqlEnabled } from "@/lib/query/flag";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import type { ToolContext } from "../executors/_ctx";
import { runAgentLoop } from "../agent-loop";
import { confirmationChannel, confirmationGate } from "../confirmation";

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const k = stamp.slice(-4).toUpperCase();
const userIds: string[] = [];
let orgId = "", projectId = "", typeId = "", ownerId = "", otherId = "";
let owner: ToolContext;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function user(name: string) {
  const u = await prisma.user.create({ data: { email: `${name}-${stamp}@example.com`, displayName: name } });
  userIds.push(u.id);
  return u.id;
}
const item = async (title: string) =>
  (await createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById: ownerId, title, columnKey: "todo" })).id;
const priorities = async (ids: string[]) =>
  Object.fromEntries((await prisma.workItem.findMany({ where: { id: { in: ids } }, select: { id: true, priority: true } })).map((r) => [r.id, r.priority]));

/** A conversation with the user's first message in it, as the messages route leaves it before the run. */
async function conversation(userId = ownerId) {
  const c = await prisma.assistantConversation.create({ data: { orgId, userId } });
  await say(c.id, "please do it");
  return c.id;
}
/** The user sends a message: what starts the next run. */
async function say(conversationId: string, content: string) {
  await sleep(15); // a later createdAt than anything before it
  await prisma.assistantMessage.create({ data: { conversationId, role: "USER", content } });
}

type ToolUse = { name: string; input: Record<string, unknown> };
type Result = Record<string, unknown> & { error?: string; confirmationToken?: string };

/**
 * One run of the loop. Each entry of `turns` is one model turn's tool calls, or a
 * function that builds them from the results so far (to carry a token forward
 * inside a single run). The model then stops.
 */
async function run(conversationId: string, turns: (ToolUse[] | ((seen: Result[]) => ToolUse[]))[], actor: ToolContext = owner) {
  runModelTurn.mockReset();
  let n = 0;
  for (const t of turns) {
    runModelTurn.mockImplementationOnce(async (arg: { messages: { role: string; content: unknown }[] }) => {
      const seen: Result[] = [];
      for (const m of arg.messages) {
        if (Array.isArray(m.content)) {
          for (const b of m.content as { type: string; content: string }[]) if (b.type === "tool_result") seen.push(JSON.parse(b.content));
        }
      }
      const calls = typeof t === "function" ? t(seen) : t;
      return { text: "", toolUses: calls.map((c) => ({ id: `tu-${n++}`, ...c })), stopReason: "tool_use" };
    });
  }
  runModelTurn.mockResolvedValueOnce({ text: "done", toolUses: [], stopReason: "end_turn" });
  const res = await runAgentLoop({
    orgId, userId: actor.userId, auth: actor.auth, tenantClass: "commercial", conversationId,
    systemPrompt: "sys", initialPrompt: "hi",
  });
  const first = runModelTurn.mock.calls[0][0] as { system: string; tools: { name: string; input_schema: { properties?: Record<string, unknown> } }[] };
  const lastCall = runModelTurn.mock.calls.at(-1)![0] as { messages: { role: string; content: unknown }[] };
  const results: Result[] = [];
  for (const m of lastCall.messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content as { type: string; content: string }[]) if (b.type === "tool_result") results.push(JSON.parse(b.content));
    }
  }
  return { res, results, system: first.system, offered: first.tools.map((t) => t.name), tools: first.tools };
}

const bulk = (input: Record<string, unknown>): ToolUse => ({ name: "bulk_update_work_items", input });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `confirm ${stamp}`, slug: `confirm-${stamp}` } })).id;
  ownerId = await user("owner");
  otherId = await user("other");
  await prisma.orgMember.create({ data: { orgId, userId: ownerId, role: "OWNER" } });
  await prisma.orgMember.create({ data: { orgId, userId: otherId, role: "OWNER" } });
  projectId = (await prisma.project.create({ data: { orgId, name: "Confirm", key: `CFM${k}` } })).id;
  typeId = (await prisma.workItemType.create({ data: { orgId, key: `task-${stamp}`, name: "Task" } })).id;
  await ensureFixtureStatuses(projectId, ["todo", "done"], { done: "DONE" });
  owner = await memberToolCtx(orgId, ownerId);
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
});

beforeEach(() => logEgressDecision.mockReset());

describe("a confirm-class call without a token", () => {
  it("changes nothing, and hands back a preview with the targets, the change and a token", async () => {
    const ids = [await item("p1"), await item("p2")];
    const conv = await conversation();
    const { results, res, tools } = await run(conv, [[bulk({ ids, priority: "LOW" })]]);

    expect(Object.values(await priorities(ids))).not.toContain("LOW");
    const preview = results[0];
    expect(preview.status).toBe("confirmation_required");
    expect(preview.tool).toBe("bulk_update_work_items");
    expect(preview.targetIds).toEqual([...ids].sort());
    expect(preview.targetCount).toBe(2);
    expect(preview.change).toEqual({ ids, priority: "LOW" });
    expect(preview.confirmationToken).toMatch(/^cf1\./);
    // The token is the model's to carry; the UI trail of the call doesn't keep it.
    expect(JSON.stringify(res.toolCalls[0].result)).not.toContain(preview.confirmationToken!);
    expect((res.toolCalls[0].result as Result).status).toBe("confirmation_required");
    // The model is told the argument exists.
    expect(tools.find((t) => t.name === "bulk_update_work_items")?.input_schema.properties).toHaveProperty("confirmationToken");
  });
});

describe("a token commits only after the user answers", () => {
  it("is refused in the same run that issued it, before the user has said anything", async () => {
    const ids = [await item("s1"), await item("s2")];
    const conv = await conversation();
    const { results } = await run(conv, [
      [bulk({ ids, priority: "LOW" })],
      (seen) => [bulk({ ids, priority: "LOW", confirmationToken: seen[0].confirmationToken })],
    ]);
    expect(results[0].status).toBe("confirmation_required");
    expect(results[1].error).toMatch(/has not answered/i);
    expect(Object.values(await priorities(ids))).not.toContain("LOW");
  });

  it("positive control: preview, the user says yes, then the same call with the token commits", async () => {
    const ids = [await item("y1"), await item("y2")];
    const conv = await conversation();
    const first = await run(conv, [[bulk({ ids, priority: "LOW" })]]);
    const token = first.results[0].confirmationToken!;
    expect(Object.values(await priorities(ids))).not.toContain("LOW");

    await say(conv, "yes");
    const second = await run(conv, [[bulk({ ids, priority: "LOW", confirmationToken: token })]]);
    // The next run is told what is waiting, since the chat history carries text only.
    expect(second.system).toContain(token);
    expect(second.results[0].error).toBeUndefined();
    expect(second.results[0].updated).toBe(2);
    expect(Object.values(await priorities(ids))).toEqual(["LOW", "LOW"]);

    // ...and it is single use, even after another user message.
    await prisma.workItem.updateMany({ where: { id: { in: ids } }, data: { priority: "MEDIUM" } });
    await say(conv, "do it again");
    const third = await run(conv, [[bulk({ ids, priority: "LOW", confirmationToken: token })]]);
    expect(third.system).not.toContain(token);
    expect(third.results[0].error).toMatch(/already been used/i);
    expect(Object.values(await priorities(ids))).toEqual(["MEDIUM", "MEDIUM"]);
  });

  it("two instances spending the same token at once: exactly one goes through", async () => {
    const ids = [await item("r1")];
    const conv = await conversation();
    const token = (await run(conv, [[bulk({ ids, priority: "LOW" })]])).results[0].confirmationToken!;
    await say(conv, "yes");
    const channel = (await confirmationChannel({ orgId, userId: ownerId, conversationId: conv }))!;
    const args = { ids, priority: "LOW", confirmationToken: token };
    const spend = () => confirmationGate({ channel, orgId, userId: ownerId, toolName: "bulk_update_work_items", args, execInput: args, ctx: owner });
    const outcomes = await Promise.all([spend(), spend(), spend()]);
    expect(outcomes.filter((o) => o.kind === "proceed")).toHaveLength(1);
    // The one that proceeds runs without the token in its arguments.
    expect(outcomes.find((o) => o.kind === "proceed")).toEqual({ kind: "proceed", execInput: { ids, priority: "LOW" } });
  });

  it("is refused after five minutes", async () => {
    const ids = [await item("e1")];
    const conv = await conversation();
    const token = (await run(conv, [[bulk({ ids, priority: "LOW" })]])).results[0].confirmationToken!;
    await say(conv, "yes");
    const realNow = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(realNow + 6 * 60_000);
    try {
      const { results } = await run(conv, [[bulk({ ids, priority: "LOW", confirmationToken: token })]]);
      expect(results[0].error).toMatch(/expired/i);
    } finally {
      spy.mockRestore();
    }
    expect(Object.values(await priorities(ids))).not.toContain("LOW");
  });

  it("is refused when the arguments changed", async () => {
    const ids = [await item("a1"), await item("a2")];
    const conv = await conversation();
    const token = (await run(conv, [[bulk({ ids, priority: "LOW" })]])).results[0].confirmationToken!;
    await say(conv, "yes");
    const { results } = await run(conv, [[bulk({ ids, priority: "HIGH", confirmationToken: token })]]);
    expect(results[0].error).toMatch(/differ/i);
    const after = Object.values(await priorities(ids));
    expect(after).not.toContain("LOW");
    expect(after).not.toContain("HIGH");
  });

  it("is refused when the selection now resolves to different items", async () => {
    const tag = `sel${k}`;
    const ids = [await item(`${tag} one`), await item(`${tag} two`)];
    const conv = await conversation();
    const args = { cql: `project = CFM${k} AND title ~ "${tag}"`, priority: "LOW" };
    const first = await run(conv, [[bulk(args)]]);
    expect(first.results[0].targetIds).toEqual([...ids].sort());
    const token = first.results[0].confirmationToken!;
    const late = await item(`${tag} three`); // matches the same query now
    await say(conv, "yes");
    const { results } = await run(conv, [[bulk({ ...args, confirmationToken: token })]]);
    expect(results[0].error).toMatch(/selection has changed/i);
    expect(Object.values(await priorities([...ids, late]))).not.toContain("LOW");
  });

  it("is refused in another conversation", async () => {
    const ids = [await item("c1")];
    const conv = await conversation();
    const token = (await run(conv, [[bulk({ ids, priority: "LOW" })]])).results[0].confirmationToken!;
    const elsewhere = await conversation();
    await say(elsewhere, "yes");
    const { results } = await run(elsewhere, [[bulk({ ids, priority: "LOW", confirmationToken: token })]]);
    expect(results[0].error).toMatch(/not valid/i);
    expect(Object.values(await priorities(ids))).not.toContain("LOW");
  });

  it("is refused with a forged MAC, and when its row was altered in the database", async () => {
    const ids = [await item("m1")];
    const conv = await conversation();
    const token = (await run(conv, [[bulk({ ids, priority: "LOW" })]])).results[0].confirmationToken!;
    await say(conv, "yes");
    const [v, kid, nonce, sig] = token.split(".");
    const forged = `${v}.${kid}.${nonce}.${sig.slice(0, -2)}${sig.endsWith("AA") ? "BB" : "AA"}`;
    expect((await run(conv, [[bulk({ ids, priority: "LOW", confirmationToken: forged })]])).results[0].error).toMatch(/not valid/i);
    // Someone with database access stretches the expiry: the MAC covers it.
    await prisma.assistantConfirmation.update({ where: { id: nonce }, data: { expiresAt: new Date(Date.now() + 3_600_000) } });
    expect((await run(conv, [[bulk({ ids, priority: "LOW", confirmationToken: token })]])).results[0].error).toMatch(/not valid/i);
    expect(Object.values(await priorities(ids))).not.toContain("LOW");
  });

  it("a single delete goes through the same steps", async () => {
    const id = await item("to delete");
    const conv = await conversation();
    const del = (extra: Record<string, unknown> = {}) => ({ name: "delete_work_item", input: { itemId: id, ...extra } });
    const first = await run(conv, [[del()]]);
    expect(first.results[0].status).toBe("confirmation_required");
    expect(first.results[0].targetIds).toEqual([id]);
    expect(await prisma.workItem.count({ where: { id } })).toBe(1);
    await say(conv, "yes, delete it");
    const second = await run(conv, [[del({ confirmationToken: first.results[0].confirmationToken })]]);
    expect(second.results[0].deleted).toBe(true);
    expect(await prisma.workItem.count({ where: { id } })).toBe(0);
  });
});

// Adding someone to a project or a team grants them access (on a project
// limited to its team, sight of the project itself), and sharing a saved view
// changes who sees it. A prompt injection in anything Cosmo reads must not be
// able to do either on the model's word: same preview, same token, same
// single use.
describe("a change of access needs the user's yes", () => {
  async function orgMember(name: string) {
    const userId = await user(name);
    const om = await prisma.orgMember.create({ data: { orgId, userId, role: "MEMBER" } });
    return { userId, orgMemberId: om.id };
  }

  /** Preview, then yes and commit, then the same token again after another message. */
  async function previewYesReplay(call: (token?: string) => ToolUse, written: () => Promise<boolean>) {
    const conv = await conversation();
    const first = await run(conv, [[call()]]);
    expect(first.results[0].status).toBe("confirmation_required");
    expect(first.results[0].confirmationToken).toMatch(/^cf1\./);
    expect(await written()).toBe(false);

    await say(conv, "yes");
    const token = first.results[0].confirmationToken!;
    const second = await run(conv, [[call(token)]]);
    expect(second.results[0].error).toBeUndefined();
    expect(await written()).toBe(true);

    await say(conv, "and again");
    const third = await run(conv, [[call(token)]]);
    expect(third.results[0].error).toMatch(/already been used/i);
    return third;
  }

  it("add_project_member: a preview writes nothing; the yes adds them; the token is single use", async () => {
    const p = await orgMember("joiner");
    const add = (token?: string): ToolUse => ({
      name: "add_project_member",
      input: { projectId, userId: p.userId, ...(token ? { confirmationToken: token } : {}) },
    });
    const onProject = async () => (await prisma.projectMember.count({ where: { projectId, orgMemberId: p.orgMemberId } })) === 1;
    await previewYesReplay(add, onProject);

    // A replay after they were taken off adds nothing back.
    await prisma.projectMember.deleteMany({ where: { projectId, orgMemberId: p.orgMemberId } });
    const conv = await conversation();
    const token = (await run(conv, [[add()]])).results[0].confirmationToken!;
    await say(conv, "yes");
    await run(conv, [[add(token)]]);
    await prisma.projectMember.deleteMany({ where: { projectId, orgMemberId: p.orgMemberId } });
    await say(conv, "once more");
    expect((await run(conv, [[add(token)]])).results[0].error).toMatch(/already been used/i);
    expect(await onProject()).toBe(false);
  });

  it("add_team_member: the same steps", async () => {
    const p = await orgMember("teamer");
    const pm = await prisma.projectMember.create({ data: { projectId, orgMemberId: p.orgMemberId, role: "MEMBER" } });
    const team = await prisma.team.create({ data: { orgId, projectId, name: `Team ${stamp}` } });
    const add = (token?: string): ToolUse => ({
      name: "add_team_member",
      input: { projectId, teamId: team.id, userId: p.userId, ...(token ? { confirmationToken: token } : {}) },
    });
    await previewYesReplay(add, async () => (await prisma.teamMember.count({ where: { teamId: team.id, projectMemberId: pm.id } })) === 1);
  });

  it("share_saved_view: the same steps", async () => {
    const view = await prisma.savedView.create({ data: { orgId, ownerId, name: `View ${stamp}`, cqlText: "priority = HIGH" } });
    const share = (token?: string): ToolUse => ({
      name: "share_saved_view",
      input: { viewId: view.id, visibility: "PROJECT", projectId, ...(token ? { confirmationToken: token } : {}) },
    });
    await previewYesReplay(share, async () => (await prisma.savedView.findUniqueOrThrow({ where: { id: view.id } })).visibility === "PROJECT");
  });

  it("create_saved_view saves private when asked to share, and sharing it still waits for a yes", async () => {
    const { settings } = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } });
    await prisma.organization.update({ where: { id: orgId }, data: { settings: withCqlEnabled(settings, true) as object } });
    try {
      const conv = await conversation();
      const name = `Asked ${stamp}`;
      const made = await run(conv, [[{ name: "create_saved_view", input: { name, cql: "priority = HIGH", visibility: "PROJECT", projectId } }]]);
      // Not confirm-class, so it ran: the filter is saved, private.
      expect(made.results[0]).toMatchObject({ created: true, visibility: "PRIVATE", requestedVisibility: "PROJECT" });
      const view = await prisma.savedView.findFirstOrThrow({ where: { orgId, name } });
      expect(view).toMatchObject({ visibility: "PRIVATE", projectId: null });

      const share = (token?: string): ToolUse => ({
        name: "share_saved_view",
        input: { viewId: view.id, visibility: "PROJECT", projectId, ...(token ? { confirmationToken: token } : {}) },
      });
      await previewYesReplay(share, async () => (await prisma.savedView.findUniqueOrThrow({ where: { id: view.id } })).visibility === "PROJECT");
    } finally {
      await prisma.organization.update({ where: { id: orgId }, data: { settings: (settings ?? {}) as object } });
    }
  });

  it("is not offered where the user can't be asked", async () => {
    const { offered } = await run("00000000-0000-4000-8000-000000000000", [[]]);
    for (const n of ["add_project_member", "add_team_member", "share_saved_view"]) expect(offered).not.toContain(n);
    // Positive control: reading people still is.
    expect(offered).toContain("list_project_members");
  });
});

describe("a run with no way to ask the user", () => {
  it("is not offered a confirm-class tool, and a forged call to one does nothing", async () => {
    const ids = [await item("n1")];
    const noConversation = "00000000-0000-4000-8000-000000000000";
    const { offered, results } = await run(noConversation, [[bulk({ ids, priority: "LOW" })]]);
    for (const n of ["bulk_update_work_items", "delete_work_item", "remove_project_member", "close_ceremony"]) expect(offered).not.toContain(n);
    // Positive control: ordinary writes are still offered, so the absence is the confirmation rule.
    expect(offered).toContain("update_work_item");
    expect(results[0].error).toMatch(/not available/);
    expect(Object.values(await priorities(ids))).not.toContain("LOW");
  });

  it("someone else's conversation is no channel either", async () => {
    const theirs = await conversation(otherId);
    const { offered } = await run(theirs, [[]]);
    expect(offered).not.toContain("bulk_update_work_items");
    // Positive control: the same user's own conversation offers it.
    const mine = await conversation();
    expect((await run(mine, [[]])).offered).toContain("bulk_update_work_items");
  });
});
