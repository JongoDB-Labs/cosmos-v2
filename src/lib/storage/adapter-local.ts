import { createReadStream, createWriteStream } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type { StorageAdapter } from "./index";
import { assertSafeStorageKey, UnsafeStorageKeyError } from "./keys";

const ROOT = path.resolve(process.cwd(), "uploads", "chat");
const URL_BASE = "/api/v1/storage/local";

/**
 * Disk-backed storage adapter. Files live under <cwd>/uploads/chat/<storageKey>
 * (the directory is gitignored). URLs route through a Cosmos API path so
 * callers don't tightly couple to the on-disk layout; auth-checked serving
 * is enforced at the route layer, not here.
 *
 * `storageKey` is whatever the caller provides — the route layer is expected
 * to namespace by org and uuid to avoid collisions. It must be a safe relative
 * key (see keys.ts), and the path it resolves to must stay under ROOT: a key
 * read back from user-editable data once reached any file on the server.
 */
function pathOf(key: string): string {
  assertSafeStorageKey(key);
  const full = path.resolve(ROOT, key);
  if (!full.startsWith(ROOT + path.sep)) throw new UnsafeStorageKeyError();
  return full;
}

export function createLocalAdapter(): StorageAdapter {
  return {
    async put(key, body, _meta) {
      const fullPath = pathOf(key);
      await fsp.mkdir(path.dirname(fullPath), { recursive: true });

      if (Buffer.isBuffer(body)) {
        await fsp.writeFile(fullPath, body);
      } else {
        // Web ReadableStream → Node Readable
        const nodeStream = Readable.fromWeb(body as unknown as NodeWebReadableStream);
        await pipeline(nodeStream, createWriteStream(fullPath));
      }

      return {
        url: `${URL_BASE}/${encodeURIComponent(key)}`,
        storageKey: key,
      };
    },

    async delete(key) {
      const fullPath = pathOf(key);
      await fsp.unlink(fullPath).catch(() => {
        /* already gone — idempotent */
      });
    },

    async stream(key) {
      const fullPath = pathOf(key);
      try {
        await fsp.access(fullPath);
      } catch {
        return null;
      }
      const node = createReadStream(fullPath);
      return Readable.toWeb(node) as unknown as ReadableStream;
    },
  };
}
