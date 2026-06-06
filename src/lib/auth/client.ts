import { OAuth2Client } from "google-auth-library";

export const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI,
);

export const SESSION_MAX_AGE_SECONDS = Number(
  process.env.SESSION_MAX_AGE_SECONDS ?? 604800,
);

export const SESSION_COOKIE = "session";
export const OAUTH_STATE_COOKIE = "oauth_state";
