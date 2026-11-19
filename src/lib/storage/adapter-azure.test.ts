import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

// ── Mock the Azure SDK ────────────────────────────────────────────────────────
// Capture what the adapter asks of the blob client and control its responses
// (incl. a 404) — no network, no real storage account.

const uploadData = vi.fn();
const uploadStream = vi.fn();
const deleteIfExists = vi.fn();
const download = vi.fn();
const getBlockBlobClient = vi.fn();
const getContainerClient = vi.fn();
const fromConnectionString = vi.fn();
const serviceCtor = vi.fn();
const credentialCtor = vi.fn();

vi.mock("@azure/storage-blob", () => {
  class BlobServiceClient {
    static fromConnectionString(cs: string) {
      fromConnectionString(cs);
      return new BlobServiceClient("from-cs", undefined);
    }
    constructor(url: string, credential: unknown) {
      serviceCtor(url, credential);
    }
    getContainerClient(name: string) {
      return { containerName: getContainerClient(name) ?? name, getBlockBlobClient };
    }
  }
  return { BlobServiceClient };
});

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class {
    readonly kind = "default-credential";
    constructor() {
      credentialCtor();
    }
  },
}));

import { createAzureBlobAdapter, PATH_STYLE_PROBE } from "./adapter-azure";

const ENV_KEYS = [
  "AZURE_STORAGE_CONTAINER",
  "AZURE_STORAGE_ACCOUNT_URL",
  "AZURE_STORAGE_CONNECTION_STRING",
] as const;

beforeEach(() => {
  for (const m of [
    uploadData,
    uploadStream,
    deleteIfExists,
    download,
    getBlockBlobClient,
    getContainerClient,
    fromConnectionString,
    serviceCtor,
    credentialCtor,
  ]) {
    m.mockReset();
  }
  getBlockBlobClient.mockReturnValue({ uploadData, uploadStream, deleteIfExists, download });
  process.env.AZURE_STORAGE_CONTAINER = "cosmos-uploads";
  process.env.AZURE_STORAGE_ACCOUNT_URL = "https://acct.blob.core.windows.net";
  delete process.env.AZURE_STORAGE_CONNECTION_STRING;
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("createAzureBlobAdapter config", () => {
  it("uses the account URL with DefaultAzureCredential (no stored secret)", () => {
    createAzureBlobAdapter();
    expect(serviceCtor).toHaveBeenCalledTimes(1);
    const [url, credential] = serviceCtor.mock.calls[0];
    expect(url).toBe("https://acct.blob.core.windows.net");
    expect(credential).toMatchObject({ kind: "default-credential" });
    expect(fromConnectionString).not.toHaveBeenCalled();
    expect(getContainerClient).toHaveBeenCalledWith("cosmos-uploads");
  });

  it("accepts the account URL with a trailing slash", () => {
    process.env.AZURE_STORAGE_ACCOUNT_URL = "https://acct.blob.core.windows.net/";
    createAzureBlobAdapter();
    expect(serviceCtor).toHaveBeenCalledTimes(1);
    expect(serviceCtor.mock.calls[0][0]).toBe("https://acct.blob.core.windows.net"); // the parsed origin
    expect(getContainerClient).toHaveBeenLastCalledWith("cosmos-uploads");
  });

  it("refuses an account URL the SDK parses to a different container (path-style host)", () => {
    process.env.AZURE_STORAGE_ACCOUNT_URL = "https://127.0.0.1:10000";
    // A container literally named "undefined" must not slip past: that is the
    // string the real SDK parses on a path-style host.
    process.env.AZURE_STORAGE_CONTAINER = "undefined";
    getContainerClient.mockReturnValueOnce("undefined");
    expect(() => createAzureBlobAdapter()).toThrow(/is a host the SDK treats as path-style/);
    expect(getContainerClient).toHaveBeenCalledWith(PATH_STYLE_PROBE);
  });

  // The check above trusts the SDK's own parsing; pin that against the real SDK
  // so an upgrade that changes it is noticed.
  it("real SDK: path-style hosts lose the container name, account hosts keep it", async () => {
    const real = await vi.importActual<typeof import("@azure/storage-blob")>("@azure/storage-blob");
    const probe = (u: string) =>
      new real.BlobServiceClient(u, new real.AnonymousCredential()).getContainerClient(PATH_STYLE_PROBE).containerName;
    for (const u of ["https://127.0.0.1:10000", "https://localhost", "https://[::1]", "https://storage.example.com:10000"]) {
      expect(probe(u)).not.toBe(PATH_STYLE_PROBE);
    }
    for (const u of [
      "https://acct.blob.core.windows.net",
      "https://acct.privatelink.blob.core.windows.net",
      "https://acct.blob.core.usgovcloudapi.net",
      "https://files.example.com:8443",
    ]) {
      expect(probe(u)).toBe(PATH_STYLE_PROBE);
    }
  });

  it("prefers a connection string when both are set", () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
    createAzureBlobAdapter();
    expect(fromConnectionString).toHaveBeenCalledWith("UseDevelopmentStorage=true");
    expect(credentialCtor).not.toHaveBeenCalled();
  });

  it("throws without a container", () => {
    delete process.env.AZURE_STORAGE_CONTAINER;
    expect(() => createAzureBlobAdapter()).toThrow(/missing required env AZURE_STORAGE_CONTAINER/);
  });

  it("never echoes a malformed connection string (it may hold a credential)", () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING = "BlobEndpoint=x;SharedAccessSignature=sig=zzzz-fake-zzzz";
    fromConnectionString.mockImplementationOnce((cs: string) => {
      throw new Error(`cannot parse ${cs}`);
    });
    let message = "";
    try {
      createAzureBlobAdapter();
    } catch (e) {
      message = String((e as Error).message) + String((e as Error).stack) + JSON.stringify(e);
    }
    expect(message).toMatch(/AZURE_STORAGE_CONNECTION_STRING is malformed/);
    expect(message).not.toContain("zzzz-fake-zzzz");
  });

  it("lets the credential's own config error through (it names the valid values)", () => {
    credentialCtor.mockImplementationOnce(() => {
      throw new Error("Invalid value for AZURE_TOKEN_CREDENTIALS = production. Valid values: dev, prod");
    });
    expect(() => createAzureBlobAdapter()).toThrow(/AZURE_TOKEN_CREDENTIALS = production/);
  });

  it.each([
    "https://acct.blob.core.windows.net/?sv=2024&sig=zzzz-fake-zzzz",
    "https://user:zzzz-fake-zzzz@acct.blob.core.windows.net",
    "http://acct.blob.core.windows.net",
    "https://acct.blob.core.windows.net/#zzzz-fake-zzzz",
    "acct.blob.core.windows.net/?sig=zzzz-fake-zzzz",
    "https://acct.blob.core.windows.net/cosmos-uploads",
    "https://acct.blob.core.windows.net/zzzz-fake-zzzz/",
  ])("refuses a non-bare account URL without echoing it: %s", (value) => {
    process.env.AZURE_STORAGE_ACCOUNT_URL = value;
    let message = "";
    try {
      createAzureBlobAdapter();
    } catch (e) {
      message = String((e as Error).message) + String((e as Error).stack) + JSON.stringify(e);
    }
    expect(message).toMatch(/AZURE_STORAGE_ACCOUNT_URL must be a bare https account endpoint/);
    expect(message).not.toContain("zzzz-fake-zzzz");
    expect(serviceCtor).not.toHaveBeenCalled();
  });

  it("throws without any way to reach the account", () => {
    delete process.env.AZURE_STORAGE_ACCOUNT_URL;
    expect(() => createAzureBlobAdapter()).toThrow(/AZURE_STORAGE_ACCOUNT_URL.*AZURE_STORAGE_CONNECTION_STRING/);
  });
});

