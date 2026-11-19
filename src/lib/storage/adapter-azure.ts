import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type { StorageAdapter } from "./index";
import { assertSafeStorageKey } from "./keys";
import { contentDisposition } from "@/lib/http/content-disposition";

/**
 * Azure Blob Storage adapter. Same contract as the S3 adapter: objects live in
 * one container, keyed by the same storage keys, and bytes are streamed back
 * through the auth-checked Cosmos API path (no SAS URLs are handed out).
 *
 * Configured from env:
 *   AZURE_STORAGE_CONTAINER          the uploads container (required)
 * and ONE of:
 *   AZURE_STORAGE_ACCOUNT_URL        e.g. https://<account>.blob.core.windows.net
 *                                    Signs in with DefaultAzureCredential: a
 *                                    managed identity on a VM, workload identity
 *                                    on AKS (AZURE_CLIENT_ID / AZURE_TENANT_ID /
 *                                    AZURE_FEDERATED_TOKEN_FILE), or a dev login.
 *                                    No secret is stored. Preferred.
 *   AZURE_STORAGE_CONNECTION_STRING  a full connection string (shared key). For
 *                                    the Azurite emulator and accounts that still
 *                                    allow shared keys.
 * If both are set, the connection string wins, so a local override is explicit.
 *
 * The identity needs "Storage Blob Data Contributor" on the container (or the
 * account). The container is not created here: provisioning owns it.
 */

const URL_BASE = "/api/v1/storage/local";

/** Upload in 4 MiB blocks, 4 at a time: bounded memory for streamed uploads. */
const STREAM_BLOCK_BYTES = 4 * 1024 * 1024;
const STREAM_CONCURRENCY = 4;

function containerClient(): ContainerClient {
  const container = process.env.AZURE_STORAGE_CONTAINER;
  if (!container) {
    throw new Error("azure storage adapter: missing required env AZURE_STORAGE_CONTAINER");
  }
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const accountUrl = process.env.AZURE_STORAGE_ACCOUNT_URL;

  let service: BlobServiceClient;
  if (connectionString) {
    service = BlobServiceClient.fromConnectionString(connectionString);
  } else if (accountUrl) {
    service = new BlobServiceClient(accountUrl, new DefaultAzureCredential());
  } else {
    throw new Error(
      "azure storage adapter: set AZURE_STORAGE_ACCOUNT_URL (managed/workload identity) or AZURE_STORAGE_CONNECTION_STRING",
    );
  }
  return service.getContainerClient(container);
}

function isNotFound(err: unknown): boolean {
  const e = err as { statusCode?: number; code?: string };
  return e?.statusCode === 404 || e?.code === "BlobNotFound";
}

export function createAzureBlobAdapter(): StorageAdapter {
  const container = containerClient();

  return {
    async put(key, body, meta) {
      // One container holds every org's objects, so a key is checked before it
      // names one (see keys.ts).
      assertSafeStorageKey(key);
      const blob = container.getBlockBlobClient(key);
      const options = {
        blobHTTPHeaders: {
          blobContentType: meta.contentType,
          blobContentDisposition: contentDisposition(meta.filename),
        },
      };

      if (Buffer.isBuffer(body)) {
        await blob.uploadData(body, options);
      } else {
        // Stream a Web ReadableStream without buffering the whole upload.
        const node = Readable.fromWeb(body as unknown as NodeWebReadableStream);
        await blob.uploadStream(node, STREAM_BLOCK_BYTES, STREAM_CONCURRENCY, options);
      }

      return {
        url: `${URL_BASE}/${encodeURIComponent(key)}`,
        storageKey: key,
      };
    },

    async delete(key) {
      assertSafeStorageKey(key);
      // Idempotent like the local and S3 adapters: a missing blob is not an error.
      await container.getBlockBlobClient(key).deleteIfExists();
    },

    async stream(key) {
      assertSafeStorageKey(key);
      try {
        const res = await container.getBlockBlobClient(key).download();
        const body = res.readableStreamBody;
        if (!body) return null;
        // Node stream in the Node runtime; expose a Web stream so the route layer
        // treats every adapter the same.
        return Readable.toWeb(body as Readable) as unknown as ReadableStream;
      } catch (err) {
        // Missing blob → null (the route returns 404); anything else fails loud.
        if (isNotFound(err)) return null;
        throw err;
      }
    },
  };
}
