import { Shield, Bell } from "lucide-react";
import { SectionCard } from "../section-card";

export const sectionCardExamples = [
  {
    label: "With controls",
    node: (
      <SectionCard
        icon={Shield}
        title="Security"
        description="Manage who can access this organization."
      >
        <p className="text-sm text-[var(--text-muted)]">Panel content here.</p>
      </SectionCard>
    ),
    code: `<SectionCard
  icon={Shield}
  title="Security"
  description="Manage who can access this organization."
>
  {/* controls */}
</SectionCard>`,
  },
  {
    label: "Notifications",
    node: (
      <SectionCard
        icon={Bell}
        title="Notifications"
        description="Choose how you'd like to be notified."
      >
        <p className="text-sm text-[var(--text-muted)]">Toggles go here.</p>
      </SectionCard>
    ),
    code: `<SectionCard icon={Bell} title="Notifications" description="...">
  {/* toggles */}
</SectionCard>`,
  },
];
