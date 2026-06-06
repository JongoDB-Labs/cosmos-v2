-- AlterTable
ALTER TABLE "board_templates" ADD COLUMN     "board_type" TEXT NOT NULL DEFAULT 'KANBAN',
ADD COLUMN     "sort_order" INTEGER NOT NULL DEFAULT 0;
