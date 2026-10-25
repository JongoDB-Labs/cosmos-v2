import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, success } from "@/lib/api-helpers";
import { requireSystemAdmin } from "@/lib/internal/require-system-admin";
import { getUpdateSettings, setUpdateSettings } from "@/lib/updates/settings";
import { describeReconcileHealth, getReconcileStatus } from "@/lib/updates/reconcile-status";
import { registrySettingsView, updateConfigFromEnv } from "@/lib/updates/check";
import {
  imageRepoProblem,
  layerRegistryEnv,
  readRegistryOverrides,
  registryHost,
  tagSuffixProblem,
  writeRegistryOverrides,
  type RegistryPatch,
} from "@/lib/updates/registry-settings";
import { listTags } from "@/lib/updates/registry";
import { versionsFromTags } from "@/lib/updates/versions";
import { openField } from "@/lib/crypto/field-seal";
import { prisma } from "@/lib/db/client";
import { eventBacklogHealth } from "@/lib/automation/backlog.server";
import { jobsReport } from "@/lib/jobs/report";

/**
 * The instance's update settings: the "install updates by yourself?" switch,
 * the registry the update check reads, and — read-only — what the host-side
 * installer last reported, whether the event worker is keeping up, and the
 * state of each background job.
 *
 * Same SYSTEM-admin gate as the sibling update routes: an image upgrade is
 * instance-wide, so "owner of any org" is the wrong tier — self-service org
 * creation mints OWNER, which would make this an escalation path.
 *
 * THIS ROUTE STORES CONFIGURATION. It does not deploy, and must not grow into
 * something that does. The sibling GET route is emphatic that the web tier has
 * no path to the host, and a PUT that could trigger an install would reopen
 * exactly that. All this writes is settings the host-side daemon reads on its
 * next pass.
 *
 * THE REGISTRY HERE IS SYSTEM-ADMIN CONFIGURATION, not ordinary request input.
 * This is the one place a registry host arrives in a request body, which is why
 * it sits behind the system-admin gate, is validated as a repository reference,
 * and is never paired with credentials that belong to a different host (see
 * probeRegistryChange). It changes what the update check and Foreman's poll
 * READ; what the host actually pulls stays pinned by the host's
 * docker-compose.override.yml.
 */
async function currentView() {
  const [settings, reconcile, overrides, eventBacklog] = await Promise.all([
    getUpdateSettings(),
    getReconcileStatus(),
    readRegistryOverrides(),
    eventBacklogHealth(prisma),
  ]);
  return {
    ...settings,
    reconcile,
    // Judged HERE rather than in the component: "has it gone quiet?" reads a
    // clock, which React forbids during render, and the server's clock is the
    // one the daemon's checkedAt was written against — no client skew.
    reconcileHealth: describeReconcileHealth(reconcile, settings.autoUpdate, new Date()),
    registry: registrySettingsView(process.env, overrides),
    // Is the outbox worker (webhooks, automations) keeping up? Counts and ages
    // only; the one place anyone without the logs or the database can tell.
    eventBacklog,
    // And the runner behind it: on or off here and why, and each job's last
    // run, success and failure (class and a redacted message). Read from this
    // process, so it describes the instance that answered.
    jobs: jobsReport(),
  };
}

export async function GET() {
  try {
    if (!(await requireSystemAdmin())) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return success(await currentView());
  } catch (error) {
    return handleApiError(error);
  }
}

