// The text check a webhook URL (and fetch_url's URL) passes when it is saved.
// The send-time check (outbound-post.server.ts) resolves names and pins the
// address; this one only sees the text, so it must at least refuse every
// address WRITTEN into the URL that isn't public, in every spelling.
import { describe, it, expect } from "vitest";
import { webhookUrlSchema } from "./webhook-url";

describe("webhookUrlSchema", () => {
  it.each([
    "http://localhost/x",
    "http://127.0.0.1/x",
    "http://2130706433/x", // 127.0.0.1 as one number
    "http://0x7f.1/x",
    "http://10.0.0.5/x",
    "http://100.64.0.1/x", // carrier-grade NAT
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/x",
    "http://[::ffff:127.0.0.1]/x",
    "http://[::ffff:a9fe:a9fe]/x",
    "http://[fd00::1]/x",
    "http://[fe80::1]/x",
    "http://[::]/x",
    "https://user:pw@hooks.example.com/in",
    "file:///etc/passwd",
    "ftp://hooks.example.com/in",
    // A trailing dot, another case, IPv4 inside IPv6, and the metadata names.
    "http://localhost./x",
    "http://LOCALHOST/x",
    "http://foo.localhost./x",
    "http://metadata.google.internal./x",
    "http://metadata/x",
    "http://[fd00:ec2::254]/x",
    "http://[::127.0.0.1]/x",
    "http://[::ffff:0:127.0.0.1]/x",
    "http://[::ffff:8.8.8.8]/x",
    "http://[64:ff9b::a9fe:a9fe]/x",
  ])("refuses %s", (url) => {
    expect(webhookUrlSchema.safeParse(url).success).toBe(false);
  });

  it.each([
    "https://hooks.example.com/in",
    "http://hooks.example.com:8080/in?a=1",
    "https://8.8.8.8/in",
    "https://[2606:4700:4700::1111]/in",
  ])("accepts %s", (url) => {
    expect(webhookUrlSchema.safeParse(url).success).toBe(true);
  });
});
