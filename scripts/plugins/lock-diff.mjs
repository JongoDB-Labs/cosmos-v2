/**
 * Judge a CHANGE to plugins.lock.json — base version against head version.
 *
 * This is the half of the lock's protection that lives where the lock is
 * reviewed, rather than where it is generated.
 *
 * ## Why a separate check at all
 *
 * `lock.mjs --write` already refuses a pin that does not move forward
 * (lock-direction.mjs) and a `"version"` that does not name its pin
 * (lock-version.mjs). Both of those run INSIDE the generator, against real
 * plugin checkouts. Anything that writes this file another way gets neither:
 *
 *   - The nightly drift sweep in the private assembly writes plugins.lock.json
 *     through the forge's contents API. It sets `.ref` and leaves `.version`
 *     exactly as it found it, so its rolling branch moves foreman's pin while
 *     still claiming the previous release tag. A reviewer reading that diff sees
 *     two SHAs change and the version column stay put — the change looks like
 *     nothing happened.
 *   - A hand edit gets neither check either, for the same reason.
 *
 * So until this file existed, the only enforcement of the lock's rules was
 * reachable solely by the one tool that already obeyed them. That is the shape
 * of a guard that exempts the thing it was built to catch.
 *
 * ## What this can and cannot know
 *
 * It runs in the public core, which has no access to the private plugin repos.
 * So it CANNOT ask git whether a new pin descends from the old one — that test
 * needs the plugin's history and stays with lock.mjs and the sweep.
 *
 * What it can read is the pair (`ref`, `version`), and the rules below are the
 * ones that pair supports. The release tag is a SemVer number, so a pin whose
 * annotation moves DOWN is a rollback stated in the file itself; a pin that
 * moves while its annotation does not is either a false claim about which
 * release ships, or an advance nobody re-derived. Both are failures here.
 *
 * ## Why a missing annotation is only a notice
 *
 * `lock.mjs --write` deliberately records a pin with NO version when the plugin
 * HEAD is not a tagged release, and warns. Cutting the tag is an operator step
 * in the plugin repos, so a release can be merged and lockable hours before it
 * is tagged. Failing that case would mean the only way to ship a merged plugin
 * fix is a step the author may not be able to take — and a gate that blocks the
 * sole path a release has does not get fixed, it gets bypassed. An absent
 * annotation claims nothing false; a stale one does. So: absent is reported
 * loudly and passes, stale fails.
 */

import { PUBLIC_PLUGINS } from "./lock-merge.mjs";
import { VERSION_RE } from "./lock-version.mjs";

/** Short form, matching the existing lock log style. */
const short = (ref) => (ref === "main" ? "main" : String(ref).slice(0, 9));

