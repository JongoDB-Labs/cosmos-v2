import { prisma } from "@/lib/db/client";
import { getStorage } from "@/lib/storage";
import { parserFor, formatFromName } from "./parsers";
import { anchorAssigner } from "./parsers/slug";
import type { Prisma, ClassificationLevel } from "@prisma/client";

const MAX_BYTES = 25 * 1024 * 1024;

export interface IngestInput {
  orgId: string;
  projectId: string;
  uploadedById: string;
  filename: string;
  contentType: string;
  buffer: Buffer;
  title?: string;
  classificationLevel?: ClassificationLevel;
}

/**
 * Store the original file, parse it into the normalized DocumentBlock tree, and
 * persist. Extends the existing CUI-aware `documents` table (title /
 * classificationLevel / contentType / size). Status walks PARSING → READY|FAILED;
 * parse failures are recorded, not thrown, so the document still lists.
 */
export async function ingestDocument(input: IngestInput) {
  const format = formatFromName(input.filename);
  if (!format) throw new Error(`Unsupported file type: ${input.filename}`);
  if (input.buffer.byteLength > MAX_BYTES) throw new Error("File exceeds 25 MB limit");

  const storageKey = `documents/${input.projectId}/${crypto.randomUUID()}/${input.filename}`;
  await getStorage().put(storageKey, input.buffer, {
    contentType: input.contentType,
    filename: input.filename,
  });

  const doc = await prisma.document.create({
    data: {
      orgId: input.orgId,
      projectId: input.projectId,
      uploadedById: input.uploadedById,
      title: input.title ?? input.filename.replace(/\.[^.]+$/, ""),
      filename: input.filename,
      contentType: input.contentType,
      size: input.buffer.byteLength,
      classificationLevel: input.classificationLevel ?? "UNCLASSIFIED",
      storageKey,
      format,
      status: "PARSING",
    },
  });

  try {
    const { blocks, pageCount } = await parserFor(format)!.parse(input.buffer);
    const assign = anchorAssigner();
    const rows: Prisma.DocumentBlockCreateManyInput[] = blocks.map((b, i) => ({
      documentId: doc.id,
      orgId: input.orgId,
      kind: b.kind,
      level: b.level ?? null,
      text: b.text,
      html: b.html ?? null,
      data: (b.data ?? undefined) as Prisma.InputJsonValue | undefined,
      anchor: assign(b.kind === "HEADING" ? b.text : "", i),
      ordinal: i,
      page: b.page ?? null,
    }));
    if (rows.length) await prisma.documentBlock.createMany({ data: rows });

    // Nest each block under the most recent shallower HEADING.
    const persisted = await prisma.documentBlock.findMany({
      where: { documentId: doc.id },
      orderBy: { ordinal: "asc" },
      select: { id: true, kind: true, level: true },
    });
    const stack: { id: string; level: number }[] = [];
    for (const b of persisted) {
      while (
        stack.length &&
        b.kind === "HEADING" &&
        stack[stack.length - 1].level >= (b.level ?? 1)
      ) {
        stack.pop();
      }
      const parent = stack[stack.length - 1];
      if (parent) await prisma.documentBlock.update({ where: { id: b.id }, data: { parentId: parent.id } });
      if (b.kind === "HEADING") stack.push({ id: b.id, level: b.level ?? 1 });
    }

    return prisma.document.update({
      where: { id: doc.id },
      data: { status: "READY", pageCount: pageCount ?? null },
    });
  } catch (e) {
    return prisma.document.update({
      where: { id: doc.id },
      data: { status: "FAILED", parseError: String((e as Error).message).slice(0, 500) },
    });
  }
}
