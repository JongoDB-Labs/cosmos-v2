"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronUp, Bug, Lightbulb, Pencil, Trash2 } from "lucide-react";
import {
  INTAKE_BADGE_VARIANT,
  STATUS_LABELS,
  STATUS_ORDER,
  reporterLabel,
  type FeedbackItem,
  type FStatus,
} from "./feedback-types";
import { FeedbackThread } from "./feedback-thread";
import { FeedbackFollowButton } from "./feedback-follow-button";
import { MergeControls, MergedNotice } from "./feedback-merge-controls";

/**
 * The full view of one feedback item (FR: "click on the FR and a modal pops up
 * to show all the details"), split out of the portal so the discussion thread
 * has somewhere to live. The portal owns the data and the mutations; this owns
 * only its own edit mode.
 */
export function FeedbackDetailDialog({
  orgId,
  item: detailItem,
  canManage,
  busyId,
  onClose,
  onToggleVote: toggleVote,
  onChangeStatus: changeStatus,
  onSaveEdit,
  onRequestDelete: setConfirmDeleteId,
  candidates,
  onOpenItem,
  onMergeChanged,
}: {
  orgId: string;
  item: FeedbackItem | null;
  canManage: boolean;
  busyId: string | null;
  onClose: () => void;
  onToggleVote: (item: FeedbackItem) => void;
  onChangeStatus: (item: FeedbackItem, status: FStatus) => void;
  /** Resolves true when the edit was saved, so the dialog can leave edit mode. */
  onSaveEdit: (item: FeedbackItem, title: string, description: string) => Promise<boolean>;
  onRequestDelete: (id: string) => void;
  /** The board's requests, offered as merge targets (staff). */
  candidates: FeedbackItem[];
  /** Open another request in this dialog (the one this was merged into). */
  onOpenItem: (id: string) => void;
  /** After a merge or an undo, so the board and this item refresh. */
  onMergeChanged: (item: FeedbackItem) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");

  async function saveEdit(item: FeedbackItem, title: string, description: string) {
    if (await onSaveEdit(item, title, description)) setEditing(false);
  }

  return (
      <Dialog
        open={detailItem !== null}
        onOpenChange={(o) => {
          if (!o) {
            onClose();
            setEditing(false);
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          {detailItem && (
            <>
              <DialogHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="neutral" className="gap-1 text-[10px]">
                    {detailItem.type === "BUG" ? (
                      <Bug className="h-3 w-3" />
                    ) : (
                      <Lightbulb className="h-3 w-3" />
                    )}
                    {detailItem.type === "BUG" ? "Bug" : "Feature"}
                  </Badge>
                  <Badge
                    variant={detailItem.status === "DONE" ? "progress" : detailItem.status === "IN_REVIEW" ? "review" : "neutral"}
                    className="text-[10px]"
                  >
                    {STATUS_LABELS[detailItem.status]}
                  </Badge>
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <ChevronUp className="h-3 w-3" />
                    {detailItem.voteCount}
                  </span>
                </div>
                <DialogTitle className="pt-1 text-base">
                  {detailItem.title}
                </DialogTitle>
                <DialogDescription>
                  Submitted{" "}
                  {new Date(detailItem.createdAt).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                  {reporterLabel(detailItem) && ` · ${reporterLabel(detailItem)}`}
                </DialogDescription>
              </DialogHeader>

              <div className="max-h-[55vh] space-y-4 overflow-y-auto">
                <MergedNotice orgId={orgId} item={detailItem} onOpenItem={onOpenItem} />
                {editing ? (
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="fb-edit-title">Title</Label>
                      <Input
                        id="fb-edit-title"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fb-edit-desc">Details</Label>
                      <Textarea
                        id="fb-edit-desc"
                        value={editDesc}
                        onChange={(e) => setEditDesc(e.target.value)}
                        className="min-h-[120px]"
                      />
                    </div>
                  </div>
                ) : detailItem.description ? (
                  <p className="text-sm whitespace-pre-wrap text-foreground/90">
                    {detailItem.description}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground italic">
                    No additional details were provided.
                  </p>
                )}

                {!editing && detailItem.intake && (
                  <div className="rounded-md border bg-muted/30 p-3">
                    <div className="flex items-center gap-2">
                      <Badge variant={INTAKE_BADGE_VARIANT[detailItem.intake.state]} className="text-[10px]">
                        {detailItem.intake.label}
                      </Badge>
                      {detailItem.intake.score != null && (
                        <span className="text-[11px] text-muted-foreground">
                          score {detailItem.intake.score.toFixed(2)}
                        </span>
                      )}
                    </div>
                    {detailItem.intake.reason && (
                      <p className="mt-1.5 text-xs text-muted-foreground">{detailItem.intake.reason}</p>
                    )}
                  </div>
                )}

                {detailItem.attachments && detailItem.attachments.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">
                      Attachments
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {detailItem.attachments.map((a) =>
                        a.kind === "image" ? (
                          <a
                            key={a.id}
                            href={a.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={a.filename}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={a.url}
                              alt={a.filename}
                              className="h-24 w-24 rounded border object-cover transition-opacity hover:opacity-80"
                            />
                          </a>
                        ) : (
                          <a
                            key={a.id}
                            href={a.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs underline underline-offset-2"
                          >
                            {a.filename}
                          </a>
                        ),
                      )}
                    </div>
                  </div>
                )}
              </div>

              <FeedbackThread orgId={orgId} item={detailItem} />

              <DialogFooter className="sm:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busyId === detailItem.id || detailItem.status === "MERGED"}
                  onClick={() => toggleVote(detailItem)}
                  aria-pressed={detailItem.hasVoted}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                    detailItem.hasVoted
                      ? "border-primary/50 bg-primary/10 text-primary"
                      : "hover:bg-muted text-muted-foreground"
                  }`}
                >
                  <ChevronUp className="h-4 w-4" />
                  {detailItem.hasVoted ? "Voted" : "Upvote"} · {detailItem.voteCount}
                </button>
                <FeedbackFollowButton orgId={orgId} itemId={detailItem.id} />
                {canManage && (
                  <MergeControls
                    orgId={orgId}
                    item={detailItem}
                    candidates={candidates}
                    onChanged={() => onMergeChanged(detailItem)}
                  />
                )}
                </div>
                {/* Content edits + delete are owned by the author OR a manager
                    (admins may edit/delete any FR/BR — COSMOS-49); status
                    triage is manager-only. Each control shows only for the
                    authority that backs it, mirroring the API. */}
                {(canManage || detailItem.isMine) &&
                  (editing ? (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditing(false)}
                        disabled={busyId === detailItem.id}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => saveEdit(detailItem, editTitle, editDesc)}
                        disabled={busyId === detailItem.id || !editTitle.trim()}
                      >
                        Save
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      {(canManage || detailItem.isMine) && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Edit"
                          title="Edit"
                          onClick={() => {
                            setEditTitle(detailItem.title);
                            setEditDesc(detailItem.description ?? "");
                            setEditing(true);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Delete"
                        title="Delete"
                        onClick={() => setConfirmDeleteId(detailItem.id)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                      {canManage && (
                        <Select
                          value={detailItem.status}
                          onValueChange={(v) => v && changeStatus(detailItem, v as FStatus)}
                        >
                          <SelectTrigger size="sm" className="h-8 w-32 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {STATUS_ORDER.map((s) => (
                              <SelectItem key={s} value={s}>
                                {STATUS_LABELS[s]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  ))}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
  );
}
