-- What the practice owes: the mirror of `invoices`, plus the project a cost
-- belongs to and the client invoice it is recovered through.
CREATE TYPE "BillStatus" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'VOID');
CREATE TYPE "BillTerms" AS ENUM ('DUE_DATE', 'PAY_WHEN_PAID');

CREATE TABLE "bills" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id"        UUID NOT NULL,
    "reference"     TEXT NOT NULL,
    "vendor_name"   TEXT NOT NULL,
    "partner_id"    UUID,
    "project_id"    UUID,
    "invoice_id"    UUID,
    "status"        "BillStatus" NOT NULL DEFAULT 'DRAFT',
    "terms"         "BillTerms"  NOT NULL DEFAULT 'DUE_DATE',
    "issue_date"    DATE,
    "due_date"      DATE,
    "paid_date"     DATE,
    "currency"      TEXT NOT NULL DEFAULT 'USD',
    "amount"        DECIMAL(19,4) NOT NULL,
    "amount_paid"   DECIMAL(19,4) NOT NULL DEFAULT 0,
    "notes"         TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "bills_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bills_org_id_status_idx"     ON "bills"("org_id", "status");
CREATE INDEX "bills_org_id_due_date_idx"   ON "bills"("org_id", "due_date");
CREATE INDEX "bills_org_id_project_id_idx" ON "bills"("org_id", "project_id");
CREATE INDEX "bills_org_id_partner_id_idx" ON "bills"("org_id", "partner_id");
CREATE INDEX "bills_org_id_invoice_id_idx" ON "bills"("org_id", "invoice_id");

ALTER TABLE "bills" ADD CONSTRAINT "bills_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bills" ADD CONSTRAINT "bills_partner_id_fkey"
  FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bills" ADD CONSTRAINT "bills_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bills" ADD CONSTRAINT "bills_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
