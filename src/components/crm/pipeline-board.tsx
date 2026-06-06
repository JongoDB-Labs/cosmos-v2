"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  DndContext,
  closestCorners,
  DragEndEvent,
  DragOverEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, DollarSign, TrendingUp } from "lucide-react";
import { ContactCard } from "./contact-card";
import { ContactDetailSheet } from "./contact-detail-sheet";
import { notifyError } from "@/lib/errors/notify";
import type { CrmContact, OrgMember } from "@/types/models";

interface PipelineBoardProps {
  orgId: string;
}

interface PipelineStage {
  key: CrmContact["stage"];
  label: string;
  color: string;
}

const STAGES: PipelineStage[] = [
  { key: "LEAD", label: "Lead", color: "bg-gray-500" },
  { key: "QUALIFIED", label: "Qualified", color: "bg-blue-500" },
  { key: "PROPOSAL", label: "Proposal", color: "bg-purple-500" },
  { key: "NEGOTIATION", label: "Negotiation", color: "bg-yellow-500" },
  { key: "CLOSED_WON", label: "Closed Won", color: "bg-green-500" },
  { key: "CLOSED_LOST", label: "Closed Lost", color: "bg-red-500" },
];

function SortableContactCard({
  contact,
  members,
  onClick,
  onDelete,
}: {
  contact: CrmContact;
  members: OrgMember[];
  onClick: (contact: CrmContact) => void;
  onDelete: (contactId: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: contact.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <ContactCard
        contact={contact}
        members={members}
        onClick={onClick}
        onDelete={onDelete}
      />
    </div>
  );
}

export function PipelineBoard({ orgId }: PipelineBoardProps) {
  const [contacts, setContacts] = useState<CrmContact[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeContact, setActiveContact] = useState<CrmContact | null>(null);
  const [detailContact, setDetailContact] = useState<CrmContact | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [addingStage, setAddingStage] = useState<string | null>(null);
  const [newContactName, setNewContactName] = useState("");
  const [creatingContact, setCreatingContact] = useState(false);
  // Snapshot of contacts at drag START (before handleDragOver mutates them for
  // the live preview), so a rejected stage move can be truly reverted.
  const beforeDragContactsRef = useRef<CrmContact[]>([]);

  const basePath = `/api/v1/orgs/${orgId}`;

  useEffect(() => {
    let cancelled = false;

    async function fetchData() {
      setLoading(true);
      setError(null);

      try {
        const [contactsRes, membersRes] = await Promise.all([
          fetch(`${basePath}/crm/contacts`),
          fetch(`${basePath}/members`),
        ]);

        if (!contactsRes.ok) throw new Error("Failed to load contacts");

        const contactsData: CrmContact[] = await contactsRes.json();
        if (!cancelled) setContacts(contactsData);

        if (membersRes.ok) {
          const membersData: OrgMember[] = await membersRes.json();
          if (!cancelled) setMembers(membersData);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unknown error");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchData();
    return () => {
      cancelled = true;
    };
  }, [basePath]);

  // Hybrid: mouse uses PointerSensor (5px drag), touch uses TouchSensor
  // with 250ms long-press + 5px tolerance so accidental drags during
  // vertical scroll don't fire on phones.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
  );

  function contactsForStage(stageKey: string) {
    return contacts
      .filter((c) => c.stage === stageKey)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  function handleDragStart(event: DragStartEvent) {
    const contact = contacts.find((c) => c.id === event.active.id);
    setActiveContact(contact ?? null);
    beforeDragContactsRef.current = contacts;
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    const srcContact = contacts.find((c) => c.id === activeId);
    if (!srcContact) return;

    // Check if over is a stage
    const overStage = STAGES.find((s) => s.key === overId);
    let targetStage: string | null = null;

    if (overStage) {
      targetStage = overStage.key;
    } else {
      const overContact = contacts.find((c) => c.id === overId);
      if (overContact) {
        targetStage = overContact.stage;
      }
    }

    if (!targetStage || srcContact.stage === targetStage) return;

    setContacts((prev) =>
      prev.map((c) =>
        c.id === activeId ? { ...c, stage: targetStage as CrmContact["stage"] } : c
      )
    );
  }

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveContact(null);
      const { active, over } = event;
      if (!over) return;

      const activeId = active.id as string;
      const overId = over.id as string;

      const movedContact = contacts.find((c) => c.id === activeId);
      if (!movedContact) return;

      let targetStage = movedContact.stage;
      const overStage = STAGES.find((s) => s.key === overId);
      if (overStage) {
        targetStage = overStage.key;
      } else {
        const overContact = contacts.find((c) => c.id === overId);
        if (overContact) {
          targetStage = overContact.stage;
        }
      }

      // Optimistic stage move. (Pre-drag state was captured in handleDragStart,
      // before handleDragOver moved the card, so we can truly revert.)
      setContacts((prev) =>
        prev.map((c) =>
          c.id === activeId ? { ...c, stage: targetStage } : c
        )
      );

      void (async () => {
        try {
          const res = await fetch(`${basePath}/crm/contacts/${activeId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stage: targetStage }),
          });
          if (!res.ok) throw new Error(`Failed to move contact (HTTP ${res.status})`);
        } catch (err) {
          console.error("Failed to update contact stage:", err);
          setContacts(beforeDragContactsRef.current);
          notifyError(err, "Couldn't move the contact — it's been put back.");
        }
      })();
    },
    [contacts, basePath]
  );

  function handleContactClick(contact: CrmContact) {
    setDetailContact(contact);
    setDetailOpen(true);
  }

  function handleContactUpdate(updated: CrmContact) {
    setContacts((prev) =>
      prev.map((c) => (c.id === updated.id ? updated : c))
    );
    setDetailContact(updated);
  }

  function handleContactDelete(contactId: string) {
    setContacts((prev) => prev.filter((c) => c.id !== contactId));
  }

  async function handleAddContact(stageKey: string) {
    if (!newContactName.trim() || creatingContact) return;

    setCreatingContact(true);
    try {
      const res = await fetch(`${basePath}/crm/contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newContactName.trim(), stage: stageKey }),
      });

      if (!res.ok) throw new Error("Failed to create contact");

      const created: CrmContact = await res.json();
      setContacts((prev) => [...prev, created]);
      setNewContactName("");
      setAddingStage(null);
    } catch (err) {
      console.error("Failed to create contact:", err);
      notifyError(err, "Couldn't add the contact.");
    } finally {
      setCreatingContact(false);
    }
  }

  // Pipeline metrics
  const totalPipelineValue = contacts
    .filter((c) => c.stage !== "CLOSED_LOST")
    .reduce((sum, c) => sum + (c.dealValue != null ? Number(c.dealValue) : 0), 0);
  const closedWonValue = contacts
    .filter((c) => c.stage === "CLOSED_WON")
    .reduce((sum, c) => sum + (c.dealValue != null ? Number(c.dealValue) : 0), 0);
  const totalContacts = contacts.filter(
    (c) => c.stage !== "CLOSED_WON" && c.stage !== "CLOSED_LOST"
  ).length;

  if (loading) {
    return <PipelineBoardSkeleton />;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-sm text-destructive mb-2">
            Failed to load pipeline
          </p>
          <p className="text-xs text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Summary bar */}
      <div className="flex items-center gap-6 px-4 py-3 border-b bg-muted/30">
        <div className="flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-muted-foreground" />
          <div>
            <p className="text-xs text-muted-foreground">Pipeline Value</p>
            <p className="text-sm font-semibold">
              ${totalPipelineValue.toLocaleString()}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          <div>
            <p className="text-xs text-muted-foreground">Won</p>
            <p className="text-sm font-semibold text-[var(--status-done-text)]">
              ${closedWonValue.toLocaleString()}
            </p>
          </div>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Active Deals</p>
          <p className="text-sm font-semibold">{totalContacts}</p>
        </div>
      </div>

      {/* Pipeline columns */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="flex gap-3 overflow-x-auto scrollbar-x flex-1 p-4">
          {STAGES.map((stage) => {
            const stageContacts = contactsForStage(stage.key);
            const stageValue = stageContacts.reduce(
              (sum, c) => sum + (c.dealValue != null ? Number(c.dealValue) : 0),
              0
            );

            return (
              <div
                key={stage.key}
                className="w-72 shrink-0 flex flex-col rounded-lg bg-muted/30"
              >
                <div className="flex items-center justify-between px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className={`h-2 w-2 rounded-full ${stage.color}`} />
                    <span className="text-sm font-medium">{stage.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {stageContacts.length}
                    </span>
                  </div>
                  {stageValue > 0 && (
                    <span className="text-xs text-muted-foreground">
                      ${stageValue.toLocaleString()}
                    </span>
                  )}
                </div>

                <SortableContext
                  items={stageContacts.map((c) => c.id)}
                  strategy={verticalListSortingStrategy}
                  id={stage.key}
                >
                  <div className="flex-1 px-2 pb-2 space-y-2 min-h-[4rem]">
                    {stageContacts.map((contact) => (
                      <SortableContactCard
                        key={contact.id}
                        contact={contact}
                        members={members}
                        onClick={handleContactClick}
                        onDelete={handleContactDelete}
                      />
                    ))}

                    {addingStage === stage.key ? (
                      <div className="space-y-2">
                        <Input
                          placeholder="Contact name..."
                          value={newContactName}
                          onChange={(e) => setNewContactName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter")
                              handleAddContact(stage.key);
                            if (e.key === "Escape") {
                              setAddingStage(null);
                              setNewContactName("");
                            }
                          }}
                          autoFocus
                        />
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            onClick={() => handleAddContact(stage.key)}
                            disabled={!newContactName.trim() || creatingContact}
                          >
                            Add
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setAddingStage(null);
                              setNewContactName("");
                            }}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start gap-1 text-muted-foreground"
                        onClick={() => setAddingStage(stage.key)}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Add contact
                      </Button>
                    )}
                  </div>
                </SortableContext>
              </div>
            );
          })}
        </div>

        <DragOverlay>
          {activeContact && (
            <div className="w-72">
              <ContactCard
                contact={activeContact}
                members={members}
                onClick={() => {}}
              />
            </div>
          )}
        </DragOverlay>
      </DndContext>

      <ContactDetailSheet
        contact={detailContact}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        orgId={orgId}
        members={members}
        onUpdate={handleContactUpdate}
        onDelete={handleContactDelete}
      />
    </div>
  );
}

function PipelineBoardSkeleton() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-6 px-4 py-3 border-b">
        <Skeleton className="h-10 w-32" />
        <Skeleton className="h-10 w-24" />
        <Skeleton className="h-10 w-24" />
      </div>
      <div className="flex gap-3 overflow-x-auto flex-1 p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="w-72 shrink-0 space-y-3">
            <Skeleton className="h-8 w-full rounded-lg" />
            <Skeleton className="h-20 w-full rounded-lg" />
            <Skeleton className="h-20 w-full rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}
