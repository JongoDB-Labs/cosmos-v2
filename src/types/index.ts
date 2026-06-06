export interface SessionUser {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  plan: string;
  logoUrl: string | null;
  role: string;
}

export interface ApiError {
  error: string;
}
