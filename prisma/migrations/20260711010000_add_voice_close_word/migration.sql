-- Voice dictation: per-user close word ("send it" default when NULL) that ends
-- a spoken assistant message and sends it.
ALTER TABLE "user_preferences" ADD COLUMN "voice_close_word" TEXT;
