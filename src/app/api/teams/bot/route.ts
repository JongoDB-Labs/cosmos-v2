import { NextRequest } from "next/server";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { getRateLimitKey, rateLimit } from "@/lib/rate-limit/bucket";
import { BotAuthError, verifyBotRequest } from "@/lib/integrations/microsoft/teams-app/bot-auth.server";
import { teamsBotAppId } from "@/lib/integrations/microsoft/teams-app/identity.server";
import { handleActivity, tenantOf, type Activity } from "@/lib/integrations/microsoft/teams-app/handlers.server";

/**
 * COSMOS-202 T1: the Cosmos for Teams bot's messaging endpoint. Public (the
 * Bot Connector calls it, with no session), so it trusts nothing until the
 * Bot Framework token checks out, and is rate limited per IP before that and
 * per tenant after. Inbound text is data, never instructions.
 */

const MAX_BODY = 256 * 1024;

/**
 * The body as text, or null once it passes MAX_BODY bytes. Read off the
 * stream and counted in bytes, so neither a missing or false Content-Length
 * nor a chunked upload can make us buffer more than the limit.
 */
async function readCapped(request: NextRequest): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
const limited = (retryAfter: number) =>
  new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(retryAfter) } });

export async function POST(request: NextRequest) {
  const ip = rateLimit(getRateLimitKey(request, "teams-bot"), { capacity: 120, refillPerSecond: 2 });
  if (!ip.allowed) return limited(ip.retryAfter);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return new Response(null, { status: 413 });

  const raw = await readCapped(request);
  if (raw === null) return new Response(null, { status: 413 });
  let activity: Activity;
  try {
    activity = JSON.parse(raw) as Activity;
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!activity || typeof activity !== "object") return new Response(null, { status: 400 });

  try {
    // The app id (a database read and a decrypt) only once the signature checks out.
    await verifyBotRequest(request.headers.get("authorization"), activity, teamsBotAppId);
  } catch (e) {
    if (e instanceof BotAuthError && e.reason === "not_configured") return new Response(null, { status: 503 });
    if (e instanceof BotAuthError) {
      // The reason only: never the token.
      console.warn(`[teams-bot] refused: ${e.reason}`);
      return new Response(null, { status: 401 });
    }
    throw e;
  }

  const tenant = rateLimit(`teams-bot:tenant:${tenantOf(activity).toLowerCase()}`, { capacity: 600, refillPerSecond: 10 });
  if (!tenant.allowed) return limited(tenant.retryAfter);

  try {
    const reply = await handleActivity(activity, getPublicOrigin(request));
    return reply.body === undefined
      ? new Response(null, { status: reply.status })
      : Response.json(reply.body, { status: reply.status });
  } catch (e) {
    // The activity's name is the caller's text: logged only as a short, plain token.
    const what = String(activity.name ?? activity.type ?? "activity").replace(/[^\w.:/-]/g, "").slice(0, 64) || "activity";
    // The error's class, not its message: messages can carry query data.
    console.error(`[teams-bot] ${what} failed (${e instanceof Error ? e.name.replace(/\W/g, "").slice(0, 40) : "error"})`);
    return new Response(null, { status: 500 });
  }
}
