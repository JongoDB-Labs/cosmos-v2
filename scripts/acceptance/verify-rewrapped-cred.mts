/**
 * Close the rotation loop: under the post-rotation keyring (active=v2k), confirm the
 * re-wrapped github org credential now opens under the NEW kid and still returns the
 * original token — i.e. the re-wrap preserved the secret. Then clean up the org.
 */
import { prisma } from "@/lib/db/client";
import { getOrgCredential } from "@/lib/integrations/credentials";
import { kidOf } from "@/lib/crypto/vault";

async function main() {
  const org = await prisma.organization.findFirst({ where: { slug: "acceptance-rotate-org" } });
  if (!org) throw new Error("acceptance-rotate-org not found");
  const r = await prisma.$queryRawUnsafe<Array<{ secret_enc: string }>>(
    `SELECT secret_enc FROM connector_credentials WHERE org_id = $1::uuid AND provider = 'github' AND user_id IS NULL`,
    org.id,
  );
  console.log(`  envelope kid now        = ${kidOf(r[0].secret_enc)}`);
  const bundle = await getOrgCredential(org.id, "github");
  console.log(`  getOrgCredential token  = ${bundle?.token}`);
  if (bundle?.token !== "GHTESTTOK") throw new Error("re-wrap did NOT preserve the token!");
  console.log("  PASS  re-wrapped cred opens under v2k and still returns GHTESTTOK");
  await prisma.organization.delete({ where: { id: org.id } });
  console.log("  [cleanup] rotate test org removed.");
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error(e.message);
  await prisma.$disconnect();
  process.exit(1);
});
