import { NextRequest } from "next/server";
import { createHash, createHmac } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError } from "@/lib/api-helpers";
import { Prisma } from "@prisma/client";
import { generateAuditLogPdf } from "@/lib/pdf/audit-log";

// Cap the rows RENDERED into the PDF — it's the presentable, signed report, not
// the bulk dump (CSV/JSON carry the complete set). The digest/signature cover
// exactly the rendered rows, and the header notes truncation honestly.
const PDF_ROW_CAP = 2000;

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.AUDIT_LOG_READ);

    // Mirror the list route's filters EXACTLY so an export honors the same
    // action/entity/user/date filters the viewer has applied — otherwise an
    // export taken with filters active silently returns the broader, unfiltered
    // set (a compliance-reporting hazard).
    const action = request.nextUrl.searchParams.get("action");
    const entity = request.nextUrl.searchParams.get("entity");
    const userId = request.nextUrl.searchParams.get("userId");
    const startDate = request.nextUrl.searchParams.get("startDate");
    const endDate = request.nextUrl.searchParams.get("endDate");
    const format = request.nextUrl.searchParams.get("format") ?? "json";

    const where: Prisma.AuditLogWhereInput = {
      orgId,
      ...(action ? { action } : {}),
      ...(entity ? { entity } : {}),
      ...(userId ? { userId } : {}),
      ...(startDate || endDate
        ? {
            createdAt: {
              ...(startDate ? { gte: new Date(startDate) } : {}),
              ...(endDate ? { lte: new Date(endDate) } : {}),
            },
          }
        : {}),
    };

    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    if (format === "csv") {
      const header = "timestamp,userId,action,entity,entityId,ipAddress,metadata";
      const rows = logs.map((log) => {
        const meta = JSON.stringify(log.metadata).replace(/"/g, '""');
        return [
          log.createdAt.toISOString(),
          log.userId ?? "",
          log.action,
          log.entity,
          log.entityId ?? "",
          log.ipAddress ?? "",
          `"${meta}"`,
        ].join(",");
      });

      const csv = [header, ...rows].join("\n");

      return new Response(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="audit-logs-${orgId}.csv"`,
        },
      });
    }

    if (format === "pdf") {
      const fullCount = logs.length;
      const rendered = logs.slice(0, PDF_ROW_CAP);

      // Resolve userIds → display names (audit keeps userId as data, no FK).
      const userIds = [
        ...new Set(rendered.map((l) => l.userId).filter((v): v is string => !!v)),
      ];
      const users = userIds.length
        ? await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, displayName: true, email: true },
          })
        : [];
      const userLabel = new Map(
        users.map((u) => [u.id, u.displayName || u.email || u.id]),
      );

      // Canonical JSON of the RENDERED rows (fixed key order; BigInt→string,
      // Bytes→hex) — the SHA-256 over this is the content digest.
      const canonicalRows = rendered.map((l) => ({
        id: l.id,
        seq: l.seq != null ? l.seq.toString() : null,
        createdAt: l.createdAt.toISOString(),
        userId: l.userId,
        action: l.action,
        entity: l.entity,
        entityId: l.entityId,
        ipAddress: l.ipAddress,
        metadata: l.metadata,
        rowHash: l.rowHash ? Buffer.from(l.rowHash).toString("hex") : null,
        prevHash: l.prevHash ? Buffer.from(l.prevHash).toString("hex") : null,
      }));
      const sha256 = createHash("sha256")
        .update(JSON.stringify(canonicalRows), "utf8")
        .digest("hex");

      // seq range + chain anchor (tail = highest-seq rendered row's row_hash,
      // which binds every prior row in the AU-9 chain).
      const seqs = rendered
        .map((l) => l.seq)
        .filter((s): s is bigint => s != null);
      const minSeq = seqs.length ? seqs.reduce((a, b) => (b < a ? b : a)).toString() : null;
      const maxSeq = seqs.length ? seqs.reduce((a, b) => (b > a ? b : a)).toString() : null;
      const tailRow = seqs.length
        ? rendered.reduce((acc, l) =>
            l.seq != null && (acc.seq == null || l.seq > acc.seq) ? l : acc,
          )
        : null;
      const tailRowHash = tailRow?.rowHash
        ? Buffer.from(tailRow.rowHash).toString("hex")
        : null;

      const exportedAt = new Date();
      const exporter = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { displayName: true, email: true },
      });
      const exportedBy = exporter?.email || exporter?.displayName || ctx.userId;
      const filters = { action, entity, userId, startDate, endDate };

      // HMAC-SHA256 over the canonical manifest — re-verifiable by this instance
      // to detect post-export edits. Reuse the WORM signing key if a dedicated
      // one isn't set; if neither exists the PDF is emitted UNSIGNED (digest +
      // chain anchor still provide integrity).
      const signingKey =
        process.env.AUDIT_EXPORT_HMAC_KEY ?? process.env.WORM_MANIFEST_HMAC_KEY ?? "";
      const manifest = {
        orgName: org.name,
        exportedBy,
        exportedAt: exportedAt.toISOString(),
        filters,
        fullCount,
        renderedCount: rendered.length,
        minSeq,
        maxSeq,
        tailRowHash,
        sha256,
      };
      const signature = signingKey
        ? createHmac("sha256", signingKey)
            .update(JSON.stringify(manifest))
            .digest("hex")
        : null;

      const pdf = await generateAuditLogPdf(
        {
          orgName: org.name,
          exportedBy,
          exportedAt,
          filters,
          fullCount,
          truncated: fullCount > rendered.length,
          rows: rendered.map((l) => ({
            createdAt: l.createdAt,
            seq: l.seq,
            userId: l.userId,
            userLabel: l.userId ? userLabel.get(l.userId) ?? null : null,
            action: l.action,
            entity: l.entity,
            entityId: l.entityId,
            ipAddress: l.ipAddress,
            metadata: l.metadata,
          })),
        },
        {
          sha256,
          minSeq,
          maxSeq,
          tailRowHash,
          signature,
          signatureAlgo: signature ? "hmac-sha256" : "unsigned",
        },
      );

      return new Response(new Uint8Array(pdf), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="audit-logs-${orgId}.pdf"`,
        },
      });
    }

    return new Response(JSON.stringify(logs), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
