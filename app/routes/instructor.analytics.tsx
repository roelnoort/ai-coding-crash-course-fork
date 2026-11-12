import { Link, isRouteErrorResponse } from "react-router";
import type { Route } from "./+types/instructor.analytics";
import { requireInstructor } from "~/lib/access.server";
import {
  getInstructorOverview,
  type OverviewMetrics,
} from "~/services/analyticsService";
import {
  formatPercent,
  formatRating,
  formatRevenue,
} from "~/lib/analytics-format";
import { TrendCharts } from "~/components/analytics/trend-charts";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { AlertTriangle, BarChart3 } from "lucide-react";
import { CourseStatus } from "~/db/schema";

// ─── Instructor Analytics Overview ───
// One row per course with its key metrics, a total row across them, and
// monthly trend charts across the same courses. Each row links to the course's
// own analytics page.
// Instructors only — admins get 403 (analytics is out of scope for them).

export function meta() {
  return [
    { title: "Analytics — Cadence" },
    { name: "description", content: "How your courses are performing" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { userId } = await requireInstructor(request);
  return getInstructorOverview(userId, new Date());
}

function MetricCells({ metrics }: { metrics: OverviewMetrics }) {
  return (
    <>
      <td className="px-4 py-3 text-right tabular-nums">{metrics.students}</td>
      <td className="px-4 py-3 text-right tabular-nums">
        {formatRevenue(metrics.revenueCents)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {formatPercent(metrics.completionRate)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {formatPercent(metrics.averageProgress)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {formatPercent(metrics.averageQuizScore)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {formatRating(metrics.averageRating)}
      </td>
    </>
  );
}

const statusLabel: Record<CourseStatus, string> = {
  [CourseStatus.Published]: "Published",
  [CourseStatus.Draft]: "Draft",
  [CourseStatus.Archived]: "Archived",
};

export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <Skeleton className="mb-8 h-9 w-40" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export default function InstructorAnalytics({
  loaderData,
}: Route.ComponentProps) {
  const { courses, total, trends } = loaderData;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Analytics</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Analytics</h1>
        <p className="mt-1 text-muted-foreground">
          How your courses are performing
        </p>
      </div>

      {courses.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <BarChart3 className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="text-lg font-medium">No courses to analyse yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Publish a course to start seeing its numbers here.
          </p>
        </div>
      ) : (
        <Card className="py-0">
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Course</th>
                  <th className="px-4 py-3 text-right font-medium">Students</th>
                  <th className="px-4 py-3 text-right font-medium">Revenue</th>
                  <th className="px-4 py-3 text-right font-medium">
                    Completion rate
                  </th>
                  <th className="px-4 py-3 text-right font-medium">
                    Avg. progress
                  </th>
                  <th className="px-4 py-3 text-right font-medium">
                    Avg. quiz score
                  </th>
                  <th className="px-4 py-3 text-right font-medium">
                    Avg. rating
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b bg-muted/50 font-semibold">
                  <td className="px-4 py-3">All courses</td>
                  <MetricCells metrics={total} />
                </tr>
                {courses.map((course) => (
                  <tr
                    key={course.courseId}
                    className="border-b last:border-b-0"
                  >
                    <td className="px-4 py-3">
                      <Link
                        to={`/instructor/${course.courseId}/analytics`}
                        className="font-medium hover:underline"
                      >
                        {course.title}
                      </Link>
                      {course.status !== CourseStatus.Published && (
                        <div className="text-xs text-muted-foreground">
                          {statusLabel[course.status]}
                        </div>
                      )}
                    </td>
                    <MetricCells metrics={course} />
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {courses.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-4 text-xl font-semibold">Last 12 months</h2>
          <TrendCharts trends={trends} />
        </section>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading your analytics.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message =
        typeof error.data === "string"
          ? error.data
          : "You don't have permission to access this page.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
