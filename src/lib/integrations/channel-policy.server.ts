import { prisma } from "@/lib/db/client";
import { createClassificationResolver, type ClassificationResolver } from "@/lib/classification/resolver";

/**
 * What may be said in a channel outside Cosmos, such as the org's Teams
 * channel. Everyone in that channel reads it, whatever they may see in Cosmos,
 * so a post carries only what the whole org could read:
 *
 *  - nothing about a project that is archived, team-scoped (its records are
 *    for its team), or at a classification marking level;
 *  - no text that carries a classification marking (the title is left out and
 *    the ticket reference stays);
 *  - nothing from a private channel or a direct message.
 *
 * The Teams app's channel digest and the org-wide Teams notifications both use
 * it, so the two ways onto a Teams channel apply one rule.
 */

export type ChannelProject = { id: string; orgId: string; key: string; name: string };

/** The project, if news about it may go to a shared channel; else null. */
export async function channelProjectOk(projectId: string, cls?: ClassificationResolver): Promise<ChannelProject | null> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, orgId: true, key: true, name: true, archived: true, teamScopedAccess: true },
  });
  if (!p || p.archived || p.teamScopedAccess) return null;
  const resolver = cls ?? (await createClassificationResolver(p.orgId));
  return resolver.restricted(p.id, p.name) ? null : { id: p.id, orgId: p.orgId, key: p.key, name: p.name };
}

export interface ChannelPolicy {
  /** `channelProjectOk`, sharing one classification lookup. */
  project(projectId: string): Promise<ChannelProject | null>;
  /** The text, or undefined when it or its project is marked. */
  text(projectId: string | null, text: string | null | undefined): string | undefined;
  /** A chat channel whose messages may be quoted: a public channel, on no project or one that may be posted about. */
  chatChannel(channelId: string): Promise<{ projectId: string | null } | null>;
}

export async function channelPolicy(orgId: string): Promise<ChannelPolicy> {
  const cls = await createClassificationResolver(orgId);
  return {
    project: (projectId) => channelProjectOk(projectId, cls),
    text: (projectId, text) => (text && !cls.restricted(projectId, text) ? text : undefined),
    async chatChannel(channelId) {
      const ch = await prisma.chatChannel.findFirst({
        where: { id: channelId, orgId },
        select: { kind: true, isPrivate: true, projectId: true },
      });
      if (!ch || ch.kind !== "CHANNEL" || ch.isPrivate) return null;
      if (ch.projectId && !(await channelProjectOk(ch.projectId, cls))) return null;
      return { projectId: ch.projectId };
    },
  };
}
