"use client";

import { useState } from "react";
import { SectorPicker } from "./sector-picker";
import { TemplatePicker } from "./template-picker";
import { ProjectMetadataStep } from "./project-metadata-step";

interface ProjectWizardProps {
  orgId: string;
  orgSlug: string;
}

type Step = 1 | 2 | 3;

const STEP_LABELS: Record<Step, string> = {
  1: "Choose a sector",
  2: "Choose a template",
  3: "Project details",
};

export function ProjectWizard({ orgId, orgSlug }: ProjectWizardProps) {
  const [step, setStep] = useState<Step>(1);
  const [sector, setSector] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);

  function handleSectorSelect(selectedSector: string | null) {
    setSector(selectedSector);
    if (selectedSector === null) {
      // "Start from scratch" — skip template picker
      setTemplateId(null);
      setStep(3);
    } else {
      setStep(2);
    }
  }

  function handleTemplateSelect(selectedTemplateId: string | null) {
    setTemplateId(selectedTemplateId);
    setStep(3);
  }

  function handleBackFromTemplates() {
    setStep(1);
    setSector(null);
  }

  function handleBackFromMetadata() {
    if (sector === null) {
      // Came from "start from scratch" — go back to sector picker
      setStep(1);
    } else {
      setStep(2);
    }
  }

  // Always a 3-step wizard. The "Start from scratch" path skips the template
  // step rather than shrinking the wizard from 3 dots to 2 (which was
  // disorienting); the skipped dot is shown greyed instead.
  const totalSteps = 3;
  const isSkipped = (stepNum: number) => sector === null && stepNum === 2;

  return (
    <div className="space-y-6">
      {/* Step indicator */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-[var(--primary)]">
          Step {step} of {totalSteps}
        </span>
        <span className="text-xs text-[var(--text-muted)]">
          — {STEP_LABELS[step]}
        </span>
        <div className="ml-auto flex gap-1.5">
          {Array.from({ length: totalSteps }).map((_, i) => {
            const stepNum = i + 1;
            const skipped = isSkipped(stepNum);
            const active = stepNum <= step && !skipped;
            return (
              <div
                key={i}
                title={skipped ? "Skipped" : undefined}
                className={
                  active
                    ? "h-1.5 w-8 rounded-full bg-[var(--primary)]"
                    : skipped
                      ? "h-1.5 w-8 rounded-full bg-[var(--border)] opacity-40"
                      : "h-1.5 w-8 rounded-full bg-[var(--border)]"
                }
              />
            );
          })}
        </div>
      </div>

      {step === 1 && <SectorPicker onSelect={handleSectorSelect} />}

      {step === 2 && (
        <TemplatePicker
          orgId={orgId}
          sector={sector}
          onSelect={handleTemplateSelect}
          onBack={handleBackFromTemplates}
        />
      )}

      {step === 3 && (
        <ProjectMetadataStep
          orgId={orgId}
          orgSlug={orgSlug}
          templateId={templateId}
          sector={sector}
          onBack={handleBackFromMetadata}
        />
      )}
    </div>
  );
}
