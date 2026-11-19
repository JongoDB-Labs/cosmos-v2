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
 *                                    (a bare https endpoint; a SAS URL, a
 *                                    container path, or an IP / localhost /
 *                                    emulator-port host is refused: use the
 *                                    connection string for those)
 *                                    Signs in with DefaultAzureCredential, so no
 *                                    secret is stored: a VM's managed identity
 *                                    (set AZURE_CLIENT_ID too for a user-assigned
 *                                    one), or AKS workload identity (its webhook
 *                                    injects AZURE_CLIENT_ID / AZURE_TENANT_ID /
 *                                    AZURE_FEDERATED_TOKEN_FILE).
 *                                    AZURE_TOKEN_CREDENTIALS=prod skips the
 *                                    developer sign-ins (Azure CLI etc.) in prod.
 *   AZURE_STORAGE_CONNECTION_STRING  a full connection string (shared key or SAS).
 *                                    For the Azurite emulator and accounts that
 *                                    still allow shared keys. A secret: inject it
 *                                    at runtime, never bake it into an image.
 * If both are set, the connection string wins.
 *
 * The identity needs "Storage Blob Data Contributor" on the container (or the
 * account). The container is not created here: provisioning owns it.
 */

const URL_BASE = "/api/v1/storage/local";

/** Upload in 4 MiB blocks, 4 at a time: bounded memory for streamed uploads. */
export const STREAM_BLOCK_BYTES = 4 * 1024 * 1024;
export const STREAM_CONCURRENCY = 4;

/** A container name used only to ask the SDK how it parses the account URL. */
export const PATH_STYLE_PROBE = "path-style-probe";

function containerClient(): ContainerClient {
  const container = process.env.AZURE_STORAGE_CONTAINER;
  if (!container) {
    throw new Error("azure storage adapter: missing required env AZURE_STORAGE_CONTAINER");
  }
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const accountUrl = process.env.AZURE_STORAGE_ACCOUNT_URL;
  if (!connectionString && !accountUrl) {
    throw new Error(
      "azure storage adapter: set AZURE_STORAGE_ACCOUNT_URL (managed/workload identity) or AZURE_STORAGE_CONNECTION_STRING",
    );
  }

  if (!connectionString) {
    // The identity path must carry no secret. Refuse anything but a bare https
    // endpoint (a pasted SAS URL would otherwise be sent with every request), and
    // report a bad value by setting name only: a URL parse error keeps its input.
    // A path is refused too: the SDK would fold it into every blob's address,
    // so blobs would silently land under shifted names (or in another container)
    // and files already stored under the real keys would 404.
    let url: URL | null = null;
    try {
      url = new URL(accountUrl!);
    } catch {
      url = null;
    }
    if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error(
        "azure storage adapter: AZURE_STORAGE_ACCOUNT_URL must be a bare https account endpoint (no path, query, fragment or credentials; value withheld)",
      );
    }
    // The credential's own config errors (e.g. a mistyped AZURE_TOKEN_CREDENTIALS,
    // which lists the valid values) hold no secret and pass through. The SDK gets
    // the parsed origin, so what was checked above is exactly what it uses.
    const service = new BlobServiceClient(url.origin, new DefaultAzureCredential());
    // On a host the SDK treats as path-style (an IP, localhost,
    // host.docker.internal or an emulator port) it reads the account name from
    // the path, so a bare URL there would shift every name by one segment (the
    // container becomes the account). Ask the SDK itself, with a fixed probe name.
    if (service.getContainerClient(PATH_STYLE_PROBE).containerName !== PATH_STYLE_PROBE) {
      throw new Error(
        "azure storage adapter: AZURE_STORAGE_ACCOUNT_URL is a host the SDK treats as path-style (an IP, localhost, host.docker.internal or an emulator port); use AZURE_STORAGE_CONNECTION_STRING for those (value withheld)",
      );
    }
    return service.getContainerClient(container);
  }
  try {
    return BlobServiceClient.fromConnectionString(connectionString).getContainerClient(container);
  } catch {
    // The SDK's parse errors can quote the value they choked on, and a
    // connection string carries a key or SAS signature. Name the setting only.
    throw new Error(
      "azure storage adapter: AZURE_STORAGE_CONNECTION_STRING is malformed (value withheld; it may hold a credential)",
    );
  }
}

/**
 * Only a missing BLOB is "not found". A missing container is also a 404, but it
 * is a setup fault, and returning null for it would make every file look absent.
 */
function isBlobNotFound(err: unknown): boolean {
  // The code comes from the XML error body; with no body (e.g. a proxy stripped
  // it) the SDK only has the x-ms-error-code header, in details.errorCode.
  const e = err as { code?: string; details?: { errorCode?: string } };
  return e?.code === "BlobNotFound" || e?.details?.errorCode === "BlobNotFound";
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
        try {
          await blob.uploadStream(node, STREAM_BLOCK_BYTES, STREAM_CONCURRENCY, options);
        } catch (err) {
          // A failed upload leaves the source paused, not cancelled; release it so
          // the producer's file handle or socket is not held open.
          node.destroy();
          throw err;
        }
      }

      return {
        url: `${URL_BASE}/${encodeURIComponent(key)}`,
        storageKey: key,
      };
    },

    async delete(key) {
      assertSafeStorageKey(key);
      // Idempotent like the local and S3 adapters: a missing blob is not an error.
      // Snapshots go too; without that, Azure refuses with 409 SnapshotsPresent and
      // the file outlives the record that pointed at it.
      await container.getBlockBlobClient(key).deleteIfExists({ deleteSnapshots: "include" });
    },

    async stream(key) {
      assertSafeStorageKey(key);
      try {
        const res = await container.getBlockBlobClient(key).download();
        const body = res.readableStreamBody;
        // Always set in Node on success; its absence is a fault, not a missing file.
        if (!body) throw new Error("azure storage adapter: download returned no body");
        // Node stream in the Node runtime; expose a Web stream so the route layer
        // treats every adapter the same.
        return Readable.toWeb(body as Readable) as unknown as ReadableStream;
      } catch (err) {
        // Missing blob → null (the route returns 404); anything else fails loud.
        if (isBlobNotFound(err)) return null;
        throw err;
      }
    },
  };
}
