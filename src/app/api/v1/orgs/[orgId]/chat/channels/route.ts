import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, created, handleApiError } from "@/lib/api-helpers";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { logAudit } from "@/lib/audit";
import { getBus } from "@/lib/realtime/bus";
import { topics } from "@/lib/realtime/topics";
import { z } from "zod";

type RouteParams = { params: Promise<{ orgId: string }> };

// ─── GET /channels — list channels the auth'd user can see ────────────────
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const memberships = await prisma.chatChannelMember.findMany({
      where: { userId: ctx.userId, channel: { orgId, archivedAt: null } },
      include: {
        channel: {
          select: {
            id: true,
            kind: true,
            name: true,
            slug: true,
            description: true,
            topic: true,
            isPrivate: true,
            isGeneral: true,
            projectId: true,
            dmKey: true,
            lastMessageAt: true,
            members: {
              select: { userId: true },
              take: 5,
            },
          },
        },
      },
      orderBy: [{ channel: { lastMessageAt: "desc" } }],
    });

    // Hydrate display names of DM/GROUP_DM participants for the sidebar.
    const dmUserIds = Array.from(
      new Set(
        memberships
          .filter((m) => m.channel.kind !== "CHANNEL")
          .flatMap((m) => m.channel.members.map((cm) => cm.userId))
          .filter((id) => id !== ctx.userId),
      ),
    );
    const dmUsers = dmUserIds.length
      ? await prisma.user.findMany({
          where: { id: { in: dmUserIds } },
          select: { id: true, displayName: true, avatarUrl: true },
        })
      : [];
    const usersById = new Map(dmUsers.map((u) => [u.id, u]));

    const channels = memberships.map((m) => ({
      id: m.channel.id,
      kind: m.channel.kind,
      name: m.channel.name,
      slug: m.channel.slug,
      description: m.channel.description,
      topic: m.channel.topic,
      isPrivate: m.channel.isPrivate,
      isGeneral: m.channel.isGeneral,
      projectId: m.channel.projectId,
      lastMessageAt: m.channel.lastMessageAt,
      notificationPref: m.notificationPref,
      lastReadMessageId: m.lastReadMessageId,
      otherParticipants:
        m.channel.kind === "CHANNEL"
          ? []
          : m.channel.members
              .filter((cm) => cm.userId !== ctx.userId)
              .map(
                (cm) =>
                  usersById.get(cm.userId) ?? {
                    id: cm.userId,
                    displayName: "User",
                    avatarUrl: null,
                  },
              ),
    }));

    return success({ channels });
  } catch (e) {
    return handleApiError(e);
  }
}

// ─── POST /channels — create a public channel ────────────────────────────
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

const createSchema = z.object({
  name: z.string().min(1).max(32),
  slug: z.string().regex(SLUG_RE).optional(),
  description: z.string().max(512).optional(),
  // Phase 2: private channels are fully supported.
  isPrivate: z.boolean().default(false),
  projectId: z.string().uuid().optional(),
  initialMemberIds: z.array(z.string().uuid()).max(50).default([]),
});

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const limited = checkRateLimit(req, "chat.channel.create", ctx.userId, {
      capacity: 5,
      refillPerSecond: 0.2,
    });
    if (limited) return limited;

    const json = await req.json().catch(() => null);
    const parsed = createSchema.safeParse(json);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: "invalid_input", details: parsed.error.flatten() }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    const data = parsed.data;
    const slug =
      data.slug ??
      data.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    if (!SLUG_RE.test(slug)) {
      return new Response(JSON.stringify({ error: "invalid_slug" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    // Verify initialMemberIds are all org members
    if (data.initialMemberIds.length > 0) {
      const present = await prisma.orgMember.count({
        where: { orgId, userId: { in: data.initialMemberIds } },
      });
      if (present !== data.initialMemberIds.length) {
        return new Response(JSON.stringify({ error: "members_not_in_org" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // Verify projectId belongs to org
    if (data.projectId) {
      const proj = await prisma.project.findFirst({ where: { id: data.projectId, orgId } });
      if (!proj) {
        return new Response(JSON.stringify({ error: "invalid_project" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
    }

    const initialMemberIds = Array.from(new Set([ctx.userId, ...data.initialMemberIds]));

    const channel = await prisma.$transaction(async (tx) => {
      const c = await tx.chatChannel.create({
        data: {
          orgId,
          kind: "CHANNEL",
          name: data.name,
          slug,
          description: data.description,
          isPrivate: data.isPrivate,
          isGeneral: false,
          projectId: data.projectId,
          createdById: ctx.userId,
        },
      });
      await tx.chatChannelMember.createMany({
        data: initialMemberIds.map((userId) => ({
          channelId: c.id,
          userId,
          role: userId === ctx.userId ? "ADMIN" : "MEMBER",
        })),
      });
      return c;
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "chat.channel.created",
      entity: "chat_channel",
      entityId: channel.id,
      metadata: { name: channel.name, slug },
    });

    // Tell each new member to add this channel topic to their interest set.
    for (const userId of initialMemberIds) {
      void getBus().publish(topics.user(userId), "chat.channel.joined", { channelId: channel.id });
    }

    return created(channel);
  } catch (e) {
    return handleApiError(e);
  }
}
