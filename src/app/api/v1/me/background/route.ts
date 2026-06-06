import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { success, handleApiError, noContent } from "@/lib/api-helpers";
import { writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png"]);
const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads", "bg");

function extFromMime(mime: string): string {
  return mime === "image/png" ? "png" : "jpg";
}

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    const formData = await request.formData();
    const queryMode = new URL(request.url).searchParams.get("mode");
    const mode = (formData.get("mode") as string | null) ?? queryMode;
    const file = formData.get("file") as File | null;

    if (!mode || (mode !== "dark" && mode !== "light")) {
      return new Response(
        JSON.stringify({ error: 'mode must be "dark" or "light"' }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    if (!file || !(file instanceof File)) {
      return new Response(
        JSON.stringify({ error: "file is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    if (!ALLOWED_TYPES.has(file.type)) {
      return new Response(
        JSON.stringify({ error: "File must be image/jpeg or image/png" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    if (file.size > MAX_SIZE) {
      return new Response(
        JSON.stringify({ error: "File must be 5MB or smaller" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const ext = extFromMime(file.type);
    const filename = `${user.id}-${mode}.${ext}`;
    const filePath = path.join(UPLOAD_DIR, filename);
    const publicUrl = `/uploads/bg/${filename}`;

    // Ensure directory exists
    await mkdir(UPLOAD_DIR, { recursive: true });

    // Write file to disk
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(filePath, buffer);

    // Update preferences
    const column = mode === "dark" ? "bgDarkUrl" : "bgLightUrl";
    await prisma.userPreferences.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        [column]: publicUrl,
      },
      update: {
        [column]: publicUrl,
      },
    });

    return success({ url: publicUrl });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    const { searchParams } = new URL(request.url);
    const mode = searchParams.get("mode");

    if (!mode || (mode !== "dark" && mode !== "light")) {
      return new Response(
        JSON.stringify({ error: 'mode query param must be "dark" or "light"' }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const column = mode === "dark" ? "bgDarkUrl" : "bgLightUrl";

    // Look up current URL to find the file
    const prefs = await prisma.userPreferences.findUnique({
      where: { userId: user.id },
    });

    if (prefs && prefs[column]) {
      const filename = path.basename(prefs[column]!);
      const filePath = path.join(UPLOAD_DIR, filename);
      try {
        await unlink(filePath);
      } catch {
        // File may already be gone — that's fine
      }
    }

    // Set column to null
    await prisma.userPreferences.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        [column]: null,
      },
      update: {
        [column]: null,
      },
    });

    return noContent();
  } catch (e) {
    return handleApiError(e);
  }
}
