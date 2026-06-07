# Classification Phase 4 — Classified Chat Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Files shared in chat inherit their channel's effective classification, shown as a chip on the attachment tile.

**Architecture:** `ChatMessageAttachment` gains a `classificationLevel`. Uploads are channel-agnostic orphans, so classification is applied **at message-send time** in `createUserMessage` (the single chokepoint that links orphan attachments to a message in a known channel): it resolves `effectiveClassification(orgId, channel.projectId)` and stamps the linked attachments. The attachment tile renders a `ClassificationChip` for classified files (≥ FOUO).

**Tech Stack:** Prisma 6, Next.js, React (client `attachment-tile`), Vitest + @testing-library/react.

---

## ⚠️ Spec deviation (read first)

Spec §6 Phase 4 says "On upload … resolve the channel's project ceiling … reject above the ceiling." That is **not implementable as written**: the upload route (`chat/attachments/route.ts`) creates the attachment as an **orphan** (`messageId: null`) with **no channel context**, and the `Composer` only has `orgId`/`channelLabel` (no `channelId`). This plan instead applies classification **at send time** via `createUserMessage`, where the channel (and thus its `projectId` and ceiling) is known. Effect is the same — a file posted to a CUI channel is marked CUI — and "reject above ceiling" is moot because attachments *inherit* the ceiling (no user-supplied level to exceed it). A future reclassify endpoint (deferred) is where a cap check would live. **The spec's P4 bullet will be updated to reflect this.**

## Conventions for the executor (read first)

- Working dir is the worktree `/home/defcon/cosmos-saas/.claude/worktrees/classification-propagation` (branch `worktree-classification-propagation`, on `origin/main` @ v3.40.0). `.env.local` is symlinked here.
- Prisma CLI needs env: prefix DB commands with `set -a && . ./.env.local && set +a`.
- Vitest: `npm test` = `vitest run`; single file `npx vitest run <path>`. Client component tests use `@testing-library/react` (jsdom default).
- **Client-bundle rule:** client files (`attachment-tile.tsx`, `use-chat-messages.ts`) import only `@/lib/classification/rank` (+ `ClassificationChip`) and `ClassificationLevel` as `import type`. Never the barrel or `effective.ts`.
- Commit after each task with the given message. Stage only listed files; never `git add -A` (unrelated WIP / the `.env.local` symlink exist — though the symlink is gitignored).
- Version bump only at the end (Task 5).

## File structure

| File | Change |
|---|---|
| `prisma/schema.prisma` | + `classificationLevel` on `ChatMessageAttachment` |
| `prisma/migrations/<ts>_add_attachment_classification/migration.sql` | ADD COLUMN |
| `src/lib/chat/messages.ts` | classify attachments on send; add field to the post-send select |
| `src/app/api/v1/orgs/[orgId]/chat/channels/[channelId]/messages/route.ts` | + `classificationLevel` in history attachment select |
| `src/app/api/v1/orgs/[orgId]/chat/channels/[channelId]/messages/[messageId]/replies/route.ts` | + `classificationLevel` in replies attachment select |
| `src/hooks/use-chat-messages.ts` | + `classificationLevel` on `ChatMessageAttachmentDto` |
| `src/components/chat/attachment-tile.tsx` | render `ClassificationChip` (≥ FOUO) |
| `src/components/chat/attachment-tile.test.tsx` | component test (create) |
| `package.json` | bump to 3.41.0 |

---

## Task 1: Schema — classificationLevel on ChatMessageAttachment + migration

**Files:** `prisma/schema.prisma`; new migration dir.

- [ ] **Step 1: Add the field**

In `model ChatMessageAttachment`, add after the `height Int?` line:
```prisma
  classificationLevel ClassificationLevel @default(UNCLASSIFIED) @map("classification_level")
```

- [ ] **Step 2: Validate**

Run: `set -a && . ./.env.local && set +a && npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀`.

- [ ] **Step 3: Create + apply the migration**

Run: `set -a && . ./.env.local && set +a && npx prisma migrate dev --name add_attachment_classification`
Expected: a new migration folder is created + applied; "Your database is now in sync."

**If `migrate dev` threatens to RESET the database** (pre-existing migration-drift can trigger this — the chat `content_tsv` column is managed outside Prisma), do NOT reset. Instead apply surgically:
```bash
set -a && . ./.env.local && set +a
TS=$(date -u +%Y%m%d%H%M%S)
mkdir -p "prisma/migrations/${TS}_add_attachment_classification"
printf '%s\n' '-- AddColumn' 'ALTER TABLE "chat_message_attachments" ADD COLUMN "classification_level" "ClassificationLevel" NOT NULL DEFAULT '"'"'UNCLASSIFIED'"'"';' > "prisma/migrations/${TS}_add_attachment_classification/migration.sql"
npx prisma db execute --schema prisma/schema.prisma --file "prisma/migrations/${TS}_add_attachment_classification/migration.sql"
npx prisma migrate resolve --applied "${TS}_add_attachment_classification"
npx prisma generate
```

