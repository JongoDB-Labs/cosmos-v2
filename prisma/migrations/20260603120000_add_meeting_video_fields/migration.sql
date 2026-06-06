-- AlterTable
ALTER TABLE "sync_meetings" ADD COLUMN     "artifacts" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "meet_conference_name" TEXT,
ADD COLUMN     "meet_space_name" TEXT,
ADD COLUMN     "meeting_url" TEXT,
ADD COLUMN     "video_provider" TEXT;
