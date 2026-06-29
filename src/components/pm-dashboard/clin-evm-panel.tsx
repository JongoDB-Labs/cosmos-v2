"use client";

import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from "@/components/charts/lazy-recharts";

interface SeriesPoint {
  month: string;
  label: string;
  cumActual: number | null;
  cumForecast: number | null;
  ceiling: number;
  funded: number;
}
interface Evm {
  ceiling: number;
  funded: number;
  burnedToDate: number;
  eac: number;
  eacVsCeiling: number;
  percentFunded: number | null;
  monthlyRunRate: number;
  popStart: string | null;
  popEnd: string | null;
  series: SeriesPoint[];
}

const ACTUAL = "#16a34a";
const FORECAST = "#2563eb";
const CEILING = "#dc2626";
const FUNDED = "#d97706";

function money(n: number | null | undefined): string {
  if (n == null) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

interface Props {
  orgId: string;
  projectId: string;
}

export function ClinEvmPanel({ orgId, projectId }: Props) {
  const queryKey = useOrgQueryKey("clins-evm", projectId);
  const { data, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () =>
      jsonFetch<Evm>(`/api/v1/orgs/${orgId}/projects/${projectId}/clins/evm`),
  });

  if (isLoading) {
    return (
      <div className="mx-auto max-w-6xl px-6 pt-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="mt-4 h-72 w-full" />
      </div>
    );
  }
  // Quietly skip the panel when there are no CLINs / no data (the table below
  // carries its own empty state).
  if (isError || !data || data.ceiling === 0) return null;

  const overCeiling = data.eacVsCeiling > 0;
  const eacTone = overCeiling ? CEILING : ACTUAL;

  const cards: { label: string; value: string; sub: string; tone: string }[] = [
    {
      label: "Contract Ceiling",
      value: money(data.ceiling),
      sub: `${money(data.ceiling - data.funded)} unfunded`,
      tone: FORECAST,
    },
    {
      label: "Funded Value",
      value: money(data.funded),
      sub: data.ceiling > 0 ? `${Math.round((data.funded / data.ceiling) * 100)}% of ceiling` : "—",
      tone: FUNDED,
    },
    {
      label: "Burned to Date",
      value: money(data.burnedToDate),
      sub: data.percentFunded != null ? `${data.percentFunded}% of funded` : "—",
      tone: ACTUAL,
    },
    {
      label: "Forecast (EAC)",
      value: money(data.eac),
      sub: `${money(Math.abs(data.eacVsCeiling))} ${overCeiling ? "over" : "under"} ceiling`,
      tone: eacTone,
    },
  ];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 pt-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--text)]">Financial / Burn</h2>
        <p className="text-sm text-[var(--text-muted)]">
          Cumulative actuals vs. forecast over the period of performance — projected at the
          current burn rate ({money(data.monthlyRunRate)}/mo).
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {cards.map((c) => (
          <div
            key={c.label}
            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4"
            style={{ borderTop: `3px solid ${c.tone}` }}
          >
            <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">{c.label}</div>
            <div className="mt-1 text-2xl font-bold tabular-nums text-[var(--text)]">{c.value}</div>
            <div className="mt-0.5 text-xs" style={{ color: c.tone }}>
              {c.sub}
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="mb-3 text-sm font-medium text-[var(--text)]">
          Cumulative Burn — Actual vs Forecast vs Ceiling
        </div>
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.series} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                tickFormatter={(v: number) => money(v)}
                width={56}
              />
              <Tooltip
                formatter={(value) => money(Number(value))}
                labelStyle={{ color: "#111827" }}
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <ReferenceLine
                y={data.ceiling}
                stroke={CEILING}
                strokeDasharray="5 4"
                label={{ value: "Ceiling", position: "insideTopRight", fontSize: 10, fill: CEILING }}
              />
              <ReferenceLine
                y={data.funded}
                stroke={FUNDED}
                strokeDasharray="5 4"
                label={{ value: "Funded", position: "insideBottomRight", fontSize: 10, fill: FUNDED }}
              />
              <Line
                type="monotone"
                dataKey="cumActual"
                name="Cum. Actual"
                stroke={ACTUAL}
                strokeWidth={2.5}
                dot={false}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="cumForecast"
                name="Cum. Forecast (EAC)"
                stroke={FORECAST}
                strokeWidth={2}
                strokeDasharray="6 4"
                dot={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
