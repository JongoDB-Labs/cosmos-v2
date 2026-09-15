/**
 * Disposable demo access, for showing a stakeholder what just shipped.
 *
 *   npx tsx scripts/demo-pass.ts create --org <slug> --email <addr> [--role VIEWER] [--days 7] [--label "..."]
 *   npx tsx scripts/demo-pass.ts list   --org <slug>
 *   npx tsx scripts/demo-pass.ts revoke --org <slug> --email <addr>
 *
 * WHY THIS EXISTS: after each delivery somebody outside the build wants to click
 * around the real instance. Doing that by hand means remembering to pick a role
 * that cannot change anything, to set an expiry, and — the part actually
 * forgotten — to take the access away again afterwards. A pass nobody revokes is
 * not a demo account, it is a standing account that nobody owns.
 *
 * It reuses the product's own invitation path rather than writing users
 * directly: the temporary password is generated, hashed and EMAILED by the same
 * code that serves the Team screen. It is never printed here and never returned
 * to the caller, because a credential echoed into a terminal ends up in scroll
 * buffers, screen shares and CI logs.
 *
 * VIEWER by default. It can read projects and time but holds no finance
 * permission, so fee figures stay hidden while hours, pace and runway — which is
 * most of what a delivery demo is about — read normally.
 */
import { prisma } from "../src/lib/db/client";
import { provisionEmailPasswordInvite } from "../src/lib/auth/invite-credentials";
import { sendPasswordInviteEmail } from "../src/lib/integrations/invitation-email";
import { revokeProvisionedAccount } from "../src/lib/auth/revoke-invitation";
import { isTransactionalEmailConfigured } from "../src/lib/integrations/email-sender";
import { OrgRole } from "@prisma/client";

type Args = Record<string, string | undefined>;

function parseArgs(argv: string[]): { cmd: string; args: Args } {
  const [cmd = "", ...rest] = argv;
  const args: Args = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token?.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = "true";
      }
    }
  }
  return { cmd, args };
}

function die(message: string): never {
  console.error(`demo-pass: ${message}`);
  process.exit(1);
}

async function requireOrg(slug: string | undefined) {
  if (!slug) die("--org <slug> is required");
  const org = await prisma.organization.findUnique({
    where: { slug },
    select: { id: true, name: true, slug: true },
  });
  if (!org) die(`no organisation with slug "${slug}"`);
  return org;
}

/**
 * Who the invitation is recorded as coming from. An OWNER of the org, because
 * the invitation is a real grant and the audit trail should name a person who
 * could legitimately have made it rather than a script.
 */
async function inviter(orgId: string) {
  const member = await prisma.orgMember.findFirst({
    where: { orgId, role: OrgRole.OWNER },
    select: { userId: true },
  });
  if (!member) die("the organisation has no OWNER to attribute the invitation to");
  const user = await prisma.user.findUnique({
    where: { id: member.userId },
    select: { id: true, displayName: true },
  });
  if (!user) die("the organisation's OWNER has no user record");
  return user;
}

