import { StatCard } from "../stat-card";

export const statCardExamples = [
  {
    label: "Number + Bar",
    node: (
      <StatCard label="Revenue this quarter" trend="+12%">
        <StatCard.Number>$48,200</StatCard.Number>
        <StatCard.Bar value={37800} max={48200} label="vs $60k goal" />
      </StatCard>
    ),
    code: `<StatCard label="Revenue this quarter" trend="+12%">
  <StatCard.Number>$48,200</StatCard.Number>
  <StatCard.Bar value={37800} max={48200} label="vs $60k goal" />
</StatCard>`,
  },
  {
    label: "Number + Sparkline",
    node: (
      <StatCard label="Sessions this week" trend="+8%">
        <StatCard.Number>1,847</StatCard.Number>
        <StatCard.Sparkline
          data={[120, 145, 132, 178, 196, 210, 240]}
          label="Last 7 days"
        />
      </StatCard>
    ),
    code: `<StatCard label="Sessions this week" trend="+8%">
  <StatCard.Number>1,847</StatCard.Number>
  <StatCard.Sparkline
    data={[120, 145, 132, 178, 196, 210, 240]}
    label="Last 7 days"
  />
</StatCard>`,
  },
  {
    label: "Number only",
    node: (
      <StatCard label="Active sprints" trend="+3">
        <StatCard.Number>12</StatCard.Number>
      </StatCard>
    ),
    code: `<StatCard label="Active sprints" trend="+3">
  <StatCard.Number>12</StatCard.Number>
</StatCard>`,
  },
  {
    label: "Down trend",
    node: (
      <StatCard label="Churn" trend="-2%">
        <StatCard.Number>5.4%</StatCard.Number>
      </StatCard>
    ),
    code: `<StatCard label="Churn" trend="-2%">
  <StatCard.Number>5.4%</StatCard.Number>
</StatCard>`,
  },
];
