import { createLocalAdapter } from "./adapter-local";
import { createS3Adapter } from "./adapter-s3";

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
 * "s3" targets the in-boundary MinIO (or GovCloud / Assured-Workloads S3 in
 * prod). Production code passes uploads and downloads through this abstraction
 * so swapping adapters never touches call sites. The S3 adapter constructs its
 * client lazily (inside createS3Adapter on first getStorage("s3")), so the
 * AWS SDK is never instantiated on the default "local" path.
 */
export function getStorage(): StorageAdapter {
  if (instance) return instance;
  const choice = process.env.STORAGE_ADAPTER ?? "local";
  if (choice === "local") {
    instance = createLocalAdapter();
  } else if (choice === "s3") {
    instance = createS3Adapter();
  } else {
    throw new Error(`Unknown STORAGE_ADAPTER=${choice} (expected "local" or "s3")`);
  }
  return instance;
}

/** Test-only: reset singleton so subsequent getStorage() returns fresh. */
export function _resetStorageForTests(): void {
  instance = null;
}
