import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "~/components/ui/chart";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { NO_DATA, formatPercent } from "~/lib/analytics-format";
import {
  FINISHED_SHARE,
  type LessonDropOff,
  type QuizPerformance,
  type VideoEngagement,
} from "~/services/analyticsService";

// ─── Course Breakdowns ───
// How students move through one course: quiz performance, lesson drop-off and
// video engagement. No-data values render as "—".

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function Th({
  children,
  align = "right",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`px-4 py-3 font-medium ${align === "left" ? "text-left" : "text-right"}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "right",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <td
      className={`px-4 py-3 ${align === "left" ? "text-left" : "text-right tabular-nums"}`}
    >
      {children}
    </td>
  );
}

function LessonCell({ title, context }: { title: string; context: string }) {
  return (
    <Td align="left">
      <div className="font-medium">{title}</div>
      <div className="text-xs text-muted-foreground">{context}</div>
    </Td>
  );
}

export function QuizPerformanceTable({
  quizzes,
}: {
  quizzes: QuizPerformance[];
}) {
  return (
    <Card className="gap-0 pb-0">
      <CardHeader className="pb-4">
        <CardTitle className="text-base">Quiz performance</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        {quizzes.length === 0 ? (
          <div className="px-6 pb-6">
            <EmptyNote>This course has no quizzes.</EmptyNote>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-y text-muted-foreground">
              <tr>
                <Th align="left">Quiz</Th>
                <Th>Students</Th>
                <Th>Avg. best score</Th>
                <Th>Pass rate</Th>
              </tr>
            </thead>
            <tbody>
              {quizzes.map((quiz) => (
                <tr key={quiz.quizId} className="border-b last:border-b-0">
                  <LessonCell title={quiz.title} context={quiz.lessonTitle} />
                  <Td>{quiz.students}</Td>
                  <Td>{formatPercent(quiz.averageScore)}</Td>
                  <Td>{formatPercent(quiz.passRate)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

const dropOffConfig = {
  completedPercent: { label: "Completed", color: "var(--chart-2)" },
} satisfies ChartConfig;

/** Room per lesson bar, so long courses stay readable. */
const DROP_OFF_ROW_HEIGHT = 32;

export function LessonDropOffChart({ lessons }: { lessons: LessonDropOff[] }) {
  const data = lessons.map((lesson, i) => ({
    // Numbered so the course order reads at a glance; long titles are
    // truncated on the axis and shown in full in the tooltip.
    label: `${i + 1}. ${lesson.title}`,
    completedPercent:
      lesson.completionRate === null
        ? null
        : Math.round(lesson.completionRate * 100),
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Lesson drop-off</CardTitle>
      </CardHeader>
      <CardContent>
        {lessons.length === 0 ? (
          <EmptyNote>This course has no lessons.</EmptyNote>
        ) : (
          <ChartContainer
            config={dropOffConfig}
            className="aspect-auto w-full"
            style={{ height: lessons.length * DROP_OFF_ROW_HEIGHT + 40 }}
          >
            <BarChart data={data} layout="vertical" accessibilityLayer>
              <CartesianGrid horizontal={false} />
              <XAxis
                type="number"
                domain={[0, 100]}
                tickFormatter={(value) => `${value}%`}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                type="category"
                dataKey="label"
                width={200}
                tickLine={false}
                axisLine={false}
                interval={0}
                tickFormatter={(value: string) =>
                  value.length > 28 ? `${value.slice(0, 27)}…` : value
                }
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value) => (
                      <span className="font-mono tabular-nums">
                        {value === null ? NO_DATA : `${value}%`} of students
                        completed
                      </span>
                    )}
                  />
                }
              />
              <Bar
                dataKey="completedPercent"
                fill="var(--color-completedPercent)"
                radius={4}
              />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

export function VideoEngagementTable({
  videos,
}: {
  videos: VideoEngagement[];
}) {
  return (
    <Card className="gap-0 pb-0">
      <CardHeader className="pb-4">
        <CardTitle className="text-base">Video engagement</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        {videos.length === 0 ? (
          <div className="px-6 pb-6">
            <EmptyNote>No lessons have a video with a duration.</EmptyNote>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-y text-muted-foreground">
              <tr>
                <Th align="left">Lesson</Th>
                <Th>Started</Th>
                <Th>Avg. share watched</Th>
                <Th>Finished (≥ {formatPercent(FINISHED_SHARE)})</Th>
              </tr>
            </thead>
            <tbody>
              {videos.map((video) => (
                <tr key={video.lessonId} className="border-b last:border-b-0">
                  <LessonCell title={video.title} context={video.moduleTitle} />
                  <Td>{formatPercent(video.startedRate)}</Td>
                  <Td>{formatPercent(video.averageShareWatched)}</Td>
                  <Td>{formatPercent(video.finishedRate)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
