/**
 * Decide whether a proposed move of a plugin pin is an advance or a rollback.
 *
 * Split out of lock.mjs so the rule can be tested without a git repository —
 * the same shape as lock-merge.mjs, and for the same reason.
 *
 * THE RULE: a pin may only move to a DESCENDANT of the commit it replaces.
 *
 * ## The defect this exists for
 *
 * `--write` records the HEAD of each checkout under `plugins/`. It never asked
 * whether that HEAD was ahead of the pin it was replacing, so a STALE checkout
 * produced a lockfile that silently reverted the plugin — and said so in the
 * language of progress:
 *
 *     [plugin-lock] foreman: e7e2772 → 5456154
 *
 * Twice (PRs #839, #860) that exact line meant "revert 174 commits of the
 * daemon", including the fix for a spin that OOM'd it in production. Nothing in
 * the output, the diff, or the generated PR title distinguishes it from a real
 * advance: the title reports a VERSION STRING, and a version string read in
 * isolation cannot tell you which direction you are travelling.
 *
 * A stale checkout is the normal state of a dev box, not an exotic one — each
 * plugin is a separate private repo, so nothing keeps `plugins/<slug>` current.
 * At the time of writing, the primary checkout on the author's machine held
 * foreman 1.28.0 against a live 1.96.0.
 *
 * ## Why every non-advance fails, not just a rollback
 *
 * `unknown` is the case that actually catches the bug in the wild. A checkout
 * stale enough to roll the pin back is usually stale enough not to CONTAIN the
 * commit it is replacing — it was fetched before that commit existed. Treating
 * "I cannot tell" as "probably fine" would let the most common form of the
 * defect through the guard built for it, so it is a failure with a message
 * naming the fetch that would settle it.
 *
 * `diverged` means the two commits share no ancestry — a force-push, a rebuilt
 * history, or the wrong repository entirely. Rare, never routine, always worth
 * a human.
 *
 * The escape hatch is `--allow-rollback`, deliberately named after the dangerous
 * case rather than something neutral like `--force`.
 */

/**
 * How the replacement commit relates to the one being replaced, as observed in
 * a checkout. Callers compute this; this module only judges it.
 *
 * - `advance`  — `to` is a descendant of `from`. The only acceptable move.
 * - `rollback` — `to` is an ANCESTOR of `from`. Reverts work.
 * - `diverged` — neither is an ancestor of the other.
 * - `unknown`  — the checkout does not contain both commits, so it cannot say.
 *
 * @typedef {"advance" | "rollback" | "diverged" | "unknown"} Ancestry
 */

/** Short form used in every message, matching the existing log style. */
const short = (ref) => (ref === "main" ? "main" : String(ref).slice(0, 9));

/**
 * Judge one proposed pin move.
 *
 * `ancestry` is only consulted when the pin actually moves between two commits.
 * A new plugin, a plugin deliberately tracked at `main`, and an unchanged pin
 * are all fine without asking git anything — which also means the caller never
 * has to run git for a plugin that has no checkout.
 *
 * @param {object} move
 * @param {string} move.slug         plugin slug, for the message
 * @param {string} [move.from]       the ref being replaced; undefined if newly pinned
 * @param {string} move.to           the ref being written
 * @param {Ancestry} [move.ancestry] how `to` relates to `from`, when both are commits
 * @returns {{ok: boolean, slug: string, kind: string, message: string}}
 */
export function lockMoveVerdict({ slug, from, to, ancestry }) {
  if (!from) {
    return { ok: true, slug, kind: "new", message: `${slug}: ${short(to)} — newly pinned` };
  }
  // `main` is a deliberate "track head" pin, so there is no commit to compare
  // against and nothing to protect: whoever wrote `main` asked for whatever is
  // there. Leaving it alone is the whole reason REF_RE admits `main` at all.
  if (from === "main") {
    return { ok: true, slug, kind: "tracking", message: `${slug}: main → ${short(to)} (was tracking head)` };
  }
  if (from === to) {
    return { ok: true, slug, kind: "unchanged", message: `${slug}: ${short(to)} — unchanged` };
  }

  switch (ancestry) {
    case "advance":
      return { ok: true, slug, kind: "advance", message: `${slug}: ${short(from)} → ${short(to)}` };
    case "rollback":
      return {
        ok: false,
        slug,
        kind: "rollback",
        message:
          `${slug}: ${short(from)} → ${short(to)} ROLLS THE PIN BACK — ` +
          `${short(to)} is an ancestor of ${short(from)}, so this reverts every commit between them. ` +
          `Fetch and check out the current plugin main, or pass --allow-rollback if the revert is deliberate.`,
      };
    case "diverged":
      return {
        ok: false,
        slug,
        kind: "diverged",
        message:
          `${slug}: ${short(from)} → ${short(to)} is not a descendant of the pin it replaces — ` +
          `the two commits share no ancestry. Check that plugins/${slug} is the right repository and ` +
          `has not been force-pushed, or pass --allow-rollback.`,
      };
    default:
      return {
        ok: false,
        slug,
        kind: "unknown",
        message:
          `${slug}: cannot verify ${short(from)} → ${short(to)} — plugins/${slug} does not contain both ` +
          `commits, so the direction of the move is unknown. This is what a checkout too old to hold the ` +
          `current pin looks like: run \`git -C plugins/${slug} fetch\` and retry, or pass --allow-rollback.`,
      };
  }
}

/**
 * Judge a whole proposed `plugins` map.
 *
 * Takes the map that is ABOUT TO BE WRITTEN, not the discovered heads, so the
 * guard cannot be sidestepped by anything mergeLock() does on the way —
 * including carrying a pin over untouched for a plugin with no checkout.
 *
 * @param {Record<string,{ref:string}>} next    the map lock.mjs intends to write
 * @param {Record<string,{ref:string}>} locked  the map currently on disk
 * @param {(slug: string, from: string, to: string) => Ancestry} ancestryOf
 *        consulted ONLY for pins that move between two commits
 * @returns {{verdicts: Array<{ok:boolean,slug:string,kind:string,message:string}>,
 *            problems: Array<{ok:boolean,slug:string,kind:string,message:string}>}}
 */
export function judgeLockMoves(next, locked, ancestryOf) {
  const verdicts = Object.entries(next).map(([slug, entry]) => {
    const from = locked[slug]?.ref;
    const to = entry.ref;
    const comparable = from !== undefined && from !== "main" && from !== to;
    return lockMoveVerdict({
      slug,
      from,
      to,
      ancestry: comparable ? ancestryOf(slug, from, to) : undefined,
    });
  });
  return { verdicts, problems: verdicts.filter((v) => !v.ok) };
}
