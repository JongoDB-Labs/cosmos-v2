import { createLocalAdapter } from "./adapter-local";
import { createS3Adapter } from "./adapter-s3";
import { createAzureBlobAdapter } from "./adapter-azure";

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
 * prod); "azure" targets Azure Blob Storage (adapter-azure.ts). Production
 * code passes uploads and downloads through this abstraction so swapping
 * adapters never touches call sites. Each cloud adapter builds its client on
 * the first getStorage() call, so the AWS and Azure SDKs are never
 * instantiated on the default "local" path, and a bad cloud setting fails on
 * the first storage call rather than at boot.
 */
export function getStorage(): StorageAdapter {
  if (instance) return instance;
  const choice = process.env.STORAGE_ADAPTER ?? "local";
  if (choice === "local") {
    instance = createLocalAdapter();
  } else if (choice === "s3") {
    instance = createS3Adapter();
  } else if (choice === "azure") {
    instance = createAzureBlobAdapter();
  } else {
    throw new Error(`Unknown STORAGE_ADAPTER=${choice} (expected "local", "s3" or "azure")`);
  }
  return instance;
}

/** Test-only: reset singleton so subsequent getStorage() returns fresh. */
export function _resetStorageForTests(): void {
  instance = null;
}