const putSchema = z
  .object({
    autoUpdate: z.boolean().optional(),
    // For each text field: absent = leave alone, "" = clear the override and
    // fall back to the environment, anything else = set it.
    registry: z
      .object({
        imageRepo: z.string().max(300).optional(),
        tagSuffix: z.string().max(100).optional(),
        username: z.string().max(256).optional(),
        // Write-only. "" or absent = keep what is stored; clearPassword removes it.
        password: z.string().max(4096).optional(),
        clearPassword: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((b) => b.autoUpdate !== undefined || b.registry !== undefined, "Nothing to change.");

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

/** Only an explicit edit becomes a patch field; "" means "use the environment". */
function textPatch(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? null : t;
}

export async function PUT(request: NextRequest) {
  try {
    const user = await requireSystemAdmin();
    if (!user) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const parsed = putSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      // Paths and messages only — never the offending INPUT, which for this
      // route can be a registry password.
      return NextResponse.json(
        { error: "Invalid request", issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
        { status: 400 },
      );
    }
    const { autoUpdate, registry } = parsed.data;

    let patch: RegistryPatch | null = null;
    if (registry) {
      if (registry.clearPassword && registry.password) {
        return bad("Either enter a new password or remove the saved one, not both.");
      }
      patch = {
        imageRepo: textPatch(registry.imageRepo),
        tagSuffix: textPatch(registry.tagSuffix),
        username: textPatch(registry.username),
        password: registry.clearPassword ? null : registry.password ? registry.password : undefined,
      };
      if (patch.imageRepo) {
        const problem = imageRepoProblem(patch.imageRepo);
        if (problem) return bad(problem);
      }
      if (patch.tagSuffix) {
        const problem = tagSuffixProblem(patch.tagSuffix);
        if (problem) return bad(problem);
      }
      if (patch.username && /\s/.test(patch.username)) return bad("The username cannot contain spaces.");

      const refusal = await probeRegistryChange(patch);
      if (refusal) return bad(refusal);
    }

    // Probe first, write after — a refused registry change saves NOTHING,
    // including an autoUpdate flip sent alongside it.
    if (patch) await writeRegistryOverrides(patch, user.id ?? null);
    if (autoUpdate !== undefined) await setUpdateSettings(autoUpdate, user.id ?? null);

    return success(await currentView());
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Try the registry the instance WOULD use after this change, before saving it.
 * Null when it works (or when the change leaves update checking unconfigured);
 * otherwise a message for the operator.
 *
 * Never store a credential that cannot do the job — the same rule the Foreman
 * GitLab token connect follows. A registry setting that cannot list tags would
 * not fail loudly here; it would fail later, as "update status unknown" on this
 * page and a daemon quietly finding nothing to install.
 */
async function probeRegistryChange(patch: RegistryPatch): Promise<string | null> {
  const stored = await readRegistryOverrides();
  const next = {
    imageRepo: patch.imageRepo === undefined ? stored.imageRepo : patch.imageRepo,
    tagSuffix: patch.tagSuffix === undefined ? stored.tagSuffix : patch.tagSuffix,
    username: patch.username === undefined ? stored.username : patch.username,
    password:
      patch.password === undefined
        ? stored.passwordEnc
          ? openField(stored.passwordEnc)
          : null
        : patch.password,
  };

  // A saved password belongs to the host it was saved for. Moving the
  // repository to another host while silently keeping it would send that
  // registry's credential to whatever host was just typed in, so the operator
  // has to re-enter it (or remove it) as part of the move. Environment
  // credentials get the same protection inside layerRegistryEnv.
  if (patch.password === undefined && stored.passwordEnc) {
    const before = updateConfigFromEnv(layerRegistryEnv(process.env, { ...stored, password: null }).env);
    const after = updateConfigFromEnv(layerRegistryEnv(process.env, { ...next, password: null }).env);
    if (before && after && registryHost(before.repo) !== registryHost(after.repo)) {
      return `The saved password is for ${registryHost(before.repo)}. Enter the password for ${registryHost(after.repo)}, or remove the saved one.`;
    }
  }

  const config = updateConfigFromEnv(layerRegistryEnv(process.env, next).env);
  if (!config) return null; // nothing configured anywhere: checking is simply off

  let tags: string[];
  try {
    tags = await listTags(config.repo, { username: config.username, password: config.password });
  } catch (e) {
    // The registry client's messages never carry credentials or response bodies.
    const why = e instanceof Error ? e.message : "the registry did not answer";
    return `Could not list versions in ${config.repo} with these settings (${why}). Nothing was saved.`;
  }
  if (versionsFromTags(tags, config.suffix).length === 0) {
    return config.suffix
      ? `${config.repo} has no release tags ending in "-${config.suffix}" (or plain versions). Check the tag suffix. Nothing was saved.`
      : `${config.repo} has no release version tags. Nothing was saved.`;
  }
  return null;
}
