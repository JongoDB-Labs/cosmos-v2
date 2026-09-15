/**
 * Ordering and filtering for the "assign users" pickers (COSMOS-171).
 *
 * The member lists the API returns are in insertion order, which reads as random
 * once an org has more than a screenful of people — so finding someone meant
 * scrolling the whole list. These helpers give every assignee picker the same
 * two affordances: a stable alphabetical order, and a case-insensitive substring
 * search that matches the NAME shown in the row as well as the member's email
 * (people search for "ana@" as readily as for "Ana", and the email is often the
 * only thing that disambiguates two Anas).
 *
 * Pure on purpose — no React, no fetching — so the ordering and matching rules
 * are unit-testable and shared rather than re-implemented per picker.
 */

/** The shape every member list here has in common. `OrgMember` satisfies it. */
export interface PickableMember {
  userId: string;
  user?: { displayName?: string | null; email?: string | null } | null;
}

export interface MemberOption {
  /** The user id the pickers store as the assignee. */
  value: string;
  /** What the row displays — and the primary thing search matches. */
  label: string;
  /**
   * Everything search matches, joined. Kept separate from `label` so the email
   * is searchable WITHOUT being rendered into every row.
   */
  searchText: string;
}

/**
 * What a member is called in a picker: display name, else email, else the raw
 * id — the same fallback chain the assignee rows already rendered, so sorting
 * orders by the text the user can actually see.
 */
export function memberDisplayName(member: PickableMember): string {
  const name = member.user?.displayName?.trim();
  if (name) return name;
  const email = member.user?.email?.trim();
  if (email) return email;
  return member.userId;
}

/**
 * Picker options, sorted alphabetically (ascending, case-insensitive) by the
 * displayed name. Ties break on the user id so the order is total and stable —
 * two members called "Alex" must not swap places between renders.
 */
export function memberPickerOptions(
  members: readonly PickableMember[],
): MemberOption[] {
  return members
    .map((m) => {
      const label = memberDisplayName(m);
      const email = m.user?.email?.trim() ?? "";
      return {
        value: m.userId,
        label,
        // Email appended only when it isn't already the label, so a member
        // without a display name doesn't get it twice.
        searchText: email && email !== label ? `${label} ${email}` : label,
      };
    })
    .sort(
      (a, b) =>
        a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) ||
        a.value.localeCompare(b.value),
    );
}

/** Does this option match the typed query? Case-insensitive substring. */
export function matchesMemberQuery(
  option: Pick<MemberOption, "label" | "searchText">,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (option.searchText || option.label).toLowerCase().includes(q);
}

/** The options a query leaves visible, in the order `memberPickerOptions` gave. */
export function filterMemberOptions(
  options: readonly MemberOption[],
  query: string,
): MemberOption[] {
  const q = query.trim();
  if (!q) return [...options];
  return options.filter((o) => matchesMemberQuery(o, q));
}
