import {
  and,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { db } from "~/db";
import { FINISHED_SHARE } from "~/lib/analytics-thresholds";
import {
  CourseStatus,
  courseRatings,
  courses,
  enrollments,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
  purchases,
  quizAttempts,
  quizzes,
  videoWatchEvents,
} from "~/db/schema";

// ─── Analytics Service ───
// Instructor-facing course metrics, computed with aggregate SQL — grouping and
// counting happens in the database, never by looping over students.
//
// Each metric is aggregated per course in its own subquery and left-joined onto
// the course list. Joining enrollments, purchases, etc. directly would multiply
// rows and inflate every count and sum.
//
// The queries return sums and counts rather than ratios, so the total row can
// pool every student across courses instead of averaging course averages.
//
// Uses positional parameters (project convention).

export type OverviewMetrics = {
  students: number;
  /** Integer cents, after PPP discounts. A team purchase counts once. */
  revenueCents: number;
  /** 0–1, or null when there are no students. */
  completionRate: number | null;
  /** 0–1, or null when there are no students or no lessons. */
  averageProgress: number | null;
  /**
   * 0–1: each student's best attempt per quiz, averaged across all quizzes.
   * Null when nobody has attempted a quiz.
   */
  averageQuizScore: number | null;
  /** 1–5 stars, or null when there are no ratings. */
  averageRating: number | null;
};

export type CourseOverviewRow = OverviewMetrics & {
  courseId: number;
  title: string;
  status: CourseStatus;
};

/** One calendar month (UTC) of activity. */
export type MonthlyBucket = {
  /** "YYYY-MM", in UTC. */
  month: string;
  /** Integer cents, bucketed by purchase date. */
  revenueCents: number;
  /** Bucketed by enrollment date. */
  enrollments: number;
  /** Bucketed by enrollments.completedAt. */
  completions: number;
};

export type InstructorOverview = {
  courses: CourseOverviewRow[];
  total: OverviewMetrics;
  /** The 12 calendar months up to and including the current one, oldest first. */
  trends: MonthlyBucket[];
};

/** The sums and counts every overview metric is derived from. */
type MetricTotals = {
  students: number;
  completedEnrollments: number;
  revenueCents: number;
  /** Each student's completed ÷ total lessons, summed over the students. */
  progressSum: number;
  /** Students in courses that have lessons — progress is undefined otherwise. */
  progressStudents: number;
  bestScoreSum: number;
  bestScoreCount: number;
  ratingSum: number;
  ratingCount: number;
};

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function toMetrics(totals: MetricTotals): OverviewMetrics {
  return {
    students: totals.students,
    revenueCents: totals.revenueCents,
    completionRate: ratio(totals.completedEnrollments, totals.students),
    averageProgress: ratio(totals.progressSum, totals.progressStudents),
    averageQuizScore: ratio(totals.bestScoreSum, totals.bestScoreCount),
    averageRating: ratio(totals.ratingSum, totals.ratingCount),
  };
}

function sumTotals(rows: MetricTotals[]): MetricTotals {
  const total: MetricTotals = {
    students: 0,
    completedEnrollments: 0,
    revenueCents: 0,
    progressSum: 0,
    progressStudents: 0,
    bestScoreSum: 0,
    bestScoreCount: 0,
    ratingSum: 0,
    ratingCount: 0,
  };
  for (const row of rows) {
    for (const key of Object.keys(total) as (keyof MetricTotals)[]) {
      total[key] += row[key];
    }
  }
  return total;
}

/**
 * Join condition keeping only activity by students enrolled in the course, so
 * e.g. an instructor trying their own quiz doesn't count.
 */
function isEnrolled(userId: SQLiteColumn, courseId: SQLiteColumn | number) {
  return and(
    eq(enrollments.userId, userId),
    eq(enrollments.courseId, courseId)
  );
}

// ─── Per-course aggregates ───

function enrollmentStats() {
  return db
    .select({
      courseId: enrollments.courseId,
      students: sql<number>`count(*)`.as("students"),
      completed: sql<number>`count(${enrollments.completedAt})`.as("completed"),
    })
    .from(enrollments)
    .groupBy(enrollments.courseId)
    .as("enrollment_stats");
}

function revenueStats() {
  return db
    .select({
      courseId: purchases.courseId,
      revenueCents: sql<number>`sum(${purchases.amountPaid})`.as(
        "revenue_cents"
      ),
    })
    .from(purchases)
    .groupBy(purchases.courseId)
    .as("revenue_stats");
}

function lessonCounts() {
  return db
    .select({
      courseId: modules.courseId,
      lessons: sql<number>`count(*)`.as("lessons"),
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .groupBy(modules.courseId)
    .as("lesson_counts");
}

/** Completed lessons summed over the course's enrolled students. */
function completedLessonStats() {
  return db
    .select({
      courseId: modules.courseId,
      completedLessons: sql<number>`count(*)`.as("completed_lessons"),
    })
    .from(lessonProgress)
    .innerJoin(lessons, eq(lessonProgress.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(enrollments, isEnrolled(lessonProgress.userId, modules.courseId))
    .where(eq(lessonProgress.status, LessonProgressStatus.Completed))
    .groupBy(modules.courseId)
    .as("completed_lesson_stats");
}

/**
 * Each enrolled student's best attempt per quiz, summed and counted per course.
 * Attempts by anyone not enrolled (e.g. the instructor trying their own quiz)
 * are ignored, as they are for progress.
 */
function quizScoreStats() {
  const bestAttempts = db
    .select({
      courseId: modules.courseId,
      bestScore: sql<number>`max(${quizAttempts.score})`.as("best_score"),
    })
    .from(quizAttempts)
    .innerJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
    .innerJoin(lessons, eq(quizzes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(enrollments, isEnrolled(quizAttempts.userId, modules.courseId))
    .groupBy(quizAttempts.userId, quizAttempts.quizId)
    .as("best_attempts");

  return db
    .select({
      courseId: bestAttempts.courseId,
      bestScoreSum: sql<number>`sum(${bestAttempts.bestScore})`.as(
        "best_score_sum"
      ),
      bestScoreCount: sql<number>`count(*)`.as("best_score_count"),
    })
    .from(bestAttempts)
    .groupBy(bestAttempts.courseId)
    .as("quiz_score_stats");
}

function ratingStats() {
  return db
    .select({
      courseId: courseRatings.courseId,
      ratingSum: sql<number>`sum(${courseRatings.rating})`.as("rating_sum"),
      ratingCount: sql<number>`count(*)`.as("rating_count"),
    })
    .from(courseRatings)
    .groupBy(courseRatings.courseId)
    .as("rating_stats");
}

// ─── Monthly trends ───

const TREND_MONTHS = 12;

/** The 12 "YYYY-MM" UTC month keys ending in `now`'s month, oldest first. */
function trendMonths(now: Date): string[] {
  return Array.from({ length: TREND_MONTHS }, (_, i) => {
    const offset = TREND_MONTHS - 1 - i;
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1)
    );
    return d.toISOString().slice(0, 7);
  });
}

/** "YYYY-MM" of an ISO timestamp column, converted to UTC. */
function utcMonth(column: SQLiteColumn) {
  return sql<string>`strftime('%Y-%m', ${column})`;
}

/**
 * Revenue, new enrollments and completions per UTC month for the given
 * courses, for the 12 months ending in `now`'s month. Empty months are zero.
 */
function monthlyTrends(courseIds: number[], now: Date): MonthlyBucket[] {
  const months = trendMonths(now);
  const buckets = new Map<string, MonthlyBucket>(
    months.map((month) => [
      month,
      { month, revenueCents: 0, enrollments: 0, completions: 0 },
    ])
  );
  if (courseIds.length === 0) return [...buckets.values()];

  const firstMonth = months[0];
  const revenueMonth = utcMonth(purchases.createdAt);
  const revenue = db
    .select({
      month: revenueMonth,
      value: sql<number>`sum(${purchases.amountPaid})`,
    })
    .from(purchases)
    .where(
      and(inArray(purchases.courseId, courseIds), gte(revenueMonth, firstMonth))
    )
    .groupBy(revenueMonth)
    .all();

  const countByMonth = (column: SQLiteColumn) => {
    const month = utcMonth(column);
    return db
      .select({ month, value: sql<number>`count(*)` })
      .from(enrollments)
      .where(
        and(inArray(enrollments.courseId, courseIds), gte(month, firstMonth))
      )
      .groupBy(month)
      .all();
  };

  const fill = (
    field: Exclude<keyof MonthlyBucket, "month">,
    rows: { month: string; value: number }[]
  ) => {
    for (const row of rows) {
      const bucket = buckets.get(row.month);
      if (bucket) bucket[field] = row.value;
    }
  };

  fill("revenueCents", revenue);
  fill("enrollments", countByMonth(enrollments.enrolledAt));
  // strftime of a null completedAt is null, which the month filter drops.
  fill("completions", countByMonth(enrollments.completedAt));

  return [...buckets.values()];
}

// ─── Course breakdowns ───

export type QuizPerformance = {
  quizId: number;
  title: string;
  lessonTitle: string;
  /** Enrolled students who attempted the quiz. */
  students: number;
  /** 0–1, average of each student's best score. Null with no attempts. */
  averageScore: number | null;
  /** 0–1, share of best attempts that passed. Null with no attempts. */
  passRate: number | null;
};

/** Course order: module position, then lesson position (id breaks ties). */
const courseOrder = [modules.position, lessons.position, lessons.id] as const;

/** Every quiz in the course, in course order, scored on best attempts. */
function quizPerformance(courseId: number): QuizPerformance[] {
  const bestAttempts = db
    .select({
      quizId: quizAttempts.quizId,
      bestScore: sql<number>`max(${quizAttempts.score})`.as("best_score"),
      // SQLite takes a bare column alongside max() from the row holding the
      // max, so this is the best attempt's pass/fail as it was recorded.
      bestPassed: sql<number>`${quizAttempts.passed}`.as("best_passed"),
    })
    .from(quizAttempts)
    .innerJoin(enrollments, isEnrolled(quizAttempts.userId, courseId))
    .groupBy(quizAttempts.userId, quizAttempts.quizId)
    .as("best_attempts");

  const rows = db
    .select({
      quizId: quizzes.id,
      title: quizzes.title,
      lessonTitle: lessons.title,
      students: sql<number>`count(${bestAttempts.quizId})`,
      scoreSum: sql<number>`coalesce(sum(${bestAttempts.bestScore}), 0)`,
      passedCount: sql<number>`coalesce(sum(${bestAttempts.bestPassed}), 0)`,
    })
    .from(quizzes)
    .innerJoin(lessons, eq(quizzes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .leftJoin(bestAttempts, eq(bestAttempts.quizId, quizzes.id))
    .where(eq(modules.courseId, courseId))
    .groupBy(quizzes.id)
    .orderBy(...courseOrder, quizzes.id)
    .all();

  return rows.map((row) => ({
    quizId: row.quizId,
    title: row.title,
    lessonTitle: row.lessonTitle,
    students: row.students,
    averageScore: ratio(row.scoreSum, row.students),
    passRate: ratio(row.passedCount, row.students),
  }));
}

export type LessonDropOff = {
  lessonId: number;
  title: string;
  moduleTitle: string;
  /** 0–1, enrolled students who completed the lesson. Null with no students. */
  completionRate: number | null;
};

/** Every lesson in the course, in course order, with its completion share. */
function lessonDropOff(courseId: number, enrolled: number): LessonDropOff[] {
  const completions = db
    .select({
      lessonId: lessonProgress.lessonId,
      completed: sql<number>`count(*)`.as("completed"),
    })
    .from(lessonProgress)
    .innerJoin(enrollments, isEnrolled(lessonProgress.userId, courseId))
    .where(eq(lessonProgress.status, LessonProgressStatus.Completed))
    .groupBy(lessonProgress.lessonId)
    .as("lesson_completions");

  const rows = db
    .select({
      lessonId: lessons.id,
      title: lessons.title,
      moduleTitle: modules.title,
      completed: sql<number>`coalesce(${completions.completed}, 0)`,
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .leftJoin(completions, eq(completions.lessonId, lessons.id))
    .where(eq(modules.courseId, courseId))
    .orderBy(...courseOrder)
    .all();

  return rows.map((row) => ({
    lessonId: row.lessonId,
    title: row.title,
    moduleTitle: row.moduleTitle,
    completionRate: ratio(row.completed, enrolled),
  }));
}

export type VideoEngagement = {
  lessonId: number;
  title: string;
  moduleTitle: string;
  /** 0–1, enrolled students with at least one watch event. Null with no students. */
  startedRate: number | null;
  /**
   * 0–1, furthest position ÷ duration (capped at 1), averaged over students
   * who started. Null when nobody started.
   */
  averageShareWatched: number | null;
  /** 0–1, enrolled students who watched at least 90%. Null with no students. */
  finishedRate: number | null;
};

/**
 * Every lesson with a video URL and a duration, in course order. Lessons
 * missing either are skipped — there's nothing to measure a share against.
 */
function videoEngagement(
  courseId: number,
  enrolled: number
): VideoEngagement[] {
  // Each enrolled student's share of each video, capped at 100%.
  const shares = db
    .select({
      lessonId: videoWatchEvents.lessonId,
      share:
        sql<number>`min(1.0, max(${videoWatchEvents.positionSeconds}) / (${lessons.durationMinutes} * 60.0))`.as(
          "share"
        ),
    })
    .from(videoWatchEvents)
    .innerJoin(lessons, eq(videoWatchEvents.lessonId, lessons.id))
    .innerJoin(enrollments, isEnrolled(videoWatchEvents.userId, courseId))
    .groupBy(videoWatchEvents.userId, videoWatchEvents.lessonId)
    .as("video_shares");

  const rows = db
    .select({
      lessonId: lessons.id,
      title: lessons.title,
      moduleTitle: modules.title,
      started: sql<number>`count(${shares.lessonId})`,
      shareSum: sql<number>`coalesce(sum(${shares.share}), 0)`,
      finished: sql<number>`coalesce(sum(${shares.share} >= ${FINISHED_SHARE}), 0)`,
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .leftJoin(shares, eq(shares.lessonId, lessons.id))
    .where(
      and(
        eq(modules.courseId, courseId),
        isNotNull(lessons.videoUrl),
        ne(lessons.videoUrl, ""),
        gt(lessons.durationMinutes, 0)
      )
    )
    .groupBy(lessons.id)
    .orderBy(...courseOrder)
    .all();

  return rows.map((row) => ({
    lessonId: row.lessonId,
    title: row.title,
    moduleTitle: row.moduleTitle,
    startedRate: ratio(row.started, enrolled),
    averageShareWatched: ratio(row.shareSum, row.started),
    finishedRate: ratio(row.finished, enrolled),
  }));
}

// ─── Per-course metric rows ───

type CourseTotalsRow = MetricTotals & {
  courseId: number;
  title: string;
  status: CourseStatus;
};

/**
 * Every course's metric totals, filtered by `where` — which may refer to the
 * enrollment aggregate, e.g. to keep drafts only once someone is enrolled.
 */
function courseTotals(
  where: (enrollmentAgg: ReturnType<typeof enrollmentStats>) => SQL | undefined
): CourseTotalsRow[] {
  const enrollmentAgg = enrollmentStats();
  const revenueAgg = revenueStats();
  const lessonAgg = lessonCounts();
  const progressAgg = completedLessonStats();
  const quizAgg = quizScoreStats();
  const ratingAgg = ratingStats();

  return db
    .select({
      courseId: courses.id,
      title: courses.title,
      status: courses.status,
      students: sql<number>`coalesce(${enrollmentAgg.students}, 0)`,
      completedEnrollments: sql<number>`coalesce(${enrollmentAgg.completed}, 0)`,
      revenueCents: sql<number>`coalesce(${revenueAgg.revenueCents}, 0)`,
      // Every student in a course shares its lesson total, so summing their
      // completed ÷ total ratios is the course's completions ÷ its lessons.
      progressSum: sql<number>`coalesce(1.0 * ${progressAgg.completedLessons} / ${lessonAgg.lessons}, 0)`,
      progressStudents: sql<number>`case when ${lessonAgg.lessons} > 0 then coalesce(${enrollmentAgg.students}, 0) else 0 end`,
      bestScoreSum: sql<number>`coalesce(${quizAgg.bestScoreSum}, 0)`,
      bestScoreCount: sql<number>`coalesce(${quizAgg.bestScoreCount}, 0)`,
      ratingSum: sql<number>`coalesce(${ratingAgg.ratingSum}, 0)`,
      ratingCount: sql<number>`coalesce(${ratingAgg.ratingCount}, 0)`,
    })
    .from(courses)
    .leftJoin(enrollmentAgg, eq(enrollmentAgg.courseId, courses.id))
    .leftJoin(revenueAgg, eq(revenueAgg.courseId, courses.id))
    .leftJoin(lessonAgg, eq(lessonAgg.courseId, courses.id))
    .leftJoin(progressAgg, eq(progressAgg.courseId, courses.id))
    .leftJoin(quizAgg, eq(quizAgg.courseId, courses.id))
    .leftJoin(ratingAgg, eq(ratingAgg.courseId, courses.id))
    .where(where(enrollmentAgg))
    .orderBy(courses.title)
    .all();
}

// ─── Public API ───

/**
 * One row per course the instructor owns — published and archived always,
 * drafts only once someone has enrolled — plus a total row across them.
 * Also returns monthly trends across those courses, for the 12 months ending
 * in `now`'s month.
 */
export function getInstructorOverview(
  instructorId: number,
  now: Date
): InstructorOverview {
  const rows = courseTotals((enrollmentAgg) =>
    and(
      eq(courses.instructorId, instructorId),
      // Published and archived always; drafts only once someone is enrolled.
      or(
        ne(courses.status, CourseStatus.Draft),
        isNotNull(enrollmentAgg.courseId)
      )
    )
  );

  return {
    courses: rows.map((row) => ({
      courseId: row.courseId,
      title: row.title,
      status: row.status,
      ...toMetrics(row),
    })),
    total: toMetrics(sumTotals(rows)),
    trends: monthlyTrends(
      rows.map((row) => row.courseId),
      now
    ),
  };
}

export type CourseAnalytics = {
  headline: OverviewMetrics;
  /** The 12 calendar months up to and including the current one, oldest first. */
  trends: MonthlyBucket[];
  /** Every quiz in the course, in course order. */
  quizzes: QuizPerformance[];
  /** Every lesson in the course, in course order. */
  lessonDropOff: LessonDropOff[];
  /** Lessons with a video and a duration, in course order. */
  videoEngagement: VideoEngagement[];
};

/**
 * Headline numbers and monthly trends for one course, for the 12 months ending
 * in `now`'s month. Doesn't check the course exists — that's the caller's job.
 */
export function getCourseAnalytics(
  courseId: number,
  now: Date
): CourseAnalytics {
  const [row] = courseTotals(() => eq(courses.id, courseId));
  const enrolled = row?.students ?? 0;

  return {
    // An unknown course has no rows — report it as empty.
    headline: toMetrics(row ?? sumTotals([])),
    trends: monthlyTrends([courseId], now),
    quizzes: quizPerformance(courseId),
    lessonDropOff: lessonDropOff(courseId, enrolled),
    videoEngagement: videoEngagement(courseId, enrolled),
  };
}
