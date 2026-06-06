export type VideoProvider = "GOOGLE_MEET" | "ZOOM" | "TEAMS" | "OTHER";

export function detectVideoProvider(url: string): VideoProvider {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "OTHER";
  }
  if (host === "meet.google.com" || host.endsWith(".meet.google.com")) return "GOOGLE_MEET";
  if (host === "zoom.us" || host.endsWith(".zoom.us")) return "ZOOM";
  if (
    host === "teams.microsoft.com" ||
    host.endsWith(".teams.microsoft.com") ||
    host === "teams.live.com" ||
    host.endsWith(".teams.live.com")
  )
    return "TEAMS";
  return "OTHER";
}
