// scripts/cutover/lib/snapshot.test.ts
import { describe, it, expect } from "vitest";
import {
  assertValidLabel,
  buildCreateRestorePointSql,
  buildRestoreArgv,
  buildRestoreCommand,
  buildSnapshotRecord,
  parseSnapshotRecord,
  restoreCommandsForRecord,
} from "./snapshot";

describe("assertValidLabel — restore-point name validation", () => {
  it("accepts a typical cutover label", () => {
    expect(assertValidLabel("cutover-acme-preflip")).toBe("cutover-acme-preflip");
    expect(assertValidLabel("cutover-test-preflip")).toBe("cutover-test-preflip");
    expect(assertValidLabel("preflip_2026.06.07")).toBe("preflip_2026.06.07");
  });

  it("rejects empty / whitespace / quotes / shell metacharacters (fail-closed)", () => {
    for (const bad of ["", " ", "a b", "a'b", 'a"b', "a;b", "a/b", "$(x)", "a`b", "-leading-dash"]) {
      expect(() => assertValidLabel(bad)).toThrow();
    }
  });

  it("rejects an over-long label (>63 chars)", () => {
    expect(() => assertValidLabel("a".repeat(64))).toThrow();
    expect(assertValidLabel("a".repeat(63))).toHaveLength(63);
  });
});

describe("buildCreateRestorePointSql", () => {
  it("builds the pg_create_restore_point SELECT returning lsn", () => {
    const sql = buildCreateRestorePointSql("cutover-test-preflip");
    expect(sql).toBe("SELECT pg_create_restore_point('cutover-test-preflip') AS lsn;");
  });

  it("validates the label before inlining it (rejects injection attempts)", () => {
    expect(() => buildCreateRestorePointSql("x'); DROP TABLE users;--")).toThrow();
  });
});

describe("buildRestoreArgv / buildRestoreCommand — NAMED + TIME targets", () => {
  it("builds a named-target restore (promote by default)", () => {
    const argv = buildRestoreArgv({ stanza: "cosmos", target: { type: "name", target: "cutover-test-preflip" } });
    expect(argv).toEqual([
      "pgbackrest",
      "--stanza=cosmos",
      "--type=name",
      "--target=cutover-test-preflip",
      "--target-action=promote",
      "restore",
    ]);
    expect(buildRestoreCommand({ stanza: "cosmos", target: { type: "name", target: "cutover-test-preflip" } })).toBe(
      "pgbackrest --stanza=cosmos --type=name --target=cutover-test-preflip --target-action=promote restore",
    );
  });

  it("builds a time-target restore variant", () => {
    const ts = "2026-06-07T12:00:00Z";
    const cmd = buildRestoreCommand({ stanza: "cosmos", target: { type: "time", target: ts } });
    expect(cmd).toContain("--type=time");
    expect(cmd).toContain(`--target=${ts}`);
    expect(cmd).toContain("--target-action=promote");
    expect(cmd.endsWith(" restore")).toBe(true);
  });

  it("honors --delta and no-promote", () => {
    const argv = buildRestoreArgv({
      stanza: "cosmos",
      target: { type: "name", target: "p" },
      promote: false,
      delta: true,
    });
    expect(argv).toContain("--delta");
    expect(argv).not.toContain("--target-action=promote");
  });

  it("shell-quotes a time target that contains spaces (PG timestamp form)", () => {
    const cmd = buildRestoreCommand({ stanza: "cosmos", target: { type: "time", target: "2026-06-07 12:00:00+00" } });
    // The whole token is single-quoted (equivalent + shell-safe); the value is intact.
    expect(cmd).toContain("'--target=2026-06-07 12:00:00+00'");
    // and as argv the value is passed verbatim (no shell at all).
    const argv = buildRestoreArgv({ stanza: "cosmos", target: { type: "time", target: "2026-06-07 12:00:00+00" } });
    expect(argv).toContain("--target=2026-06-07 12:00:00+00");
  });

  // ── THE INVARIANT: never emit a targetless restore ──
  it("THROWS rather than emit a restore with no target (replay-to-end is NOT a rollback)", () => {
    // empty named target
    expect(() => buildRestoreArgv({ stanza: "cosmos", target: { type: "name", target: "" } })).toThrow(/TARGETLESS|invalid/i);
    // empty time target
    expect(() => buildRestoreArgv({ stanza: "cosmos", target: { type: "time", target: "" } })).toThrow(/TARGETLESS/i);
    // whitespace-only time target
    expect(() => buildRestoreArgv({ stanza: "cosmos", target: { type: "time", target: "   " } })).toThrow(/TARGETLESS/i);
    // missing target object entirely
    // @ts-expect-error — exercising the runtime guard
    expect(() => buildRestoreArgv({ stanza: "cosmos" })).toThrow(/target/i);
    // bad target type
    // @ts-expect-error — exercising the runtime guard
    expect(() => buildRestoreArgv({ stanza: "cosmos", target: { type: "latest" } })).toThrow(/target/i);
  });

  it("requires a non-empty stanza", () => {
    expect(() => buildRestoreArgv({ stanza: "", target: { type: "name", target: "p" } })).toThrow(/stanza/i);
  });

  it("EVERY emitted restore command carries a --target= token", () => {
    for (const target of [
      { type: "name" as const, target: "cutover-test-preflip" },
      { type: "time" as const, target: "2026-06-07T12:00:00Z" },
    ]) {
      const cmd = buildRestoreCommand({ stanza: "cosmos", target });
      expect(cmd).toMatch(/--target=/);
      expect(cmd).toMatch(/--type=(name|time)/);
    }
  });
});

