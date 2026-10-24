/**
 * A request body as text, or null once it passes `maxBytes`. Read off the
 * stream and counted in bytes, so neither a missing or false Content-Length
 * nor a chunked upload can make an unauthenticated endpoint buffer more than
 * the limit (COSMOS-202 T1).
 */
export async function readCapped(request: Request, maxBytes: number): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
