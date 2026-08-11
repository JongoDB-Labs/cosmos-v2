/**
 * The one update check. Both triggers call this and nothing else.
 *
 * There are two ways an update check should be able to start: an operator
 * pressing a button, and a scheduler firing on a cadence. They must not be two
 * implementations. Two implementations drift, and a drifted check is how you get
 * a scheduler quietly disagreeing with the screen an operator is looking at.
 * So this module is the whole check, and a trigger is only a caller.
 *
 * IT DOES NOT ACTUATE. Nothing here pulls, deploys, restarts or writes. The app
 * runs inside the image under discussion and cannot replace itself; an in-app
 * path that could would also be a route from the web tier into the host, which
 * on a CUI-adjacent deployment is not a trade worth making. This answers "is
 * there an update, what is in it, and would it be safe" — applying stays with
 * the host-side runner that already owns `deploy-migrate.sh`, its `pg_dump` and
 * its restore-on-fail.
 */
import { listTags, resolveDigest, parseImageRef } from "./registry";
import { versionsFromTags, updateStatus, type UpdateStatus } from "./versions";
import { evaluatePreflights, canApply, type PreflightFacts, type PreflightResult } from "./preflight";
import { fetchReleaseNotes, type ReleaseNote } from "./notes";

export interface UpdateConfig {
  /** Repository of the app image, e.g. `registry.example.com/cosmos/assembly/alpha`. */
  repo: string;
  /** Repository of the paired migration image. Defaults to `<repo>-migrate`. */
  migrateRepo: string;
  /** Tag suffix for a composed instance (e.g. `alpha`), or "" for the neutral core. */
  suffix: string;
  /**
   * Repository carrying `<version>-notes` artifacts. Defaults to the image
   * repository, so a disconnected site that mirrors its images gets notes from
   * the same mirror and needs no second network path. Point it at the neutral
   * core repository when a per-instance composed repository carries no notes —
   * release notes describe the core version, not the composition.
   */
  notesRepo: string;
  username?: string;
  password?: string;
}

/**
 * Read deployment configuration from the environment.
 *
 * The registry is CONFIGURATION, never request input — a host that arrived in an
 * HTTP request would make this an SSRF primitive with credentials attached.
 * Returns null when unconfigured, which disables the feature rather than
 * guessing a registry.
 */
export function updateConfigFromEnv(
  // `Record<string, string | undefined>`, NOT `NodeJS.ProcessEnv`. This function
  // reads four string keys; typing it as ProcessEnv couples it to Next's
  // augmentation of that interface, which is a "weak type" — three composed-only
  // type regressions in the Foreman plugin came from exactly that coupling, and
  // it also makes every test supply an unrelated NODE_ENV to construct a stub.
  env: Record<string, string | undefined> = process.env,
): UpdateConfig | null {
  const repo = env.COSMOS_UPDATE_IMAGE_REPO?.trim();
  if (!repo) return null;

  // Same derivation the deploy script and Foreman's gate use: the suffix is the
  // repo's last path segment, so it survives a registry move.
  const last = repo.split("/").pop() ?? "";
  const derived = last === "cosmos-v2" ? "" : last.startsWith("cosmos-v2-") ? last.slice(10) : last;

  return {
    repo,
    migrateRepo: env.COSMOS_UPDATE_MIGRATE_REPO?.trim() || `${repo}-migrate`,
    suffix: env.COSMOS_UPDATE_TAG_SUFFIX?.trim() ?? derived,
    notesRepo: env.COSMOS_UPDATE_NOTES_REPO?.trim() || repo,
    username: env.COSMOS_UPDATE_REGISTRY_USERNAME?.trim() || undefined,
    password: env.COSMOS_UPDATE_REGISTRY_PASSWORD?.trim() || undefined,
  };
}

/** Candidate tags to try, newest naming first — identical to deploy-migrate.sh. */
export function candidateTags(version: string, suffix: string): string[] {
  return suffix ? [`${version}-${suffix}`, version] : [version];
}

export interface UpdateCheck {
  configured: boolean;
  checkedAt: string;
  status: UpdateStatus | null;
  /** Digest the candidate resolves to, when one was found. */
  candidateDigest: string | null;
  /** Tag the candidate resolved at, for display and for the actuator to reuse. */
  candidateTag: string | null;
  preflights: PreflightResult[];
  /** Notes for the newer releases, newest first. Empty when none are published. */
  notes: ReleaseNote[];
  /** Newer releases whose notes were not looked up, so the UI can say so. */
  notesOmitted: number;
  applyable: boolean;
  /** Populated when the check itself failed; never contains a response body. */
  error: string | null;
}

