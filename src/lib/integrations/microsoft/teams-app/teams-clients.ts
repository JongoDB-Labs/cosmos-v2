/**
 * COSMOS-202 T1 d: the client apps a Teams tab's sign-in token may come from:
 * Microsoft Teams itself, desktop and mobile, and web. Pure, so the setup card
 * shows the same list the server enforces.
 */
export const TEAMS_CLIENT_IDS = [
  "1fec8e78-bce4-4aaf-ab1b-5451cc387264", // Teams desktop and mobile
  "5e3ce6c0-2b1f-4285-8d4b-75ee78787346", // Teams web
] as const;
