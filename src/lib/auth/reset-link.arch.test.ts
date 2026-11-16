// @vitest-environment node
//
// The reset page's path is spelled once, in reset-link.ts. Both routes that
// email a reset link build it there, and the proxy, which must let a signed-out
// visit reach that page, reads the same constant. A second spelling is how the
// link and the proxy drifted apart before: the link worked only when signed in.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const HOME = "src/lib/auth/reset-link.ts";

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...sources(rel));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

function code(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the reset page's path", () => {
  const files = sources("src");

  it("is spelled only in reset-link.ts", () => {
    expect(files).toContain(HOME);
    const spelled = files.filter((f) => f !== HOME && /\/reset-password(?![\w-])/.test(code(f)));
    expect(spelled).toEqual([]);
  });

  it("is read by the proxy and by every route that emails a reset link", () => {
    expect(code("src/proxy.ts")).toMatch(/\bRESET_PASSWORD_PATH\b/);
    const senders = files.filter((f) => /createPasswordResetToken\(/.test(code(f)) && f !== "src/lib/auth/password-reset.ts");
    expect(senders.length).toBeGreaterThanOrEqual(2);
    for (const f of senders) expect(code(f), f).toMatch(/\bresetPasswordUrl\(/);
  });
});
