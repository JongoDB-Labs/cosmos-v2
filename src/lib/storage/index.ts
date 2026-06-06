import { createLocalAdapter } from "./adapter-local";

export interface StorageAdapter {
  put(
    key: string,
    body: ReadableStream | Buffer,
    meta: { contentType: string; filename: string },
  ): Promise<{ url: string; storageKey: string }>;
  delete(key: string): Promise<void>;
  stream(key: string): Promise<ReadableStream | null>;
}

let instance: StorageAdapter | null = null;

/**
 * Lazy singleton selected by STORAGE_ADAPTER env (default "local").
 * Phase 2 will add a "vercel-blob" choice. Production code passes uploads
 * and downloads through this abstraction so swapping adapters never touches
 * call sites.
 */
export function getStorage(): StorageAdapter {
  if (instance) return instance;
  const choice = process.env.STORAGE_ADAPTER ?? "local";
  if (choice === "local") {
    instance = createLocalAdapter();
  } else {
    throw new Error(`Unknown STORAGE_ADAPTER=${choice} (expected "local")`);
  }
  return instance;
}

/** Test-only: reset singleton so subsequent getStorage() returns fresh. */
export function _resetStorageForTests(): void {
  instance = null;
}
