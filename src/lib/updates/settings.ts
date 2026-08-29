// Instance-wide update behaviour: does this deployment install a newer released
// version by itself, or report it and wait for someone to click Install?
//
// Core owns this even though the Foreman daemon is what acts on it — CI builds
// core with no plugins composed, so core cannot reference a plugin model, and an
// operator expects the page with the Install button to own whether installs
// happen unattended.
//
// NOTE ON THE DEFAULT. `true`. Everywhere else in this codebase an unreadable
// setting resolves to the option that does LESS. Not here: the failure this
// switch exists to expose is an instance that quietly stops updating — a real
// outage on 2026-08-28, where the app sat on an old release for hours while
// reporting success. An unattended install is visible and reversible; a silent
// freeze is neither. So a missing row, a DB blip, or a value nobody wrote all
// mean "keep updating", and turning updates OFF requires a deliberate write.
import { prisma } from "@/lib/db/client";

export const UPDATE_SETTINGS_SCOPE = "instance";

/** Default when nothing has been configured. See the header for why it is true. */
export const DEFAULT_AUTO_UPDATE = true;

export interface UpdateSettingsDto {
  autoUpdate: boolean;
  updatedAt: string | null;
}

/** Read the switch. THROWS on a DB failure — the caller decides what an
 *  unreadable setting means, and for the daemon that is "keep updating". */
export async function getUpdateSettings(): Promise<UpdateSettingsDto> {
  const row = await prisma.updateSettings.findUnique({
    where: { scope: UPDATE_SETTINGS_SCOPE },
    select: { autoUpdate: true, updatedAt: true },
  });
  return {
    autoUpdate: row?.autoUpdate ?? DEFAULT_AUTO_UPDATE,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

/** Set the switch. Upserts on the unique scope so concurrent writes converge on
 *  one row rather than racing to create a second the reader would ignore. */
export async function setUpdateSettings(
  autoUpdate: boolean,
  updatedById: string | null,
): Promise<UpdateSettingsDto> {
  const row = await prisma.updateSettings.upsert({
    where: { scope: UPDATE_SETTINGS_SCOPE },
    create: { scope: UPDATE_SETTINGS_SCOPE, autoUpdate, updatedById },
    update: { autoUpdate, updatedById },
    select: { autoUpdate: true, updatedAt: true },
  });
  return { autoUpdate: row.autoUpdate, updatedAt: row.updatedAt.toISOString() };
}

/** One line for the page and the daemon log. */
export function describeAutoUpdate(autoUpdate: boolean): string {
  return autoUpdate
    ? "Automatic — a newer version installs itself once its image is built."
    : "Manual — a newer version is reported here and waits for you to install it.";
}
