-- Session ids are stored hashed. The sign-in cookie keeps its random token;
-- a Session row's id becomes sha256(token) as lowercase hex, which the app
-- computes in src/lib/auth/session-id.ts (sessionRowId). A session record's
-- session_token holds the same row id. Rows signed in before this are hashed
-- in place, so they keep working with the cookies already issued, and no raw
-- token is left in either table: a read-only fallback would have kept them
-- at rest until they expired.
--
-- convert_to(..., 'UTF8') hashes the text's bytes, as Node's
-- createHash().update(text, "utf8") does. A cast to bytea would read the text
-- as bytea input instead, which fails on a backslash and decodes "\x..".
--
-- ONE statement, so it is one transaction however Prisma submits it: either
-- both tables are hashed or neither is (see the 20261110200000 header).
-- Nothing references sessions.id by foreign key.
DO $$
BEGIN
  UPDATE "sessions" SET "id" = encode(sha256(convert_to("id", 'UTF8')), 'hex');
  UPDATE "session_records" SET "session_token" = encode(sha256(convert_to("session_token", 'UTF8')), 'hex');
END $$;