describe("buildSnapshotRecord / parseSnapshotRecord — the persisted record", () => {
  const input = {
    label: "cutover-test-preflip",
    lsn: "0/1A2B3C0",
    restorePointTime: "2026-06-07T12:00:00Z",
    stanza: "cosmos",
    timeline: 1,
    capturedAt: "2026-06-07T12:00:00Z",
    backupLabel: "20260607-120000F_20260607-120500I",
  };

  it("assembles the full record verbatim", () => {
    expect(buildSnapshotRecord(input)).toEqual(input);
  });

  it("nulls optional fields when absent (named restore still possible)", () => {
    const rec = buildSnapshotRecord({
      label: "cutover-test-preflip",
      restorePointTime: "2026-06-07T12:00:00Z",
      stanza: "cosmos",
      capturedAt: "2026-06-07T12:00:00Z",
    });
    expect(rec.lsn).toBeNull();
    expect(rec.timeline).toBeNull();
    expect(rec.backupLabel).toBeNull();
  });

  it("requires label, stanza, restorePointTime, capturedAt (fail-closed)", () => {
    expect(() => buildSnapshotRecord({ ...input, label: "bad label" })).toThrow();
    expect(() => buildSnapshotRecord({ ...input, stanza: "" })).toThrow(/stanza/i);
    expect(() => buildSnapshotRecord({ ...input, restorePointTime: "" })).toThrow(/restorePointTime/i);
    expect(() => buildSnapshotRecord({ ...input, capturedAt: "" })).toThrow(/capturedAt/i);
  });

  it("round-trips through JSON via parseSnapshotRecord", () => {
    const rec = buildSnapshotRecord(input);
    const parsed = parseSnapshotRecord(JSON.parse(JSON.stringify(rec)));
    expect(parsed).toEqual(rec);
  });

  it("parseSnapshotRecord rejects non-objects + malformed records", () => {
    expect(() => parseSnapshotRecord(null)).toThrow();
    expect(() => parseSnapshotRecord("x")).toThrow();
    expect(() => parseSnapshotRecord({ label: "p", stanza: "cosmos" })).toThrow(/restorePointTime/i);
    expect(() => parseSnapshotRecord({ label: "bad label", stanza: "cosmos", restorePointTime: "t", capturedAt: "t" })).toThrow();
  });
});

describe("restoreCommandsForRecord — what the orchestrator emits on rollback", () => {
  const rec = buildSnapshotRecord({
    label: "cutover-acme-preflip",
    lsn: "0/1A2B3C0",
    restorePointTime: "2026-06-07T12:00:00Z",
    stanza: "cosmos",
    capturedAt: "2026-06-07T12:00:00Z",
  });

  it("emits a named (primary) and a time (fallback) command, both with a target + --delta", () => {
    const cmds = restoreCommandsForRecord(rec);
    expect(cmds.named).toBe(
      "pgbackrest --stanza=cosmos --type=name --target=cutover-acme-preflip --target-action=promote --delta restore",
    );
    expect(cmds.time).toContain("--type=time");
    expect(cmds.time).toContain("--target=2026-06-07T12:00:00Z");
    // never targetless
    expect(cmds.named).toMatch(/--target=/);
    expect(cmds.time).toMatch(/--target=/);
  });
});
