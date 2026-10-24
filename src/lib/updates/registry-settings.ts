// Registry settings an admin can see and change on /admin/updates.
//
// WHY THIS EXISTS. The registry used to be environment-only. When it moved
// hosts, the app and the host-side daemon could each be reading a different
// value, and nothing on the page said which one either was using or let an
// operator fix it. These columns (on the UpdateSettings singleton) let a SYSTEM
// admin override the environment from the page, and the page says, per field,
// whether a value came from settings, the environment, or a default.
//
// WHAT IT DOES NOT CHANGE. These values steer version DISCOVERY — this page and
// Foreman's poll. What the host actually pulls and deploys is still pinned by
// the host's docker-compose.override.yml: the deploy script derives its
// repositories from that file, not from here.
//
// SECURITY. The registry is CONFIGURATION set by a system admin, never taken
// from ordinary request input (see updateConfigFromEnv in ./check for the SSRF
// reasoning). The password is sealed with the vault keyring and is never
// returned, logged or put in an error message.
import { prisma } from "@/lib/db/client";
import { sealField } from "@/lib/crypto/field-seal";
import { parseImageRef } from "./registry";
import { UPDATE_SETTINGS_SCOPE } from "./settings";

/** The env keys a settings value stands in for. */
export const REGISTRY_ENV = {
  imageRepo: "COSMOS_UPDATE_IMAGE_REPO",
  tagSuffix: "COSMOS_UPDATE_TAG_SUFFIX",
  username: "COSMOS_UPDATE_REGISTRY_USERNAME",
  password: "COSMOS_UPDATE_REGISTRY_PASSWORD",
} as const;

/**
 * What the settings row holds. Every field is null unless an admin set it, and
 * null means "use the environment". The password stays SEALED here; only
 * resolveUpdateConfig opens it, at the moment it is needed.
 */
export interface RegistryOverrides {
  imageRepo: string | null;
  tagSuffix: string | null;
  username: string | null;
  passwordEnc: string | null;
}

export const NO_OVERRIDES: RegistryOverrides = {
  imageRepo: null,
  tagSuffix: null,
  username: null,
  passwordEnc: null,
};

/** Read the overrides. THROWS on a DB failure — the caller decides what that
 *  means (resolveUpdateConfig falls back to the environment). */
export async function readRegistryOverrides(): Promise<RegistryOverrides> {
  const row = await prisma.updateSettings.findUnique({
    where: { scope: UPDATE_SETTINGS_SCOPE },
    select: { imageRepo: true, tagSuffix: true, registryUsername: true, registryPasswordEnc: true },
  });
  if (!row) return NO_OVERRIDES;
  return {
    imageRepo: row.imageRepo || null,
    tagSuffix: row.tagSuffix || null,
    username: row.registryUsername || null,
    passwordEnc: row.registryPasswordEnc || null,
  };
}

/**
 * A change to the overrides. `undefined` leaves a field alone; `null` clears it
 * (back to the environment). The password arrives in PLAINTEXT and is sealed
 * here, so no caller ever holds a sealed value it might mistake for a password.
 */
export interface RegistryPatch {
  imageRepo?: string | null;
  tagSuffix?: string | null;
  username?: string | null;
  password?: string | null;
}

export async function writeRegistryOverrides(patch: RegistryPatch, updatedById: string | null): Promise<void> {
  const data: {
    imageRepo?: string | null;
    tagSuffix?: string | null;
    registryUsername?: string | null;
    registryPasswordEnc?: string | null;
    updatedById: string | null;
  } = { updatedById };
  if (patch.imageRepo !== undefined) data.imageRepo = patch.imageRepo;
  if (patch.tagSuffix !== undefined) data.tagSuffix = patch.tagSuffix;
  if (patch.username !== undefined) data.registryUsername = patch.username;
  if (patch.password !== undefined) {
    data.registryPasswordEnc = patch.password === null ? null : sealField(patch.password);
  }
  await prisma.updateSettings.upsert({
    where: { scope: UPDATE_SETTINGS_SCOPE },
    create: { scope: UPDATE_SETTINGS_SCOPE, ...data },
    update: data,
    select: { id: true },
  });
}

export type ValueSource = "settings" | "env" | "default" | "unset";

/**
 * The environment with the overrides laid over it — the input
 * updateConfigFromEnv derives everything else from. Pure.
 *
 * `password` is the OPENED password (or any non-empty marker when only its
 * presence matters, as for provenance); null means none stored.
 *
 * CREDENTIALS GO ONLY TO THE HOST THEY BELONG TO. When settings move the image
 * repository to a DIFFERENT registry host than the environment's, the
 * environment's username/password belong to the old host and are NOT carried
 * across — otherwise changing one field on this page would send the old
 * registry's deploy token to whatever host was typed in. Settings credentials,
 * when present, are used as-is (the settings route refuses a host change that
 * would silently keep them; see its PUT).
 *
 * The same host rule covers the COMPANION repositories (migrate, notes,
 * sidecars) — see moveCompanionRepos. On the same host nothing is rewritten;
 * the tag suffix is host-independent and keeps env precedence either way.
 */
