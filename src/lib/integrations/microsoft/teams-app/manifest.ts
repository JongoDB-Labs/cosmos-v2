import { zipSync, zlibSync, strToU8 } from "fflate";

/**
 * COSMOS-202 T1: the "Cosmos for Teams" app package an org admin uploads to
 * their tenant's Teams app catalog (no store listing). Built per instance:
 * the bot id is the instance's Microsoft app and the only links that unfurl
 * are this instance's host. Bump MANIFEST_VERSION when the package changes,
 * so Teams admins can tell an update from what they have.
 */

export const MANIFEST_VERSION = "1.1.0";
const ACCENT = "#4F46E5";

export interface ManifestArgs {
  appId: string;
  /** Cosmos's public origin, e.g. https://cosmos.example */
  origin: string;
}

export function teamsManifest({ appId, origin }: ManifestArgs) {
  const host = new URL(origin).host;
  return {
    $schema: "https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
    manifestVersion: "1.17",
    version: MANIFEST_VERSION,
    id: appId,
    developer: { name: "Cosmos", websiteUrl: `${origin}/`, privacyUrl: `${origin}/`, termsOfUseUrl: `${origin}/` },
    name: { short: "Cosmos", full: "Cosmos for Teams" },
    description: {
      short: "Cosmos items in Teams: link cards, create from a message, search.",
      full: "Paste a Cosmos item link to show it as a card, turn any message into a Cosmos item, and search Cosmos items from the compose box. You see only what you can see in Cosmos; restricted items show only their key.",
    },
    icons: { color: "color.png", outline: "outline.png" },
    accentColor: ACCENT,
    composeExtensions: [
      {
        botId: appId,
        commands: [
          {
            id: "searchItems",
            type: "query",
            title: "Search Cosmos",
            description: "Find a Cosmos item and insert its card",
            initialRun: true,
            parameters: [{ name: "query", title: "Search", description: "Words in the title or description", inputType: "text" }],
          },
          {
            id: "createItem",
            type: "action",
            title: "Create Cosmos item",
            description: "Create a Cosmos item from this message",
            context: ["message"],
            fetchTask: true,
          },
        ],
        messageHandlers: [{ type: "link", value: { domains: [host] } }],
      },
    ],
    // T1 d: the personal "My work" tab and a channel tab (pick a project),
    // signed in with Teams SSO against our "Expose an API" scope.
    staticTabs: [
      { entityId: "cosmos-my-work", name: "My work", contentUrl: `${origin}/teams/tab/my-work`, websiteUrl: `${origin}/`, scopes: ["personal"] },
    ],
    configurableTabs: [
      { configurationUrl: `${origin}/teams/tab/configure`, canUpdateConfiguration: true, scopes: ["team", "groupChat"] },
    ],
    webApplicationInfo: { id: appId, resource: `api://${host}/${appId}` },
    permissions: ["identity"],
    validDomains: [host],
  };
}

// ── Icons: drawn here, so the package needs no files from the image ───────────

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array) {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(strToU8(type), 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An RGBA PNG of `size` px, coloured by `px(x, y)`. */
export function png(size: number, px: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) raw.set(px(x, y), y * (size * 4 + 1) + 1 + x * 4);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, size);
  v.setUint32(4, size);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlibSync(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A ring (the Cosmos orbit): white, on the accent (color) or on nothing (outline). */
function ring(size: number, onAccent: boolean) {
  const [r, g, b] = [0x4f, 0x46, 0xe5];
  const c = size / 2, outer = size * 0.34, inner = size * 0.22;
  return png(size, (x, y) => {
    const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
    const white = d <= outer && d >= inner;
    if (white) return [255, 255, 255, 255];
    return onAccent ? [r, g, b, 255] : [0, 0, 0, 0];
  });
}

/** The zip Teams takes: manifest.json plus the two icons, at the root. */
export function teamsAppPackage(args: ManifestArgs): Uint8Array {
  return zipSync({
    "manifest.json": strToU8(JSON.stringify(teamsManifest(args), null, 2)),
    "color.png": ring(192, true),
    "outline.png": ring(32, false),
  });
}