export interface CheckDeps {
  listTags: typeof listTags;
  resolveDigest: typeof resolveDigest;
  fetchReleaseNotes: typeof fetchReleaseNotes;
  /** Whether the database answers — supplied by the caller, which owns the client. */
  probeDb: () => Promise<boolean>;
  /** Health of the running instance before anything is touched. */
  probeHealth: () => Promise<boolean>;
  now: () => Date;
}

const unconfigured = (now: Date): UpdateCheck => ({
  configured: false,
  checkedAt: now.toISOString(),
  status: null,
  candidateDigest: null,
  candidateTag: null,
  preflights: [],
  notes: [],
  notesOmitted: 0,
  applyable: false,
  error: null,
});

/**
 * Ask the registry what exists, decide whether it is newer, and score the
 * preflights. Read-only from end to end.
 */
export async function checkForUpdates(
  currentVersion: string,
  config: UpdateConfig | null,
  deps: CheckDeps,
): Promise<UpdateCheck> {
  const now = deps.now();
  if (!config) return unconfigured(now);

  const base = {
    configured: true as const,
    checkedAt: now.toISOString(),
    candidateDigest: null as string | null,
    candidateTag: null as string | null,
  };

  let tags: string[];
  try {
    tags = await deps.listTags(config.repo, { username: config.username, password: config.password });
  } catch (e) {
    // A registry we cannot read is an UNKNOWN, not a "you are up to date".
    // Reporting no-update-available here is the exact lie this feature exists
    // to stop telling.
    return {
      ...base,
      status: null,
      preflights: [],
      notes: [],
      notesOmitted: 0,
      applyable: false,
      error: e instanceof Error ? e.message : "registry check failed",
    };
  }

  const status = updateStatus(currentVersion, versionsFromTags(tags, config.suffix));
  const auth = { username: config.username, password: config.password };

  let candidateDigest: string | null = null;
  let candidateTag: string | null = null;
  let migrateImagePresent: boolean | null = null;

  if (status.updateAvailable && status.latest) {
    migrateImagePresent = false;
    for (const tag of candidateTags(status.latest, config.suffix)) {
      const [app, migrate] = await Promise.all([
        deps.resolveDigest(config.repo, tag, auth),
        deps.resolveDigest(config.migrateRepo, tag, auth),
      ]);
      // BOTH at the SAME tag. A half-match pairs an app with a migration image
      // from a different release, which is how a schema gets corrupted.
      if (app && migrate) {
        candidateDigest = app;
        candidateTag = tag;
        migrateImagePresent = true;
        break;
      }
      if (app && !migrate) migrateImagePresent = false;
    }
  }

  const [dbReachable, currentHealthOk] = await Promise.all([
    deps.probeDb().catch(() => null),
    deps.probeHealth().catch(() => null),
  ]);

  const facts: PreflightFacts = {
    currentVersion,
    candidateVersion: status.updateAvailable ? status.latest : null,
    ahead: status.ahead,
    candidateDigest,
    migrateImagePresent,
    candidateRegistryHost: parseImageRef(config.repo).host,
    expectedRegistryHost: parseImageRef(config.repo).host,
    dbReachable,
    currentHealthOk,
    // Not observable from inside the application container — it has no host
    // mount. Left null on purpose so the preflight reports `unknown` rather
    // than a comfortable lie, and so `applyable` stays false for an in-app
    // check. The host-side actuator fills these in.
    hostDiskFreeBytes: null,
    estimatedRequiredBytes: null,
  };

  const preflights = status.updateAvailable ? evaluatePreflights(facts) : [];

  // Notes are best-effort and MUST NOT be able to fail the check. Knowing an
  // upgrade exists is the useful part; knowing what is in it is a bonus that
  // most registries will not carry until the publishing side has run.
  const { notes, omitted } = status.updateAvailable
    ? await deps.fetchReleaseNotes(status.newer, config.notesRepo, auth).catch(() => ({ notes: [], omitted: 0 }))
    : { notes: [], omitted: 0 };

  return {
    ...base,
    status,
    candidateDigest,
    candidateTag,
    preflights,
    notes,
    notesOmitted: omitted,
    applyable: preflights.length > 0 && canApply(preflights),
    error: null,
  };
}
