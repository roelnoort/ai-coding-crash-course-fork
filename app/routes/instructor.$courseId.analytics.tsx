import { Link, isRouteErrorResponse } from "react-router";
import type { Route } from "./+types/instructor.$courseId.analytics";
import { requireOwningInstructor } from "~/lib/access.server";
import { getCourseAnalytics } from "~/services/analyticsService";
import {
  formatPercent,
  formatRating,
  formatRevenue,
} from "~/lib/analytics-format";
import { TrendCharts } from "~/components/analytics/trend-charts";
import {
  LessonDropOffChart,
  QuizPerformanceTable,
  VideoEngagementTable,
} from "~/components/analytics/course-breakdowns";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { AlertTriangle, Users } from "lucide-react";

// ─── Course Analytics ───
// Headline numbers, monthly trends and learning breakdowns (quizzes, lesson
// drop-off, video engagement) for one course. Only the instructor who
// owns the course may see it — admins get 403 (analytics is out of scope for
// them).

export function meta({ loaderData }: Route.MetaArgs) {
  const title = loaderData?.course.title ?? "Course";
  return [
    { title: `Analytics: ${title} — Cadence` },
    { name: "description", content: `How ${title} is performing` },
  ];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const { course } = await requireOwningInstructor(request, params.courseId);

  return {
    course: { id: course.id, title: course.title },
    ...getCourseAnalytics(course.id, new Date()),
  };
}

export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <Skeleton className="mb-8 h-9 w-64" />
      <Skeleton className="mb-8 h-24 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="py-4">
      <CardContent className="px-4">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

export default function CourseAnalytics({ loaderData }: Route.ComponentProps) {
  const { course, headline, trends, quizzes, lessonDropOff, videoEngagement } =
    loaderData;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <Link to="/instructor/analytics" className="hover:text-foreground">
          Analytics
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">{course.title}</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">{course.title}</h1>
        <p className="mt-1 text-muted-foreground">
          How this course is performing
        </p>
      </div>

      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Students" value={String(headline.students)} />
        <Stat label="Revenue" value={formatRevenue(headline.revenueCents)} />
        <Stat
          label="Completion rate"
          value={formatPercent(headline.completionRate)}
        />
        <Stat
          label="Avg. progress"
          value={formatPercent(headline.averageProgress)}
        />
        <Stat
          label="Avg. quiz score"
          value={formatPercent(headline.averageQuizScore)}
        />
        <Stat
          label="Avg. rating"
          value={formatRating(headline.averageRating)}
        />
      </div>

      {headline.students === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Users className="mb-4 size-12 text-muted-foreground/50" />
            <h2 className="text-lg font-medium">No students yet</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Trends and breakdowns will appear here once students enroll in
              this course.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <section className="mb-8">
            <h2 className="mb-4 text-xl font-semibold">Last 12 months</h2>
            <TrendCharts trends={trends} />
          </section>

          <section>
            <h2 className="mb-4 text-xl font-semibold">Learning</h2>
            <div className="grid gap-6">
              <QuizPerformanceTable quizzes={quizzes} />
              <LessonDropOffChart lessons={lessonDropOff} />
              <VideoEngagementTable videos={videoEngagement} />
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message =
    "An unexpected error occurred while loading this course's analytics.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      title = "Course not found";
      message =
        "The course you're looking for doesn't exist or may have been removed.";
    } else if (error.status === 401) {
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
          : "You don't have permission to view these analytics.";
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
        <div className="flex items-center justify-center gap-3">
          <Link to="/instructor">
            <Button variant="outline">My Courses</Button>
          </Link>
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
