/**
 * Acceptance helper: seal ONE github org-level credential (under whatever vault
 * active kid the env provides) so the rotation proof has a connector_credentials
 * row to re-wrap. Prints the org id + the sealed envelope's kid.
 */
import { prisma } from "@/lib/db/client";
import { setOrgCredential } from "@/lib/integrations/credentials";
import { kidOf } from "@/lib/crypto/vault";

async function main() {
  const slug = "acceptance-rotate-org";
  await prisma.organization.deleteMany({ where: { slug } });
  const org = await prisma.organization.create({
    data: { name: "Acceptance Rotate Org", slug, tenantClass: "GOV" },
  });
  await setOrgCredential(org.id, "github", { token: "GHTESTTOK" });
  const row = await prisma.$queryRawUnsafe<Array<{ secret_enc: string }>>(
    `SELECT secret_enc FROM connector_credentials WHERE org_id = $1::uuid AND provider = 'github' AND user_id IS NULL`,
    org.id,
  );
  console.log(`SEEDED org=${org.id} github org-cred sealed under kid=${kidOf(row[0].secret_enc)}`);
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error(e.message);
  await prisma.$disconnect();
  process.exit(1);
});
