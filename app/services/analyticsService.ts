import { and, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import { db } from "~/db";
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

export type InstructorOverview = {
  courses: CourseOverviewRow[];
  total: OverviewMetrics;
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

// ─── Per-course aggregates ───

function enrollmentStats() {
  return db
    .select({
      courseId: enrollments.courseId,
      students: sql<number>`count(*)`.as("students"),
      completed: sql<number>`count(${enrollments.completedAt})`.as(
        "completed"
      ),
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
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.userId, lessonProgress.userId),
        eq(enrollments.courseId, modules.courseId)
      )
    )
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
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.userId, quizAttempts.userId),
        eq(enrollments.courseId, modules.courseId)
      )
    )
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

// ─── Public API ───

/**
 * One row per course the instructor owns — published and archived always,
 * drafts only once someone has enrolled — plus a total row across them.
 *
 * `now` is unused for now — it will anchor the 12-month trends window (#5).
 */
export function getInstructorOverview(
  instructorId: number,
  now: Date
): InstructorOverview {
  const enrollmentAgg = enrollmentStats();
  const revenueAgg = revenueStats();
  const lessonAgg = lessonCounts();
  const progressAgg = completedLessonStats();
  const quizAgg = quizScoreStats();
  const ratingAgg = ratingStats();

  const rows = db
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
    .where(
      and(
        eq(courses.instructorId, instructorId),
        // Published and archived always; drafts only once someone is enrolled.
        or(
          ne(courses.status, CourseStatus.Draft),
          isNotNull(enrollmentAgg.courseId)
        )
      )
    )
    .orderBy(courses.title)
    .all();

  return {
    courses: rows.map((row) => ({
      courseId: row.courseId,
      title: row.title,
      status: row.status,
      ...toMetrics(row),
    })),
    total: toMetrics(sumTotals(rows)),
  };
}