async function create(args: Args) {
  const org = await requireOrg(args.org);
  const email = args.email?.trim().toLowerCase();
  if (!email) die("--email <address> is required");

  const roleInput = (args.role ?? "VIEWER").toUpperCase();
  if (!(roleInput in OrgRole)) die(`--role must be one of ${Object.keys(OrgRole).join(", ")}`);
  const role = roleInput as OrgRole;

  const days = Number(args.days ?? 7);
  if (!Number.isFinite(days) || days <= 0 || days > 90) die("--days must be between 1 and 90");

  const existing = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });
  if (existing) {
    // Refused rather than handled. Provisioning a password onto somebody's real
    // account would hand whoever runs this their access everywhere, and a demo
    // is never worth that. Use an address that belongs to the demo.
    die(
      `${email} already has an account. Use a dedicated address for a disposable pass, ` +
        `or have them sign in with the account they already have.`,
    );
  }

  // PREFLIGHT, before anything is written. The credential is only ever delivered
  // by email, so an unsendable one leaves an account nobody can use and nobody
  // knows about. Checked here rather than discovered at the send, which happens
  // after the account exists.
  //
  // The usual cause is running this without the deployment's environment: the
  // org's own mail config is sealed, and without the key to unseal it the sender
  // silently falls back to the inviter's Gmail and fails with an error about
  // refresh tokens that says nothing about what actually went wrong.
  if (!(await isTransactionalEmailConfigured(org.id))) {
    die(
      "this organisation has no usable transactional email configuration.\n" +
        "         The org's key is SEALED, so reading it needs the vault key the\n" +
        "         deployment runs with — DATABASE_URL alone is not enough:\n" +
        "           SSO_VAULT_KEY (or SSO_VAULT_KEYS + SSO_VAULT_ACTIVE_KID)\n" +
        "         Without it this silently falls back to the inviter's Gmail and\n" +
        "         fails with an error about refresh tokens that explains nothing.\n" +
        "         Failing RESEND_API_KEY + EMAIL_FROM also work.",
    );
  }

  const from = await inviter(org.id);
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const origin = process.env.PUBLIC_ORIGIN ?? process.env.NEXTAUTH_URL ?? "";
  if (!origin) die("set PUBLIC_ORIGIN so the sign-in link in the email is correct");

  const { tempPassword } = await prisma.$transaction(async (tx) => {
    const provisioned = await provisionEmailPasswordInvite({ email, mfaRequired: false, client: tx });
    await tx.invitation.create({
      data: {
        orgId: org.id,
        email,
        role,
        signInMethod: "email_password",
        expiresAt,
      },
    });
    return provisioned;
  });

  await sendPasswordInviteEmail({
    fromUserId: from.id,
    orgId: org.id,
    toEmail: email,
    orgName: org.name,
    inviterName: from.displayName,
    loginUrl: `${origin}/login`,
    tempPassword,
    mfaRequired: false,
  });

  console.log(`created  ${email}  role=${role}  expires=${expiresAt.toISOString().slice(0, 10)}`);
  console.log(`         credentials emailed to ${email} — not printed here, by design`);
  console.log(`         revoke with: npx tsx scripts/demo-pass.ts revoke --org ${org.slug} --email ${email}`);
  if (args.label) console.log(`         label: ${args.label}`);
}

async function list(args: Args) {
  const org = await requireOrg(args.org);
  const invites = await prisma.invitation.findMany({
    where: { orgId: org.id, signInMethod: "email_password" },
    select: { email: true, role: true, expiresAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  if (invites.length === 0) {
    console.log("no outstanding email/password passes");
    return;
  }
  const now = Date.now();
  for (const i of invites) {
    const state = i.expiresAt.getTime() < now ? "EXPIRED" : "active ";
    console.log(
      `${state}  ${i.email.padEnd(34)} ${String(i.role).padEnd(8)} expires ${i.expiresAt
        .toISOString()
        .slice(0, 10)}`,
    );
  }
}

async function revoke(args: Args) {
  const org = await requireOrg(args.org);
  const email = args.email?.trim().toLowerCase();
  if (!email) die("--email <address> is required");

  const invitation = await prisma.invitation.findFirst({
    where: { orgId: org.id, email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });

  // The account is removed even when the invitation has already gone — that is
  // the whole point of a disposable pass, and an invitation consumed at sign-in
  // no longer exists to revoke.
  //
  // The nil UUID stands in for "no invitation of ours to exclude". It has to be
  // a well-formed UUID rather than an empty string: the helper feeds it to a
  // `not:` filter on a uuid column, and Postgres rejects "" outright — the
  // teardown would fail on exactly the passes that had already been used.
  const NO_INVITATION = "00000000-0000-0000-0000-000000000000";
  const outcome = await prisma.$transaction(async (tx) => {
    const result = await revokeProvisionedAccount(tx, {
      email,
      invitationId: invitation?.id ?? NO_INVITATION,
    });
    if (invitation) await tx.invitation.delete({ where: { id: invitation.id } });
    return result;
  });

  console.log(`revoked  ${email}`);
  console.log(`         invitation: ${invitation ? "deleted" : "none outstanding"}`);
  console.log(`         account:    ${outcome.deleted ? "removed" : `kept — ${outcome.reason}`}`);
}

async function main() {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case "create":
      await create(args);
      break;
    case "list":
      await list(args);
      break;
    case "revoke":
      await revoke(args);
      break;
    default:
      console.log(
        [
          "usage:",
          "  demo-pass create --org <slug> --email <addr> [--role VIEWER] [--days 7] [--label \"...\"]",
          "  demo-pass list   --org <slug>",
          "  demo-pass revoke --org <slug> --email <addr>",
        ].join("\n"),
      );
      process.exit(cmd ? 1 : 0);
  }
  await prisma.$disconnect();
}

void main().catch(async (error) => {
  console.error("demo-pass failed:", error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exit(1);
});