- [ ] **Step 4: Confirm client + DB**

Run: `set -a && . ./.env.local && set +a && npx prisma migrate status 2>&1 | tail -3`
Expected: "Database schema is up to date!"

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(classification): add classificationLevel to chat attachments"
```

---

## Task 2: Classify attachments on send (`createUserMessage`)

**Files:** `src/lib/chat/messages.ts`

- [ ] **Step 1: Add the import**

After the existing `import { topics } from "@/lib/realtime/topics";` line, add:
```ts
import { effectiveClassification } from "@/lib/classification/effective";
```

- [ ] **Step 2: Resolve the channel's effective classification before the transaction**

In `createUserMessage`, immediately after the line `const validMentions = mentionedInOrg.map((m) => m.userId);`, add:
```ts
  // Attachments inherit the classification of the channel they're posted to.
  const attachmentClass =
    input.attachmentIds && input.attachmentIds.length > 0
      ? await effectiveClassification(
          orgId,
          (
            await prisma.chatChannel.findUnique({
              where: { id: channel.id },
              select: { projectId: true },
            })
          )?.projectId ?? null,
        )
      : null;
```

- [ ] **Step 3: Stamp the level when linking attachments**

Replace the existing attachment-linking block:
```ts
    if (input.attachmentIds && input.attachmentIds.length > 0) {
      await tx.chatMessageAttachment.updateMany({
        where: { id: { in: input.attachmentIds }, uploadedById: input.authorId, messageId: null },
        data: { messageId: m.id },
      });
    }
```
with:
```ts
    if (input.attachmentIds && input.attachmentIds.length > 0) {
      await tx.chatMessageAttachment.updateMany({
        where: { id: { in: input.attachmentIds }, uploadedById: input.authorId, messageId: null },
        data: {
          messageId: m.id,
          ...(attachmentClass ? { classificationLevel: attachmentClass.level } : {}),
        },
      });
    }
```

- [ ] **Step 4: Carry the field into the post-send select**

In the `prisma.chatMessageAttachment.findMany` select (the `select: { id: true, kind: true, ... height: true }` line), add `classificationLevel: true`:
```ts
          select: { id: true, kind: true, url: true, filename: true, contentType: true, size: true, width: true, height: true, classificationLevel: true },
```

- [ ] **Step 5: Verify types**

Run: `npx tsc --noEmit`
Expected: no errors. (If the bus payload's `attachments` type complains, it resolves once Task 4 adds `classificationLevel` to the DTO — do Task 4 then re-run. Note any error here and proceed to Task 3/4.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/chat/messages.ts
git commit -m "feat(classification): chat attachments inherit channel classification on send"
```

---

## Task 3: Carry classificationLevel into history + replies selects

**Files:** the messages route and the replies route.

- [ ] **Step 1: messages route**

In `src/app/api/v1/orgs/[orgId]/chat/channels/[channelId]/messages/route.ts`, inside the `attachments: { select: { … } }` block, add `classificationLevel: true,` after the `height: true,` line.

- [ ] **Step 2: replies route**

In `src/app/api/v1/orgs/[orgId]/chat/channels/[channelId]/messages/[messageId]/replies/route.ts`, inside the `attachments: { select: { … } }` block, add `classificationLevel: true,` after the `height: true,` line.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: no errors (or the DTO-related error noted in Task 2 Step 5, resolved by Task 4).

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/v1/orgs/[orgId]/chat/channels/[channelId]/messages/route.ts" "src/app/api/v1/orgs/[orgId]/chat/channels/[channelId]/messages/[messageId]/replies/route.ts"
git commit -m "feat(classification): include attachment classification in chat history + replies"
```

---

## Task 4: DTO + attachment-tile chip

**Files:** `src/hooks/use-chat-messages.ts`; `src/components/chat/attachment-tile.tsx` (+ new test).

- [ ] **Step 1: Extend the DTO**

In `src/hooks/use-chat-messages.ts`, add at the top of the file (with other imports) — if not already type-importing from prisma:
```ts
import type { ClassificationLevel } from "@prisma/client";
```
Then add to the `ChatMessageAttachmentDto` type, after `height: number | null;`:
```ts
  classificationLevel: ClassificationLevel;
```

- [ ] **Step 2: Write the failing component test**

Create `src/components/chat/attachment-tile.test.tsx`:
```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ChatMessageAttachmentDto } from "@/hooks/use-chat-messages";
import { AttachmentTile } from "./attachment-tile";

