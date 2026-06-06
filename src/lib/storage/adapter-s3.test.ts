import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

// ── Mock the AWS SDK ──────────────────────────────────────────────────────────
// We capture the command instances the adapter sends so we can assert on the
// Bucket/Key/Body/ContentType it builds, and we control the client's responses
// (incl. simulating NoSuchKey) — no network, no real MinIO.

const sendMock = vi.fn();
// Records the config passed to `new S3Client(...)` so tests can assert on it.
const clientConfigs: unknown[] = [];

vi.mock("@aws-sdk/client-s3", () => {
  // Defined inside the factory because vi.mock is hoisted above module scope.
  class FakeCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  return {
    // A real class so `new S3Client(config)` works; send() delegates to the spy.
    S3Client: class {
      send = sendMock;
      constructor(config: unknown) {
        clientConfigs.push(config);
      }
    },
    PutObjectCommand: class extends FakeCommand {
      readonly _kind = "Put";
    },
    DeleteObjectCommand: class extends FakeCommand {
      readonly _kind = "Delete";
    },
    GetObjectCommand: class extends FakeCommand {
      readonly _kind = "Get";
    },
  };
});

// Imported AFTER the mock so the adapter binds to the fakes.
import { createS3Adapter } from "./adapter-s3";
import {
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

const ENV = {
  S3_ENDPOINT: "http://cosmos-minio:9000",
  S3_BUCKET: "cosmos-uploads",
  S3_ACCESS_KEY: "uploads-key",
  S3_SECRET_KEY: "uploads-secret",
};

beforeEach(() => {
  sendMock.mockReset();
  clientConfigs.length = 0;
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
  delete process.env.S3_REGION;
  delete process.env.S3_FORCE_PATH_STYLE;
});

afterEach(() => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  delete process.env.S3_REGION;
  delete process.env.S3_FORCE_PATH_STYLE;
});

describe("createS3Adapter", () => {
  it("constructs the client path-style with the configured endpoint + creds", () => {
    createS3Adapter();
    expect(clientConfigs).toHaveLength(1);
    const config = clientConfigs[0] as Record<string, unknown>;
    expect(config.endpoint).toBe(ENV.S3_ENDPOINT);
    expect(config.forcePathStyle).toBe(true);
    expect(config.region).toBe("us-east-1");
    expect(config.credentials).toEqual({
      accessKeyId: ENV.S3_ACCESS_KEY,
      secretAccessKey: ENV.S3_SECRET_KEY,
    });
  });

  it("honors S3_REGION and S3_FORCE_PATH_STYLE=false overrides", () => {
    process.env.S3_REGION = "us-gov-west-1";
    process.env.S3_FORCE_PATH_STYLE = "false";
    createS3Adapter();
    const config = clientConfigs[0] as Record<string, unknown>;
    expect(config.region).toBe("us-gov-west-1");
    expect(config.forcePathStyle).toBe(false);
  });

  it("throws if a required env var is missing", () => {
    delete process.env.S3_BUCKET;
    expect(() => createS3Adapter()).toThrow(/missing required env S3_BUCKET/);
  });

  it("put sends a PutObjectCommand with bucket/key/body/contentType and returns url+key", async () => {
    sendMock.mockResolvedValueOnce({});
    const adapter = createS3Adapter();
    const key = "org/abc/file.txt";
    const body = Buffer.from("hello world");

    const result = await adapter.put(key, body, {
      contentType: "text/plain",
      filename: "file.txt",
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0][0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toMatchObject({
      Bucket: ENV.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: "text/plain",
    });
    expect(cmd.input.ContentDisposition).toContain('filename="file.txt"');

    // URL routes through the auth-checked API path; storageKey echoes the key.
    expect(result.storageKey).toBe(key);
    expect(result.url).toContain(encodeURIComponent(key));
  });

  it("put converts a Web ReadableStream body to a Node Readable", async () => {
    sendMock.mockResolvedValueOnce({});
    const adapter = createS3Adapter();
    const webStream = new Response("streamed").body as ReadableStream;

    await adapter.put("k", webStream, {
      contentType: "application/octet-stream",
      filename: "k.bin",
    });

    const cmd = sendMock.mock.calls[0][0] as PutObjectCommand;
    expect(cmd.input.Body).toBeInstanceOf(Readable);
  });

  it("delete sends a DeleteObjectCommand (idempotent)", async () => {
    sendMock.mockResolvedValueOnce({});
    const adapter = createS3Adapter();
    await adapter.delete("org/abc/file.txt");
    const cmd = sendMock.mock.calls[0][0] as DeleteObjectCommand;
    expect(cmd).toBeInstanceOf(DeleteObjectCommand);
    expect(cmd.input).toMatchObject({ Bucket: ENV.S3_BUCKET, Key: "org/abc/file.txt" });
  });

  it("stream returns a Web ReadableStream when the object exists (round-trip)", async () => {
    sendMock.mockResolvedValueOnce({ Body: Readable.from([Buffer.from("payload")]) });
    const adapter = createS3Adapter();
    const stream = await adapter.stream("k");
    expect(stream).not.toBeNull();
    const cmd = sendMock.mock.calls[0][0] as GetObjectCommand;
    expect(cmd).toBeInstanceOf(GetObjectCommand);
    const text = await new Response(stream!).text();
    expect(text).toBe("payload");
  });

  it("stream returns null on NoSuchKey", async () => {
    const err = Object.assign(new Error("nope"), { name: "NoSuchKey" });
    sendMock.mockRejectedValueOnce(err);
    const adapter = createS3Adapter();
    expect(await adapter.stream("missing")).toBeNull();
  });

  it("stream returns null on a 404 metadata status", async () => {
    const err = Object.assign(new Error("nf"), { $metadata: { httpStatusCode: 404 } });
    sendMock.mockRejectedValueOnce(err);
    const adapter = createS3Adapter();
    expect(await adapter.stream("missing")).toBeNull();
  });

  it("stream rethrows non-not-found errors (fail loud)", async () => {
    const err = Object.assign(new Error("boom"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });
    sendMock.mockRejectedValueOnce(err);
    const adapter = createS3Adapter();
    await expect(adapter.stream("k")).rejects.toThrow(/boom/);
  });
});
