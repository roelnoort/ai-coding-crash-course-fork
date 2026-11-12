import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "~/components/ui/chart";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { formatRevenue } from "~/lib/analytics-format";
import type { MonthlyBucket } from "~/services/analyticsService";

// ─── Monthly Trend Charts ───
// Revenue, new enrollments and completions for the last 12 calendar months.
// Shared by the analytics overview and the per-course analytics page.

type TrendKey = "revenueCents" | "enrollments" | "completions";

const charts: {
  key: TrendKey;
  title: string;
  color: string;
  format: (value: number) => string;
  /** Room for the y-axis tick labels. */
  yAxisWidth: number;
}[] = [
  {
    key: "revenueCents",
    title: "Revenue",
    color: "var(--chart-1)",
    format: formatRevenue,
    yAxisWidth: 64,
  },
  {
    key: "enrollments",
    title: "New enrollments",
    color: "var(--chart-2)",
    format: String,
    yAxisWidth: 32,
  },
  {
    key: "completions",
    title: "Completions",
    color: "var(--chart-3)",
    format: String,
    yAxisWidth: 32,
  },
];

/** "2026-06" → "Jun 26". Parsed as UTC so the label matches the bucket. */
function monthLabel(month: string) {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
}

export function TrendCharts({ trends }: { trends: MonthlyBucket[] }) {
  const data = trends.map((bucket) => ({
    ...bucket,
    label: monthLabel(bucket.month),
  }));

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {charts.map((chart) => {
        const config = {
          [chart.key]: { label: chart.title, color: chart.color },
        } satisfies ChartConfig;

        return (
          <Card key={chart.key}>
            <CardHeader>
              <CardTitle className="text-base">{chart.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer config={config} className="h-48 w-full">
                <BarChart data={data} accessibilityLayer>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={chart.yAxisWidth}
                    allowDecimals={false}
                    tickFormatter={chart.format}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(value) => (
                          <span className="font-mono tabular-nums">
                            {chart.format(Number(value))}
                          </span>
                        )}
                      />
                    }
                  />
                  <Bar
                    dataKey={chart.key}
                    fill={`var(--color-${chart.key})`}
                    radius={4}
                  />
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
