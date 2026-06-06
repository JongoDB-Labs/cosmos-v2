export function isInternalAdmin(
  email: string,
  envValue: string | undefined,
): boolean {
  if (!envValue) return false;
  const allowed = envValue
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.toLowerCase());
}
