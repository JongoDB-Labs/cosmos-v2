// A public run log must not print the server's hostname.
//
// This repository is public, so its Actions logs are too. The server URLs are
// secrets, and GitHub masks a secret only where its WHOLE value appears. When
// the server is unreachable, curl prints the bare host instead ("Could not
// resolve host: <host>", "Failed to connect to <host> port 443"), and no
// secret's mask covers that. So every job that calls the server first registers
// the host as a mask of its own, in an earlier step, so the mask is in force
// before anything that could print it runs.
//
// Nothing else would notice a job that skips it: the job works every day, and
// the host leaks only on the day the server is down. Hence this file.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const DIR = ".github/workflows";
const URL_SECRETS = ["COSMOS_BASE_URL", "GITLAB_ASSEMBLY_TRIGGER_URL"];
// Deleted as variables on 2026-11-11: a step prints a variable's value
// unmasked, so reading one again, even as a fallback, would publish it.
const SECRET_ONLY = [...URL_SECRETS, "COSMOS_ORG_ID"];
const MASK_STEP = "Mask the server's hostname";

type Step = { name?: string; if?: unknown; env?: Record<string, string>; run?: string };
type Job = { steps?: Step[]; secrets?: unknown };
const jobs = readdirSync(DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .flatMap((file) => {
    const wf = parse(readFileSync(`${DIR}/${file}`, "utf8")) as {
      env?: unknown;
      jobs?: Record<string, Job>;
    };
    return Object.entries(wf.jobs ?? {}).map(([id, job]) => ({
      where: `${file} ${id}`,
      steps: job.steps ?? [],
      // Everything the job can see: its own env, `with:`, steps and secrets
      // mapping, and the workflow-level env every job inherits.
      text: JSON.stringify({ env: wf.env ?? null, job }),
      inherits: job.secrets === "inherit",
    }));
  });

// Secret and variable names are case-insensitive, and an expression can read
// one as `secrets.NAME`, `secrets['NAME']`, or all at once through toJSON.
const reads = (ctx: "secrets" | "vars", name: string) =>
  new RegExp(
    `\\b${ctx}\\s*(?:\\.\\s*${name}\\b|\\[\\s*\\\\?['"]${name}\\\\?['"]\\s*\\])|toJSON\\(\\s*${ctx}\\s*\\)`,
    "i",
  );

const isMask = (s: Step) => s.name === MASK_STEP;
// The masks a job registers before anything else runs.
const leadingMasks = (steps: Step[]) => {
  const n = steps.findIndex((s) => !isMask(s));
  return n === -1 ? steps : steps.slice(0, n);
};
const callers = jobs.flatMap((job) =>
  URL_SECRETS.filter((secret) => job.inherits || reads("secrets", secret).test(job.text)).map(
    (secret) => ({ ...job, secret }),
  ),
);
const masks = jobs.flatMap((job) => job.steps.filter(isMask).map((step) => ({ ...job, step })));

const mask = (script: string, url: string) =>
  // How GitHub runs a `run:` step that names no `shell:` (its log says
  // `/usr/bin/bash -e {0}`): no pipefail.
  spawnSync("bash", ["-e", "-c", script], {
    env: { ...process.env, URL: url },
    encoding: "utf8",
  });

describe("public run logs cannot print the server's hostname", () => {
  it("found the jobs that call the server", () => {
    // Positive control: a renamed secret would make the rules below vacuous.
    expect(callers.map((c) => c.where)).toEqual(
      expect.arrayContaining([
        "feedback-remediation.yml remediate",
        "feedback-remediation-pr.yml plan",
        "teams-digest.yml digest",
        "release.yml dispatch-assembly",
      ]),
    );
  });

  it("masks the host first in every job that can read a server URL", () => {
    for (const { where, steps, secret } of callers) {
      const first = leadingMasks(steps);
      expect(
        first.map((s) => s.env?.URL),
        `${where} can read ${secret} but does not start by masking its host`,
      ).toContain(`\${{ secrets.${secret} }}`);
    }
  });

  it("never skips a mask step", () => {
    for (const { where, step } of masks) expect(step.if, where).toBeUndefined();
  });

  it("reads deployment identity from secrets only, never a variable", () => {
    for (const file of readdirSync(DIR)) {
      const text = readFileSync(`${DIR}/${file}`, "utf8");
      for (const name of SECRET_ONLY) {
        expect(reads("vars", name).test(text), `${file} reads vars.${name}`).toBe(false);
      }
    }
  });

  const cases: [string, string][] = [
    ["https://cosmos.example.net", "cosmos.example.net"],
    ["https://cosmos.example.net/", "cosmos.example.net"],
    ["https://gitlab.example.dev/api/v4/projects/7/trigger/pipeline", "gitlab.example.dev"],
    ["https://gitlab.example.dev:8443/api", "gitlab.example.dev"],
    ["https://bot@cosmos.example.net/x", "cosmos.example.net"],
    ["cosmos.example.net", "cosmos.example.net"],
    ["https://cosmos.example.net?tenant=1", "cosmos.example.net"],
    ["https://cosmos.example.net#top", "cosmos.example.net"],
  ];

  it("masks exactly the host, and prints nothing else", () => {
    expect(masks.length).toBeGreaterThanOrEqual(4);
    for (const { where, step } of masks) {
      for (const [url, host] of cases) {
        const r = mask(step.run ?? "", url);
        expect(r.status, `${where}: ${r.stderr}`).toBe(0);
        expect(r.stdout, `${where} on ${url}`).toBe(`::add-mask::${host}\n`);
      }
    }
  });

  it("does nothing, and still succeeds, when the secret is unset", () => {
    // Every caller skips cleanly when unconfigured; the mask must not fail first.
    expect(masks.length).toBeGreaterThanOrEqual(4);
    for (const { where, step } of masks) {
      const r = mask(step.run ?? "", "");
      expect([r.status, r.stdout], where).toEqual([0, ""]);
    }
  });
});
