import { z } from "zod";
import { API_KEY_SCOPES } from "@/lib/auth/api-key-scopes";
import { IsoDateTime, NullableDateTime, Uuid } from "./common";
import * as E from "./enums.generated";

export const TokenInfo = z.object({
  orgId: Uuid.describe("The organization the token is bound to."),
  scopes: z.array(z.string()),
  kind: z.enum(E.ApiKeyKind),
  expiresAt: NullableDateTime,
}).meta({ id: "TokenInfo" });

export const Me = z.object({
  id: Uuid,
  email: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  createdAt: IsoDateTime,
  preferences: z.object({ bgDarkUrl: z.string().nullable(), bgLightUrl: z.string().nullable() }).nullable(),
  token: TokenInfo.optional().describe("Present when the request authenticated with a token."),
}).meta({ id: "Me" });

export const MyOrg = z.object({
  id: Uuid,
  name: z.string(),
  slug: z.string(),
  plan: z.enum(E.Plan),
  logoUrl: z.string().nullable(),
  role: z.enum(E.OrgRole).describe("Your role in it."),
  joinedAt: IsoDateTime,
}).meta({ id: "MyOrg" });

export const PersonalToken = z.object({
  id: Uuid,
  orgId: Uuid,
  name: z.string(),
  prefix: z.string().describe("Shown as `cosmos_<prefix>_…` so you can tell tokens apart."),
  scopes: z.array(z.enum(API_KEY_SCOPES)),
  projectIds: z.array(Uuid).describe("Projects it is limited to; empty means every project you can reach."),
  expiresAt: IsoDateTime,
  lastUsed: NullableDateTime,
  createdAt: IsoDateTime,
}).meta({ id: "PersonalToken" });

export const MintedToken = z.object({
  token: z.string().describe("The secret, shown this once. Send it as `Authorization: Bearer <token>`."),
  record: PersonalToken,
}).meta({ id: "MintedToken" });
