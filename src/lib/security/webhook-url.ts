import { z } from "zod";

const PRIVATE_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "169.254.169.254",
  "metadata.google.internal",
]);

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 127) return true;
  if (a === 0) return true;
  return false;
}

export const webhookUrlSchema = z
  .string()
  .url()
  .max(2000)
  .refine((u) => {
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
      const host = parsed.hostname.toLowerCase();
      if (PRIVATE_HOSTNAMES.has(host)) return false;
      if (isPrivateIpv4(host)) return false;
      return true;
    } catch {
      return false;
    }
  }, "Webhook URL must be a public http(s) endpoint (no localhost, private IPs, or file://)");
