import { google } from "googleapis";
import { prisma } from "@/lib/db/client";

/**
 * Build an OAuth2 client preconfigured with the signed-in user's stored
 * refresh token. Throws when the user has no refresh token on file (i.e. they
 * signed in before workspace scopes were requested, or revoked access).
 */
export async function getGoogleClientForUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { googleRefreshToken: true },
  });
  if (!user?.googleRefreshToken) {
    throw new Error("Google not connected (no refresh token on user record)");
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
  oauth2Client.setCredentials({ refresh_token: user.googleRefreshToken });
  return oauth2Client;
}

export async function getCalendarClient(userId: string) {
  const auth = await getGoogleClientForUser(userId);
  return google.calendar({ version: "v3", auth });
}

export async function getDriveClient(userId: string) {
  const auth = await getGoogleClientForUser(userId);
  return google.drive({ version: "v3", auth });
}

export async function getGmailClient(userId: string) {
  const auth = await getGoogleClientForUser(userId);
  return google.gmail({ version: "v1", auth });
}

export async function getDocsClient(userId: string) {
  const auth = await getGoogleClientForUser(userId);
  return google.docs({ version: "v1", auth });
}

export async function getPeopleClient(userId: string) {
  const auth = await getGoogleClientForUser(userId);
  return google.people({ version: "v1", auth });
}

export async function getMeetClient(userId: string) {
  const auth = await getGoogleClientForUser(userId);
  return google.meet({ version: "v2", auth });
}
