export function projectKeyFromRoute(route: string | undefined): string | null {
  if (route === undefined) {
    return null;
  }

  const match = route.match(/\/projects\/([^/?#]+)/);
  return match ? match[1] : null;
}
