import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type { StorageAdapter } from "./index";

/**
 * S3-compatible storage adapter (MinIO in-boundary today; GovCloud /
 * Assured-Workloads S3 in production — only endpoint/creds change).
 *
 * Configured entirely from env so the same image points at any S3 endpoint:
 *   S3_ENDPOINT    e.g. http://cosmos-minio:9000 (path-style for MinIO)
 *   S3_BUCKET      the uploads bucket (cosmos-uploads)
 *   S3_ACCESS_KEY  least-privilege uploads key (RW on the uploads bucket only)
 *   S3_SECRET_KEY  its secret
 *   S3_REGION      optional; defaults to us-east-1 (MinIO ignores it but the SDK
 *                  requires a region to sign)
 *   S3_FORCE_PATH_STYLE  optional; defaults true (MinIO needs path-style; real
 *                  AWS/GovCloud accept it too)
 *
 * `forcePathStyle` is on by default because MinIO serves buckets at
 * `<endpoint>/<bucket>/<key>`, not the virtual-hosted `<bucket>.<endpoint>` form.
 *
 * URLs are NOT presigned here — the route layer (auth-checked) streams bytes
 * back through the Cosmos API path, exactly like the local adapter, so callers
 * never receive a direct object URL and storage stays behind the boundary.
 */

const URL_BASE = "/api/v1/storage/local";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`s3 storage adapter: missing required env ${name}`);
  return v;
}

export function createS3Adapter(): StorageAdapter {
  const endpoint = requireEnv("S3_ENDPOINT");
  const bucket = requireEnv("S3_BUCKET");
  const accessKeyId = requireEnv("S3_ACCESS_KEY");
  const secretAccessKey = requireEnv("S3_SECRET_KEY");
  const region = process.env.S3_REGION ?? "us-east-1";
  // Default ON for MinIO; set S3_FORCE_PATH_STYLE=false only for a virtual-hosted endpoint.
  const forcePathStyle = (process.env.S3_FORCE_PATH_STYLE ?? "true") !== "false";

  const config: S3ClientConfig = {
    endpoint,
    region,
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey },
  };
  const client = new S3Client(config);

  return {
    async put(key, body, meta) {
      // The S3 SDK accepts a Buffer or a Node Readable as Body; convert a Web
      // ReadableStream to a Node Readable so streamed uploads don't buffer.
      const payload: Buffer | Readable = Buffer.isBuffer(body)
        ? body
        : Readable.fromWeb(body as unknown as NodeWebReadableStream);

      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: payload,
          ContentType: meta.contentType,
          // RFC 5987-safe filename hint for downloads through the API route.
          ContentDisposition: `inline; filename="${meta.filename.replace(/["\\]/g, "_")}"`,
        }),
      );

      return {
        url: `${URL_BASE}/${encodeURIComponent(key)}`,
        storageKey: key,
      };
    },

    async delete(key) {
      // S3 DeleteObject is idempotent (no error on a missing key), matching the
      // local adapter's swallow-on-missing semantics.
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async stream(key) {
      try {
        const res = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        if (!res.Body) return null;
        // Body is a Node Readable in the Node runtime; expose it as a Web stream
        // so the route layer treats local and s3 identically.
        const node = res.Body as Readable;
        return Readable.toWeb(node) as unknown as ReadableStream;
      } catch (err) {
        // NoSuchKey / NotFound → null (the route returns 404); rethrow anything else.
        const name = (err as { name?: string })?.name;
        const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
          ?.httpStatusCode;
        if (name === "NoSuchKey" || name === "NotFound" || status === 404) {
          return null;
        }
        throw err;
      }
    },
  };
}
