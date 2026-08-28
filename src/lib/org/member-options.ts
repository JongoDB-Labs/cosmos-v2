/**
 * Options for the "assign users" pickers, in the order people expect to read
 * them: alphabetical by the name that is actually displayed.
 *
 * COSMOS-171 — the member lists come straight from
 * `GET /orgs/:orgId/members`, which orders by `joinedAt`. That is join order,
 * which nobody can predict or scan, so as an org grows finding a person means
 * reading the whole list. Sorting here (rather than changing the API's order)
 * keeps the change to the pickers: other consumers of that route — the member
 * admin table, workload widgets — keep the ordering they were built against.
 *
 * The comparison is case-insensitive and accent-insensitive (`sensitivity:
 * "base"`), so "ada" and "Ada" sort together instead of the ALL-CAPS names
 * clustering ahead of everyone else the way a raw `<` comparison would put them.
 * Ties break on the id so the order is total — equal labels never swap between
 * renders.
 */

/** The member shape these pickers hold — a `userId` plus the optional `user`
 *  relation the members route includes. Structural, so both `OrgMember` and the
 *  narrower rows other callers hold satisfy it. */
export interface MemberLike {
  userId: string;
  user?: { displayName?: string | null; email?: string | null } | null;
}

export interface MemberOption {
  value: string;
  label: string;
}

/**
 * What to show for a member: their display name, else their email, else
 * "Unknown" — never a raw uuid, which is not a name and cannot be searched for.
 */
export function memberLabel(member: MemberLike): string {
  return (
    member.user?.displayName?.trim() || member.user?.email?.trim() || "Unknown"
  );
}

/** `{ value, label }` options — the shape <SearchableSelect> /
 *  <SearchableMultiSelect> infer their filter text from — sorted by label. */
export function memberOptions(members: readonly MemberLike[]): MemberOption[] {
  return members
    .map((m) => ({ value: m.userId, label: memberLabel(m) }))
    .sort(
      (a, b) =>
        a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) ||
        a.value.localeCompare(b.value),
    );
}
