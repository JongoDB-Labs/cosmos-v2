/**
 * Plan a bulk "add tag" write for a cross-page Issues selection.
 *
 * The Issues table is server-paginated, so a "select all N matching" selection
 * (BR f6b52435) spans ids that aren't on the currently rendered page. Unlike the
 * other bulk ops (assign / priority / delete), appending a tag needs each item's
 * EXISTING tags, because the bulk PUT replaces the whole `tags` array rather than
 * appending. This resolver draws those tags from two sources so the write covers
 * every selected item, not just the visible page:
 *
 *   - `currentPage` — the rows in view, carrying the freshest tag sets.
 *   - `offPage`     — the snapshot captured when the user chose "select all
 *                     matching"; used for ids that aren't on the current page.
 *
 * Items that already carry the tag are skipped. The rest are bucketed by
 * (project, current tag-set) so each group's resulting `tags` array is computed
 * once and the fan-out issues one bulk PUT per group.
 */

export interface TagRowInfo {
  projectId: string;
  tags: string[];
}

export interface TagBulkGroup {
  projectId: string;
  ids: string[];
  /** The full tags array to write (existing tags + the new one). */
  tags: string[];
}

export function planTagAddition(
  selectedIds: string[],
  currentPage: ReadonlyMap<string, TagRowInfo>,
  offPage: ReadonlyMap<string, TagRowInfo> | null | undefined,
  rawTag: string,
): TagBulkGroup[] {
  const tag = rawTag.trim();
  if (!tag) return [];

  const groups = new Map<string, TagBulkGroup>();
  for (const id of selectedIds) {
    // Prefer the in-view row (freshest tags); fall back to the select-all snapshot.
    const info = currentPage.get(id) ?? offPage?.get(id);
    if (!info || info.tags.includes(tag)) continue;
    const key = `${info.projectId}::${[...info.tags].sort().join(",")}`;
    const g = groups.get(key);
    if (g) g.ids.push(id);
    else groups.set(key, { projectId: info.projectId, ids: [id], tags: [...info.tags, tag] });
  }
  return [...groups.values()];
}