export function layerRegistryEnv(
  env: Record<string, string | undefined>,
  o: { imageRepo: string | null; tagSuffix: string | null; username: string | null; password: string | null },
): {
  env: Record<string, string | undefined>;
  sources: Record<keyof typeof REGISTRY_ENV, ValueSource>;
} {
  const out: Record<string, string | undefined> = { ...env };
  const envRepo = env[REGISTRY_ENV.imageRepo]?.trim() || null;
  const has = (k: keyof typeof REGISTRY_ENV) => (env[REGISTRY_ENV[k]]?.trim() ?? "") !== "";

  const sources: Record<keyof typeof REGISTRY_ENV, ValueSource> = {
    imageRepo: has("imageRepo") ? "env" : "unset",
    // An env suffix of "" is a real choice (the neutral core), so presence, not
    // non-emptiness, decides that it came from the environment.
    tagSuffix: env[REGISTRY_ENV.tagSuffix] !== undefined ? "env" : "unset",
    username: has("username") ? "env" : "unset",
    password: has("password") ? "env" : "unset",
  };

  if (o.imageRepo) {
    out[REGISTRY_ENV.imageRepo] = o.imageRepo;
    sources.imageRepo = "settings";
    const oldHost = envRepo ? registryHost(envRepo) : null;
    const newHost = registryHost(o.imageRepo);
    if (envRepo && oldHost !== newHost) {
      delete out[REGISTRY_ENV.username];
      delete out[REGISTRY_ENV.password];
      sources.username = "unset";
      sources.password = "unset";
      if (oldHost && newHost) moveCompanionRepos(out, oldHost, newHost);
    }
  }
  if (o.tagSuffix) {
    out[REGISTRY_ENV.tagSuffix] = o.tagSuffix;
    sources.tagSuffix = "settings";
  }
  if (o.username) {
    out[REGISTRY_ENV.username] = o.username;
    sources.username = "settings";
  }
  if (o.password) {
    out[REGISTRY_ENV.password] = o.password;
    sources.password = "settings";
  }
  // No explicit suffix anywhere but a repository to derive one from.
  if (sources.tagSuffix === "unset" && out[REGISTRY_ENV.imageRepo]?.trim()) sources.tagSuffix = "default";
  return { env: out, sources };
}

/** Env keys naming repositories that travel WITH the image repository. */
export const COMPANION_REPO_ENV = {
  migrateRepo: "COSMOS_UPDATE_MIGRATE_REPO",
  notesRepo: "COSMOS_UPDATE_NOTES_REPO",
  sidecarRepos: "COSMOS_UPDATE_SIDECAR_REPOS",
} as const;

/**
 * A registry MOVE made from the page: the saved image repository is on a
 * different host than the environment's. The environment typically still
 * names the old host for everything, so an explicit env migrate/notes/sidecar
 * repository on that old host is stale — honouring it would look for the
 * paired migration image on a dead registry and every update would read as
 * not applyable.
 *
 * Only entries on the OLD host are touched; one on a third host (e.g. a public
 * notes repository) was chosen deliberately and is kept. Mutates `out`.
 *
 *  - migrate / notes: the env value is DROPPED, so updateConfigFromEnv derives
 *    them from the saved repository (`<repo>-migrate`, `<repo>`).
 *  - sidecars: RE-HOSTED onto the new host with the same path, not dropped.
 *    Dropping would shrink the sidecar list and silently skip the "sidecar
 *    images present" preflight — an app could be offered without the service
 *    it ships with. A re-hosted repository that does not exist on the new
 *    host fails that preflight instead, which blocks the install: fail
 *    closed, and the operator sees which sidecar is missing.
 */
function moveCompanionRepos(out: Record<string, string | undefined>, oldHost: string, newHost: string) {
  for (const key of [COMPANION_REPO_ENV.migrateRepo, COMPANION_REPO_ENV.notesRepo]) {
    const v = out[key]?.trim();
    if (v && registryHost(v) === oldHost) delete out[key];
  }
  const sidecars = out[COMPANION_REPO_ENV.sidecarRepos];
  if (sidecars) {
    out[COMPANION_REPO_ENV.sidecarRepos] = sidecars
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => (registryHost(r) === oldHost ? `${newHost}/${parseImageRef(r).name}` : r))
      .join(",");
  }
}

/** Registry host of a repository reference, or null if it does not parse. */
export function registryHost(repo: string): string | null {
  try {
    return parseImageRef(repo).host;
  } catch {
    return null;
  }
}

// Docker's reference grammar, narrowed to what a deployment's update repository
// actually is: an explicit registry host (a dot or a port — never a bare Docker
// Hub shorthand, which would quietly point at a public registry), then lowercase
// path components. No scheme, no tag, no digest, no whitespace.
const HOST_RE = /^(?=[^/]*[.:])[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::\d{1,5})?$/;
const PATH_COMPONENT_RE = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/;

/** Null when `repo` is a usable repository reference, else why it is not. */
export function imageRepoProblem(repo: string): string | null {
  if (repo.length > 255) return "The image repository is too long.";
  if (/\s/.test(repo)) return "The image repository cannot contain spaces.";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(repo)) {
    return "Enter the repository without a scheme — for example registry.example.com/cosmos/app, not https://…";
  }
  if (repo.includes("@")) return "Enter the repository without a digest.";
  const [host, ...path] = repo.split("/");
  if (!HOST_RE.test(host)) {
    return "Start with the registry host, including a dot or a port — for example registry.example.com/cosmos/app.";
  }
  if (path.length === 0) return "Add the repository path after the registry host.";
  for (const c of path) {
    if (c.includes(":")) return "Enter the repository without a tag — the version is chosen for you.";
    if (!PATH_COMPONENT_RE.test(c)) {
      return "Repository path segments may use only lowercase letters, digits, and . _ - separators.";
    }
  }
  // Same parser the registry client uses, so what is accepted here is what is used.
  try {
    parseImageRef(repo);
  } catch {
    return "That is not a repository reference.";
  }
  return null;
}

const TAG_SUFFIX_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function tagSuffixProblem(suffix: string): string | null {
  return TAG_SUFFIX_RE.test(suffix)
    ? null
    : "The tag suffix may use letters, digits, and . _ - (and must start with a letter or digit).";
}