describe("createAzureBlobAdapter operations", () => {
  it("put uploads a Buffer with content type + a legal Content-Disposition", async () => {
    uploadData.mockResolvedValueOnce({});
    const adapter = createAzureBlobAdapter();
    const key = "org/abc/file.txt";
    const body = Buffer.from("hello world");

    const result = await adapter.put(key, body, { contentType: "text/plain", filename: "file.txt" });

    expect(getBlockBlobClient).toHaveBeenCalledWith(key);
    expect(uploadData).toHaveBeenCalledTimes(1);
    const [sent, opts] = uploadData.mock.calls[0];
    expect(sent).toBe(body);
    expect(opts.blobHTTPHeaders.blobContentType).toBe("text/plain");
    expect(opts.blobHTTPHeaders.blobContentDisposition).toContain('filename="file.txt"');
    expect(uploadStream).not.toHaveBeenCalled();
    expect(result.storageKey).toBe(key);
    expect(result.url).toContain(encodeURIComponent(key));
  });

  it("put keeps a macOS screenshot name header-legal", async () => {
    uploadData.mockResolvedValueOnce({});
    const adapter = createAzureBlobAdapter();
    const name = "Screenshot 2026-10-29 at 10.28.00 AM.png";
    await adapter.put("k", Buffer.from("x"), { contentType: "image/png", filename: name });
    const cd: string = uploadData.mock.calls[0][1].blobHTTPHeaders.blobContentDisposition;
    expect(/^[\t\x20-\x7E\x80-\xFF]*$/.test(cd)).toBe(true);
    expect(/^[\t\x20-\x7E\x80-\xFF]*$/.test(name)).toBe(false);
  });

  it("put streams a Web ReadableStream as a Node Readable", async () => {
    uploadStream.mockResolvedValueOnce({});
    const adapter = createAzureBlobAdapter();
    const webStream = new Response("streamed").body as ReadableStream;
    await adapter.put("k", webStream, { contentType: "application/octet-stream", filename: "k.bin" });
    expect(uploadData).not.toHaveBeenCalled();
    expect(uploadStream).toHaveBeenCalledTimes(1);
    const [source, blockBytes, concurrency, opts] = uploadStream.mock.calls[0];
    expect(source).toBeInstanceOf(Readable);
    const chunks: Buffer[] = [];
    for await (const chunk of source as Readable) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("streamed");
    expect([blockBytes, concurrency]).toEqual([4 * 1024 * 1024, 4]);
    expect(opts.blobHTTPHeaders.blobContentType).toBe("application/octet-stream");
    expect(opts.blobHTTPHeaders.blobContentDisposition).toContain('filename="k.bin"');
  });

  it("put releases the source stream when a streamed upload fails", async () => {
    uploadStream.mockRejectedValueOnce(new Error("block upload failed"));
    const adapter = createAzureBlobAdapter();
    let cancelled = false;
    const webStream = new ReadableStream({
      pull(c) {
        c.enqueue(new TextEncoder().encode("x"));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      adapter.put("k", webStream, { contentType: "application/octet-stream", filename: "k.bin" }),
    ).rejects.toThrow(/block upload failed/);
    await new Promise((r) => setImmediate(r));
    expect(cancelled).toBe(true);
  });

  it("delete is idempotent (deleteIfExists) and takes snapshots with it", async () => {
    deleteIfExists.mockResolvedValueOnce({ succeeded: false });
    const adapter = createAzureBlobAdapter();
    await adapter.delete("org/abc/file.txt");
    expect(getBlockBlobClient).toHaveBeenCalledWith("org/abc/file.txt");
    expect(deleteIfExists).toHaveBeenCalledTimes(1);
    expect(deleteIfExists).toHaveBeenCalledWith({ deleteSnapshots: "include" });
  });

  it("stream returns the blob's bytes as a Web stream", async () => {
    download.mockResolvedValueOnce({ readableStreamBody: Readable.from([Buffer.from("payload")]) });
    const adapter = createAzureBlobAdapter();
    const stream = await adapter.stream("k");
    expect(stream).not.toBeNull();
    expect(await new Response(stream!).text()).toBe("payload");
  });

  it("stream returns null on a 404", async () => {
    download.mockRejectedValueOnce(Object.assign(new Error("nf"), { statusCode: 404, code: "BlobNotFound" }));
    const adapter = createAzureBlobAdapter();
    expect(await adapter.stream("missing")).toBeNull();
  });

  it("stream returns null when BlobNotFound arrives only as a header (no error body)", async () => {
    download.mockRejectedValueOnce(
      Object.assign(new Error("nf"), { statusCode: 404, details: { errorCode: "BlobNotFound" } }),
    );
    const adapter = createAzureBlobAdapter();
    expect(await adapter.stream("missing")).toBeNull();
  });

  it("stream rethrows a missing CONTAINER (a setup fault, not a missing file)", async () => {
    download.mockRejectedValueOnce(
      Object.assign(new Error("no container"), { statusCode: 404, code: "ContainerNotFound" }),
    );
    const adapter = createAzureBlobAdapter();
    await expect(adapter.stream("k")).rejects.toThrow(/no container/);
  });

  it("stream fails loud when a successful download has no body", async () => {
    download.mockResolvedValueOnce({ readableStreamBody: undefined });
    const adapter = createAzureBlobAdapter();
    await expect(adapter.stream("k")).rejects.toThrow(/download returned no body/);
  });

  it("stream rethrows other errors (fail loud)", async () => {
    download.mockRejectedValueOnce(Object.assign(new Error("boom"), { statusCode: 403 }));
    const adapter = createAzureBlobAdapter();
    await expect(adapter.stream("k")).rejects.toThrow(/boom/);
  });
});

describe("createAzureBlobAdapter refuses unsafe keys", () => {
  it.each(["../other/logo.png", "org/../../x", "/org/abc", "org//abc", "org\\abc", "org/./abc"])(
    "never sends %s to storage",
    async (key) => {
      const adapter = createAzureBlobAdapter();
      await expect(adapter.put(key, Buffer.from("x"), { contentType: "text/plain", filename: "x" })).rejects.toThrow(
        /unsafe storage key/,
      );
      await expect(adapter.stream(key)).rejects.toThrow(/unsafe storage key/);
      await expect(adapter.delete(key)).rejects.toThrow(/unsafe storage key/);
      expect(getBlockBlobClient).not.toHaveBeenCalled();
    },
  );
});