/** [major, minor, patch] of a vX.Y.Z tag, or null if it is not one. */
function parts(tag) {
  const m = /^v([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(String(tag ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** <0, 0, >0 comparing two vX.Y.Z tags, or null if either is not one. */
function cmpVersions(a, b) {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * Judge every pin in a proposed lockfile against the one it replaces.
 *
 * Both arguments are the lockfile's `plugins` MAP, as judgeLockMoves and
 * judgeLockVersions take it — not the whole file.
 *
 * @param {Record<string,{ref?:string, version?:string}>} base  the map on the base branch
 * @param {Record<string,{ref?:string, version?:string}>} head  the map being proposed
 * @param {{publicPlugins?: readonly string[]}} [opts]
 *        publicPlugins — the slugs this lockfile may name, so a removal that is
 *        accompanied by dropping the slug from the allowlist is sanctioned
 *        rather than flagged. Defaults to PUBLIC_PLUGINS.
 * @returns {{problems: {slug:string,kind:string,message:string}[],
 *            notices: {slug:string,kind:string,message:string}[]}}
 */
export function judgeLockDiff(base, head, opts = {}) {
  const { publicPlugins = PUBLIC_PLUGINS } = opts;
  const problems = [];
  const notices = [];
  const fail = (slug, kind, message) => problems.push({ slug, kind, message });
  const note = (slug, kind, message) => notices.push({ slug, kind, message });

  for (const slug of Object.keys(head).sort()) {
    const h = head[slug] ?? {};
    const b = base[slug];

    // Shape of the annotation. lock.test.ts asserts this over the committed
    // file; asserted here too because this check must be able to stand alone
    // when it is the only thing a reviewer ran.
    if (h.version !== undefined && !VERSION_RE.test(String(h.version))) {
      fail(slug, "version-shape", `${slug}: version "${h.version}" is not a vX.Y.Z tag`);
      continue;
    }

    if (!b) {
      note(slug, "new", `${slug}: ${short(h.ref)} — newly pinned${h.version ? ` (${h.version})` : ""}`);
      continue;
    }

    const refMoved = b.ref !== h.ref;

    // Un-pinning. `main` is a legitimate value for a plugin deliberately
    // tracked at head, so the shape check allows it and lock-direction.mjs
    // treats a pin that was ALREADY `main` as nothing to protect. Moving a
    // SHA-pinned plugin TO `main` is the opposite: it gives up reproducibility
    // for every later build, and nothing else in the lock tooling says so.
    if (refMoved && h.ref === "main") {
      fail(
        slug,
        "unpinned",
        `${slug}: ${short(b.ref)} → main UN-PINS this plugin — every build from here composes whatever ` +
          `its main happens to be, so the image a release describes stops being reproducible. ` +
          `Pin the commit instead: node scripts/plugins/lock.mjs --write`,
      );
      continue;
    }

    if (refMoved && h.version !== undefined && h.version === b.version) {
      // THE DEFECT IN EVIDENCE. The nightly sweep's rolling branch, read on
      // 2026-11-17: foreman's ref moved 470e0488 → 3cb9fd05 with `version`
      // still "v1.134.1", and whiteboard's moved with `version` still "v0.6.0".
      // A tag names ONE commit, so after the move the annotation describes a
      // commit the lock no longer pins — and the diff a reviewer reads shows
      // only SHAs changing, with the version column identical.
      fail(
        slug,
        "stale-version",
        `${slug}: ref moved ${short(b.ref)} → ${short(h.ref)} but version is still ${h.version} — ` +
          `a tag names one commit, so the annotation now describes a commit this lock does not pin. ` +
          `Regenerate the file instead of editing it: node scripts/plugins/lock.mjs --write`,
      );
      continue;
    }

    if (refMoved && h.version === undefined && b.version !== undefined) {
      // Honest, and what lock.mjs --write produces for an untagged HEAD. Said
      // out loud because the reviewer is now the only thing that knows which
      // release this is.
      note(
        slug,
        "untagged",
        `${slug}: ref moved ${short(b.ref)} → ${short(h.ref)} and dropped its version annotation — ` +
          `the new pin is not a tagged release, so nothing here names what ships. Allowed; cut the ` +
          `vX.Y.Z tag in the plugin repo and re-run lock.mjs --write to record it.`,
      );
      continue;
    }

    if (refMoved && h.version !== undefined && b.version !== undefined) {
      const c = cmpVersions(h.version, b.version);
      if (c !== null && c < 0) {
        // The #839 / #860 / #912 class, as it looks when the annotations move
        // with the pin: foreman v1.134.1 → v1.14.1 was proposed three times,
        // each time reverting hundreds of commits of daemon work under a title
        // that read like routine maintenance.
        fail(
          slug,
          "rollback",
          `${slug}: ${b.version} → ${h.version} MOVES THE PIN BACK to an earlier release — ` +
            `this reverts every plugin change between them in the next image. If the revert is ` +
            `deliberate, say so in the PR and record it with: ` +
            `node scripts/plugins/lock.mjs --write --allow-rollback`,
        );
        continue;
      }
      note(slug, "advance", `${slug}: ${short(b.ref)} → ${short(h.ref)} (${b.version} → ${h.version})`);
      continue;
    }

    // From here the ref did NOT move.
    if (h.version !== undefined && b.version !== undefined && h.version !== b.version) {
      fail(
        slug,
        "retagged",
        `${slug}: pin unchanged at ${short(h.ref)} but version changed ${b.version} → ${h.version} — ` +
          `one commit cannot be two releases. Either the tag was moved (it must not be) or the ` +
          `annotation is wrong.`,
      );
      continue;
    }
    if (h.version === undefined && b.version !== undefined) {
      note(
        slug,
        "annotation-removed",
        `${slug}: pin unchanged at ${short(h.ref)} but version ${b.version} was removed — ` +
          `if the tag no longer names this commit, that is worth knowing why.`,
      );
      continue;
    }
    if (h.version !== undefined && b.version === undefined) {
      note(
        slug,
        "annotation-added",
        `${slug}: pin unchanged at ${short(h.ref)}, now annotated ${h.version} — the pin it already had ` +
          `has been released.`,
      );
      continue;
    }
    note(slug, "unchanged", `${slug}: ${short(h.ref)} — unchanged`);
  }

  for (const slug of Object.keys(base).sort()) {
    if (slug in head) continue;
    if (publicPlugins.includes(slug)) {
      // mergeLock() documents what an absent entry costs: the assembly build
      // falls back to the plugin's main, so the release stops being
      // reproducible and composes work its changelog never mentioned. lock.mjs
      // needs --prune to do this on purpose; a diff can do it by accident.
      fail(
        slug,
        "removed",
        `${slug}: pin ${short(base[slug]?.ref)} was REMOVED — the build then falls back to that ` +
          `plugin's main, which is not reproducible. Removing a plugin is deliberate: drop its slug ` +
          `from PUBLIC_PLUGINS in scripts/plugins/lock-merge.mjs in the same change, and regenerate ` +
          `with: node scripts/plugins/lock.mjs --write --prune`,
      );
    } else {
      note(slug, "removed-private", `${slug}: pin removed, and it is not a public plugin — correct.`);
    }
  }

  return { problems, notices };
}
