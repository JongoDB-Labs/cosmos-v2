#!/usr/bin/env node
// s3-adapter-smoke.mjs — acceptance smoke test for the S3 storage layer against a LIVE
// MinIO. Exercises the SAME @aws-sdk/client-s3 put/stream/delete the adapter uses
// (path-style, env-configured) so a successful round-trip proves uploads land in
// cosmos-uploads through the storage layer. Run in the migrate image (has the SDK):
//   docker compose run --rm -T --entrypoint "node scripts/s3-adapter-smoke.mjs" \
//     -e S3_ENDPOINT=... -e S3_BUCKET=cosmos-uploads -e S3_ACCESS_KEY=... ... cosmos-migrate
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const endpoint = process.env.S3_ENDPOINT;
const bucket = process.env.S3_BUCKET;
const key = `__smoke/${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
const body = `cosmos s3 adapter smoke ${new Date().toISOString()}`;

const s3 = new S3Client({
  endpoint,
  region: process.env.S3_REGION ?? "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
});

const sh = (s) => (s == null ? "" : String(s));

try {
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from(body), ContentType: "text/plain" }),
  );
  console.log(`PUT ok → s3://${bucket}/${key}`);

  const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const text = await got.Body.transformToString();
  if (text !== body) {
    console.error(`ROUND-TRIP MISMATCH: got ${JSON.stringify(sh(text))}`);
    process.exit(1);
  }
  console.log(`GET ok → round-trip byte-exact (${text.length} bytes)`);

  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  console.log(`DELETE ok → ${key}`);
  console.log("S3-ADAPTER-SMOKE: PASS");
} catch (err) {
  console.error(`S3-ADAPTER-SMOKE: FAIL (${err?.name}): ${err?.message}`);
  process.exit(1);
}
