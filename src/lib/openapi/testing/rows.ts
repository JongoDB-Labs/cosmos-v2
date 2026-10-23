/**
 * Whole rows, as Prisma returns them, for tests of routes that answer through
 * a response contract. A hand-built partial row is (correctly) a contract
 * violation there, so tests start from these and override what they assert on.
 */
export function projectRow<T extends Record<string, unknown>>(over: T & { id: string; orgId: string }) {
  return {
    name: "Project", key: "PRJ", description: null, settings: {}, status: "ACTIVE", archived: false,
    projectTemplateId: null, enabledFeatures: [], teamScopedAccess: false, clientId: null,
    externalRef: null, krLinkTypeId: null, objectiveLinkTypeId: null,
    createdAt: new Date("2026-10-01T00:00:00Z"), updatedAt: new Date("2026-10-01T00:00:00Z"),
    _count: { boards: 1, intervals: 0, members: 1 },
    ...over,
  };
}