function att(
  classificationLevel: ChatMessageAttachmentDto["classificationLevel"],
): ChatMessageAttachmentDto {
  return {
    id: "a1",
    kind: "file",
    url: "/x",
    filename: "spec.pdf",
    contentType: "application/pdf",
    size: 2048,
    width: null,
    height: null,
    classificationLevel,
  };
}

describe("AttachmentTile classification chip", () => {
  it("shows a chip for a classified (>= FOUO) attachment", () => {
    render(<AttachmentTile attachment={att("CUI")} />);
    expect(screen.getByText("CUI")).toBeTruthy();
  });

  it("shows no chip for an UNCLASSIFIED attachment", () => {
    render(<AttachmentTile attachment={att("UNCLASSIFIED")} />);
    expect(screen.queryByText("UNCLASSIFIED")).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/components/chat/attachment-tile.test.tsx`
Expected: FAIL — the chip is not rendered yet (and/or the DTO type lacks the field until Step 1 is saved).

- [ ] **Step 4: Render the chip**

Replace the entire contents of `src/components/chat/attachment-tile.tsx` with:
```tsx
"use client";
import { Paperclip } from "lucide-react";
import { rankOf } from "@/lib/classification/rank";
import { ClassificationChip } from "@/components/security/classification-chip";
import type { ChatMessageAttachmentDto } from "@/hooks/use-chat-messages";

/** Routine (< FOUO) attachments get no chip — avoids noise in unclassified channels. */
const CHIP_THRESHOLD = rankOf("FOUO");

export function AttachmentTile({ attachment }: { attachment: ChatMessageAttachmentDto }) {
  const showChip = rankOf(attachment.classificationLevel) >= CHIP_THRESHOLD;
  const chip = showChip ? (
    <ClassificationChip level={attachment.classificationLevel} className="mb-1" />
  ) : null;

  if (attachment.kind === "image") {
    return (
      <div className="flex flex-col items-start">
        {chip}
        <a href={attachment.url} target="_blank" rel="noopener noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={attachment.url}
            alt={attachment.filename}
            className="max-h-64 max-w-md rounded border block"
            style={
              attachment.width && attachment.height
                ? { aspectRatio: `${attachment.width}/${attachment.height}` }
                : undefined
            }
          />
        </a>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start">
      {chip}
      <a
        href={attachment.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 rounded border px-2 py-1 text-xs hover:bg-accent"
      >
        <Paperclip className="h-3 w-3" />
        <span className="truncate max-w-[200px]">{attachment.filename}</span>
        <span className="text-muted-foreground">{Math.round(attachment.size / 1024)} KB</span>
      </a>
    </div>
  );
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/components/chat/attachment-tile.test.tsx`
Expected: PASS — 2 tests.

- [ ] **Step 6: Typecheck the whole thing**

Run: `npx tsc --noEmit`
Expected: no errors (the Task 2/3 DTO-dependent types now resolve).

- [ ] **Step 7: Commit**

```bash
git add src/hooks/use-chat-messages.ts src/components/chat/attachment-tile.tsx src/components/chat/attachment-tile.test.tsx
git commit -m "feat(classification): show classification chip on chat attachment tiles"
```

---

## Task 5: Version bump

**Files:** `package.json` (+ lock).

- [ ] **Step 1:** `npm version minor --no-git-tag-version` → `v3.41.0`.
- [ ] **Step 2:** Commit:
```bash
git add package.json package-lock.json
git commit -m "chore(release): 3.41.0 — classified chat attachments"
```

---

## Self-Review

**Spec coverage (spec §6 Phase 4, as corrected by the deviation note):**
- `classificationLevel` on `ChatMessageAttachment` → Task 1 ✓
- Attachment capped at / inherits the channel's project ceiling → Task 2 (inherit-on-send; cap is inherent) ✓
- Marking chip on the file/image in chat → Task 4 ✓
- Reclassify endpoint → **deferred** (documented; not in scope for v1)
- Per-attachment `markings` → **deferred** (level-only for v1; chip shows the level)

**Placeholder scan:** none — exact code/commands in every step.

**Type consistency:** `classificationLevel: ClassificationLevel` added to `ChatMessageAttachmentDto`, the schema, and all three Prisma selects (messages.ts, messages route, replies route) so the value flows end-to-end; `effectiveClassification(orgId, projectId|null)` matches its signature; `attachmentClass.level` is a `ClassificationLevel` matching the column. `rankOf`/`ClassificationChip` are the same client-safe imports used in Phase 2.

**Test strategy note:** the send-time classify wiring in `createUserMessage` is integration-level (full transaction + bus + notifications) — verified by `tsc` + the existing chat suite rather than a bespoke unit test. The genuinely new, user-visible logic (chip visibility threshold) IS unit-tested via `attachment-tile.test.tsx`.
