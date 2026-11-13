/**
 * Confirm-class tools: the ones that delete something, grant, remove or change
 * access (a project or team membership, a role, a permission, sharing), close a
 * ceremony, or change many things at once.
 *
 * The agent loop never runs one on the model's word alone. A call without a
 * confirmation token gets a preview and a token back instead; the change is
 * made only when that token comes back after the USER has sent a new message
 * (see confirmation.ts). A caller with no way to ask the user (a chat bot)
 * is never offered one.
 *
 * This module is deliberately free of server imports so the chat bots' tool
 * filter and the arch test can use it without loading the executors.
 */

/** Names that are confirm-class by their shape. A new tool so named must be tagged `confirm: true`. */
const CONFIRM_CLASS_PREFIX = /^(bulk_|delete_|share_|grant_|revoke_)/;
/**
 * A change of access: adding, removing or changing someone's membership, role
 * or permissions (`add_project_member`, `remove_team_member`,
 * `set_project_member_role`, `update_work_role`). A prompt injection in
 * anything the assistant reads must not be able to grant access on the
 * model's word.
 */
const ACCESS_CHANGE = /^(add|remove|set|change|update|assign|unassign)_(?:\w+_)?(members?|roles?|permissions?|access)$/;
const CONFIRM_CLASS_EXACT: ReadonlySet<string> = new Set(["close_ceremony"]);

/** Does this NAME say the tool is confirm-class? The arch test holds every such tool to a `confirm: true` tag. */
export function nameIsConfirmClass(name: string): boolean {
  return CONFIRM_CLASS_PREFIX.test(name) || ACCESS_CHANGE.test(name) || CONFIRM_CLASS_EXACT.has(name);
}

/**
 * Is this tool confirm-class? The tag is the source of truth; the name rule is
 * a floor, so a plugin tool (which no core arch test sees) named `delete_…`
 * still gets the confirmation step.
 */
export function isConfirmClass(def: { name: string; confirm?: boolean }): boolean {
  return def.confirm === true || nameIsConfirmClass(def.name);
}

/** The argument a confirm-class tool takes the token in. Never passed on to the executor. */
export const CONFIRMATION_TOKEN_ARG = "confirmationToken";
