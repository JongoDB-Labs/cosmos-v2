-- NOTE: changing these money columns from double precision to numeric(19,4) performs a
-- full table rewrite under an ACCESS EXCLUSIVE lock. Tables are small; apply only in the
-- coordinated low-traffic deploy window (see the Step 0 plan, Task 9 — migration + code
-- deploy together, since this type change is not backward-compatible with the old server).

-- AlterTable
ALTER TABLE "crm_contacts" ALTER COLUMN "deal_value" SET DATA TYPE DECIMAL(19,4);

-- AlterTable
ALTER TABLE "products" ALTER COLUMN "price" SET DATA TYPE DECIMAL(19,4);

-- AlterTable
ALTER TABLE "contracts" ALTER COLUMN "value" SET DATA TYPE DECIMAL(19,4);

-- AlterTable
ALTER TABLE "time_entries" ALTER COLUMN "rate" SET DATA TYPE DECIMAL(19,4);

-- AlterTable
ALTER TABLE "revenues" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(19,4);

-- AlterTable
ALTER TABLE "expenses" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(19,4);

