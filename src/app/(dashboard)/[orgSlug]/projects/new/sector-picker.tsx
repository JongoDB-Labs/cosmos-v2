"use client";

import {
  Code2,
  Building2,
  Server,
  Briefcase,
  Factory,
  GraduationCap,
  PartyPopper,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";

const SECTORS = [
  {
    key: "software",
    name: "Software",
    icon: Code2,
    description: "Agile development with sprints, boards, and releases",
  },
  {
    key: "aec",
    name: "Architecture & Engineering",
    icon: Building2,
    description:
      "Phase-gated construction with submittals, RFIs, and change orders",
  },
  {
    key: "ops",
    name: "IT Operations",
    icon: Server,
    description: "Incident management, change requests, and SLA tracking",
  },
  {
    key: "consulting",
    name: "Consulting",
    icon: Briefcase,
    description: "Client engagements with workstreams and deliverables",
  },
  {
    key: "manufacturing",
    name: "Manufacturing",
    icon: Factory,
    description: "Production runs, work orders, and quality control",
  },
  {
    key: "education",
    name: "Education",
    icon: GraduationCap,
    description: "Courses, modules, lessons, and assignments",
  },
  {
    key: "event",
    name: "Event Planning",
    icon: PartyPopper,
    description: "Run-of-show, vendor management, and logistics",
  },
];

interface SectorPickerProps {
  onSelect: (sector: string | null) => void;
}

export function SectorPicker({ onSelect }: SectorPickerProps) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-[var(--text-muted)]">
        Choose the sector that best fits your project. This determines which
        templates are available in the next step.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {SECTORS.map(({ key, name, icon: Icon, description }) => (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(key)}
            className={cn(
              "group flex flex-col gap-3 rounded-[var(--radius)] border border-[var(--border)]",
              "bg-[var(--surface)] p-5 text-left transition-all",
              "hover:border-[var(--primary)] hover:shadow-[var(--shadow-glow)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]",
            )}
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--primary)]/10">
              <Icon className="h-5 w-5 text-[var(--primary)]" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-semibold text-[var(--text)]">{name}</p>
              <p className="text-xs leading-relaxed text-[var(--text-muted)]">
                {description}
              </p>
            </div>
          </button>
        ))}

        {/* Start from scratch */}
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={cn(
            "group flex flex-col gap-3 rounded-[var(--radius)] border border-dashed border-[var(--border)]",
            "bg-[var(--surface)] p-5 text-left transition-all",
            "hover:border-[var(--primary)] hover:shadow-[var(--shadow-glow)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]",
          )}
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--primary)]/10">
            <Sparkles className="h-5 w-5 text-[var(--primary)]" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-semibold text-[var(--text)]">
              Start from scratch
            </p>
            <p className="text-xs leading-relaxed text-[var(--text-muted)]">
              Blank project — no pre-built boards or tracking types
            </p>
          </div>
        </button>
      </div>
    </div>
  );
}
