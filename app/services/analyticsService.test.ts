import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import { getCourseAnalytics, getInstructorOverview } from "./analyticsService";
import { createPurchase, createTeamPurchase } from "./purchaseService";
import { redeemCoupon } from "./couponService";

const NOW = new Date("2026-06-15T12:00:00Z");

let userCounter = 0;
function createStudent() {
  userCounter++;
  return testDb
    .insert(schema.users)
    .values({
      name: `Student ${userCounter}`,
      email: `student${userCounter}@example.com`,
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
}

function createCourse(
  instructorId: number,
  slug: string,
  status = schema.CourseStatus.Published
) {
  return testDb
    .insert(schema.courses)
    .values({
      title: `Course ${slug}`,
      slug,
      description: "A course",
      salesCopy: "Sales copy",
      instructorId,
      categoryId: base.category.id,
      status,
    })
    .returning()
    .get();
}

function enroll(
  userId: number,
  courseId: number,
  completedAt: string | null = null
) {
  return testDb
    .insert(schema.enrollments)
    .values({ userId, courseId, completedAt })
    .returning()
    .get();
}

function createModule(courseId: number, position = 1) {
  return testDb
    .insert(schema.modules)
    .values({ courseId, title: `Module ${position}`, position })
    .returning()
    .get();
}

function createLessons(moduleId: number, count: number) {
  return Array.from({ length: count }, (_, i) =>
    testDb
      .insert(schema.lessons)
      .values({ moduleId, title: `Lesson ${i + 1}`, position: i + 1 })
      .returning()
      .get()
  );
}

function completeLesson(userId: number, lessonId: number) {
  testDb
    .insert(schema.lessonProgress)
    .values({
      userId,
      lessonId,
      status: schema.LessonProgressStatus.Completed,
      completedAt: "2026-06-01T00:00:00Z",
    })
    .run();
}

function createVideoLesson(
  moduleId: number,
  position: number,
  video: { videoUrl?: string | null; durationMinutes?: number | null } = {}
) {
  return testDb
    .insert(schema.lessons)
    .values({
      moduleId,
      title: `Video ${position}`,
      position,
      videoUrl: "https://example.com/video.mp4",
      durationMinutes: 10,
      ...video,
    })
    .returning()
    .get();
}

function watch(userId: number, lessonId: number, positionSeconds: number) {
  testDb
    .insert(schema.videoWatchEvents)
    .values({ userId, lessonId, eventType: "progress", positionSeconds })
    .run();
}

function createQuiz(lessonId: number) {
  return testDb
    .insert(schema.quizzes)
    .values({ lessonId, title: "Quiz", passingScore: 0.7 })
    .returning()
    .get();
}

function attemptQuiz(
  userId: number,
  quizId: number,
  score: number,
  passed = score >= 0.7
) {
  testDb
    .insert(schema.quizAttempts)
    .values({ userId, quizId, score, passed })
    .run();
}

function purchaseAt(courseId: number, amountPaid: number, createdAt: string) {
  testDb
    .insert(schema.purchases)
    .values({
      userId: createStudent().id,
      courseId,
      amountPaid,
      country: "US",
      createdAt,
    })
    .run();
}

function enrollAt(
  courseId: number,
  enrolledAt: string,
  completedAt: string | null = null
) {
  testDb
    .insert(schema.enrollments)
    .values({ userId: createStudent().id, courseId, enrolledAt, completedAt })
    .run();
}

function overviewRow(courseId: number) {
  const overview = getInstructorOverview(base.instructor.id, NOW);
  const row = overview.courses.find((c) => c.courseId === courseId);
  if (!row) throw new Error(`Course ${courseId} not in overview`);
  return row;
}

describe("analyticsService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("getInstructorOverview", () => {
    it("counts every enrollment as a student", () => {
      enroll(base.user.id, base.course.id);
      enroll(createStudent().id, base.course.id);
      enroll(createStudent().id, base.course.id);

      expect(overviewRow(base.course.id).students).toBe(3);
    });

    it("sums what buyers actually paid, after PPP discounts", () => {
      const buyer = createStudent();
      createPurchase(base.user.id, base.course.id, 4999, "US");
      createPurchase(buyer.id, base.course.id, 1250, "IN");

      expect(overviewRow(base.course.id).revenueCents).toBe(6249);
    });

    it("counts a team purchase once, in full, and its claimed seats as students", () => {
      const buyer = createStudent();
      const { coupons } = createTeamPurchase(
        buyer.id,
        base.course.id,
        30000,
        "US",
        3
      );
      redeemCoupon(coupons[0].code, createStudent().id, "US");
      redeemCoupon(coupons[1].code, createStudent().id, "US");

      const row = overviewRow(base.course.id);
      expect(row.revenueCents).toBe(30000);
      expect(row.students).toBe(2);
    });

    it("reports zero revenue for a course nobody has paid for", () => {
      enroll(base.user.id, base.course.id);

      expect(overviewRow(base.course.id).revenueCents).toBe(0);
    });

    it("reports the share of enrollments that are completed", () => {
      enroll(base.user.id, base.course.id, "2026-05-01T00:00:00Z");
      enroll(createStudent().id, base.course.id);
      enroll(createStudent().id, base.course.id);
      enroll(createStudent().id, base.course.id, "2026-06-01T00:00:00Z");

      expect(overviewRow(base.course.id).completionRate).toBe(0.5);
    });

    it("averages each enrolled student's share of completed lessons", () => {
      const mod = createModule(base.course.id);
      const lessons = createLessons(mod.id, 4);
      const halfway = createStudent();
      const untouched = createStudent();
      enroll(base.user.id, base.course.id);
      enroll(halfway.id, base.course.id);
      enroll(untouched.id, base.course.id);

      for (const lesson of lessons) completeLesson(base.user.id, lesson.id);
      completeLesson(halfway.id, lessons[0].id);
      completeLesson(halfway.id, lessons[1].id);
      // In-progress lessons don't count towards progress.
      testDb
        .insert(schema.lessonProgress)
        .values({
          userId: halfway.id,
          lessonId: lessons[2].id,
          status: schema.LessonProgressStatus.InProgress,
        })
        .run();

      // (1 + 0.5 + 0) / 3
      expect(overviewRow(base.course.id).averageProgress).toBe(0.5);
    });

    it("ignores progress on other courses' lessons", () => {
      const otherCourse = createCourse(base.instructor.id, "other");
      const otherLessons = createLessons(createModule(otherCourse.id).id, 2);
      createLessons(createModule(base.course.id).id, 2);
      enroll(base.user.id, base.course.id);
      completeLesson(base.user.id, otherLessons[0].id);

      expect(overviewRow(base.course.id).averageProgress).toBe(0);
    });

    it("averages each student's best attempt per quiz across the course's quizzes", () => {
      const [lessonA, lessonB] = createLessons(
        createModule(base.course.id).id,
        2
      );
      const quizA = createQuiz(lessonA.id);
      const quizB = createQuiz(lessonB.id);
      const other = createStudent();
      enroll(base.user.id, base.course.id);
      enroll(other.id, base.course.id);

      // Retries: only the best attempt counts.
      attemptQuiz(base.user.id, quizA.id, 0.4);
      attemptQuiz(base.user.id, quizA.id, 0.8);
      attemptQuiz(base.user.id, quizA.id, 0.6);
      attemptQuiz(base.user.id, quizB.id, 1.0);
      attemptQuiz(other.id, quizA.id, 0.5);
      attemptQuiz(other.id, quizB.id, 0.3);
      attemptQuiz(other.id, quizB.id, 0.5);

      // Best scores: 0.8, 1.0, 0.5, 0.5 → mean 0.7
      expect(overviewRow(base.course.id).averageQuizScore).toBeCloseTo(0.7);
    });

    it("ignores quiz attempts from people not enrolled in the course", () => {
      const [lesson] = createLessons(createModule(base.course.id).id, 1);
      const quiz = createQuiz(lesson.id);
      enroll(base.user.id, base.course.id);
      attemptQuiz(base.user.id, quiz.id, 0.9);
      attemptQuiz(base.instructor.id, quiz.id, 0.1);

      expect(overviewRow(base.course.id).averageQuizScore).toBeCloseTo(0.9);
    });

    it("averages the course's ratings", () => {
      for (const rating of [5, 4, 2]) {
        testDb
          .insert(schema.courseRatings)
          .values({
            userId: createStudent().id,
            courseId: base.course.id,
            rating,
          })
          .run();
      }

      expect(overviewRow(base.course.id).averageRating).toBeCloseTo(11 / 3);
    });

    it("includes published and archived courses, and drafts only once someone is enrolled", () => {
      const archived = createCourse(
        base.instructor.id,
        "archived",
        schema.CourseStatus.Archived
      );
      const emptyDraft = createCourse(
        base.instructor.id,
        "empty-draft",
        schema.CourseStatus.Draft
      );
      const enrolledDraft = createCourse(
        base.instructor.id,
        "enrolled-draft",
        schema.CourseStatus.Draft
      );
      enroll(base.user.id, enrolledDraft.id);

      const ids = getInstructorOverview(base.instructor.id, NOW).courses.map(
        (c) => c.courseId
      );

      expect(ids).toHaveLength(3);
      expect(ids).toEqual(
        expect.arrayContaining([base.course.id, archived.id, enrolledDraft.id])
      );
      expect(ids).not.toContain(emptyDraft.id);
    });

    it("reports no-data averages as null rather than zero", () => {
      createLessons(createModule(base.course.id).id, 3);

      expect(overviewRow(base.course.id)).toMatchObject({
        students: 0,
        revenueCents: 0,
        completionRate: null,
        averageProgress: null,
        averageQuizScore: null,
        averageRating: null,
      });
    });

    it("reports progress as null for a course with students but no lessons", () => {
      enroll(base.user.id, base.course.id);

      expect(overviewRow(base.course.id).averageProgress).toBeNull();
    });

    it("returns no courses and an empty total for an instructor with none", () => {
      const newInstructor = testDb
        .insert(schema.users)
        .values({
          name: "New Instructor",
          email: "new-instructor@example.com",
          role: schema.UserRole.Instructor,
        })
        .returning()
        .get();

      const { courses, total } = getInstructorOverview(newInstructor.id, NOW);

      expect({ courses, total }).toEqual({
        courses: [],
        total: {
          students: 0,
          revenueCents: 0,
          completionRate: null,
          averageProgress: null,
          averageQuizScore: null,
          averageRating: null,
        },
      });
    });

    it("totals every included course, pooling students rather than averaging course averages", () => {
      // Course A: 2 students, 4 lessons
      const lessonsA = createLessons(createModule(base.course.id).id, 4);
      const quizA = createQuiz(lessonsA[0].id);
      const idle = createStudent();
      enroll(base.user.id, base.course.id, "2026-05-01T00:00:00Z");
      enroll(idle.id, base.course.id);
      for (const lesson of lessonsA) completeLesson(base.user.id, lesson.id);
      attemptQuiz(base.user.id, quizA.id, 1.0);
      createPurchase(base.user.id, base.course.id, 5000, "US");
      testDb
        .insert(schema.courseRatings)
        .values({ userId: base.user.id, courseId: base.course.id, rating: 5 })
        .run();

      // Course B: 3 students, 2 lessons
      const courseB = createCourse(base.instructor.id, "course-b");
      const lessonsB = createLessons(createModule(courseB.id).id, 2);
      const quizB = createQuiz(lessonsB[0].id);
      const [finisher, almost, absent] = [
        createStudent(),
        createStudent(),
        createStudent(),
      ];
      enroll(finisher.id, courseB.id, "2026-06-01T00:00:00Z");
      enroll(almost.id, courseB.id);
      enroll(absent.id, courseB.id);
      for (const lesson of lessonsB) {
        completeLesson(finisher.id, lesson.id);
        completeLesson(almost.id, lesson.id);
      }
      attemptQuiz(finisher.id, quizB.id, 0.4);
      attemptQuiz(almost.id, quizB.id, 0.4);
      createPurchase(finisher.id, courseB.id, 2000, "US");
      createPurchase(almost.id, courseB.id, 1000, "IN");
      for (const student of [finisher, almost]) {
        testDb
          .insert(schema.courseRatings)
          .values({ userId: student.id, courseId: courseB.id, rating: 2 })
          .run();
      }

      const { total } = getInstructorOverview(base.instructor.id, NOW);

      expect(total.students).toBe(5);
      expect(total.revenueCents).toBe(8000);
      expect(total.completionRate).toBeCloseTo(2 / 5);
      // Per student: 1, 0, 1, 1, 0
      expect(total.averageProgress).toBeCloseTo(3 / 5);
      // Best attempts: 1.0, 0.4, 0.4
      expect(total.averageQuizScore).toBeCloseTo(0.6);
      // Ratings: 5, 2, 2
      expect(total.averageRating).toBeCloseTo(3);
    });

    it("returns only the given instructor's courses", () => {
      const otherInstructor = testDb
        .insert(schema.users)
        .values({
          name: "Other Instructor",
          email: "other-instructor@example.com",
          role: schema.UserRole.Instructor,
        })
        .returning()
        .get();
      const theirCourse = createCourse(otherInstructor.id, "theirs");
      enroll(base.user.id, theirCourse.id);
      createPurchase(base.user.id, theirCourse.id, 9999, "US");

      const overview = getInstructorOverview(base.instructor.id, NOW);

      expect(overview.courses.map((c) => c.courseId)).toEqual([base.course.id]);
    });
  });
});

describe("monthly trends", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  function trends() {
    return getInstructorOverview(base.instructor.id, NOW).trends;
  }

  it("covers exactly the 12 calendar months ending in the current month, zero-filled", () => {
    expect(trends().map((b) => b.month)).toEqual([
      "2025-07",
      "2025-08",
      "2025-09",
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
    ]);
    for (const bucket of trends()) {
      expect(bucket).toMatchObject({
        revenueCents: 0,
        enrollments: 0,
        completions: 0,
      });
    }
  });

  function bucket(month: string) {
    const found = trends().find((b) => b.month === month);
    if (!found) throw new Error(`No bucket for ${month}`);
    return found;
  }

  it("buckets revenue by the UTC month it was paid in", () => {
    purchaseAt(base.course.id, 1000, "2026-06-01T00:00:00.000Z");
    purchaseAt(base.course.id, 2000, "2026-05-31T23:59:59.999Z");
    purchaseAt(base.course.id, 500, "2026-05-02T10:00:00.000Z");
    purchaseAt(base.course.id, 300, "2025-07-01T00:00:00.000Z");
    // Before the window: June last year.
    purchaseAt(base.course.id, 9999, "2025-06-30T23:59:59.999Z");

    expect(bucket("2026-06").revenueCents).toBe(1000);
    expect(bucket("2026-05").revenueCents).toBe(2500);
    expect(bucket("2025-07").revenueCents).toBe(300);
    expect(trends().reduce((sum, b) => sum + b.revenueCents, 0)).toBe(3800);
  });

  it("buckets new enrollments by the UTC month they enrolled in", () => {
    enrollAt(base.course.id, "2026-06-01T00:00:00.000Z");
    enrollAt(base.course.id, "2026-06-14T08:00:00.000Z");
    enrollAt(base.course.id, "2026-05-31T23:59:59.999Z");
    enrollAt(base.course.id, "2025-06-30T23:59:59.999Z");

    expect(bucket("2026-06").enrollments).toBe(2);
    expect(bucket("2026-05").enrollments).toBe(1);
    expect(trends().reduce((sum, b) => sum + b.enrollments, 0)).toBe(3);
  });

  it("buckets completions by the UTC month the enrollment was completed in", () => {
    // Enrolled before the window, completed inside it.
    enrollAt(
      base.course.id,
      "2025-01-10T00:00:00.000Z",
      "2025-08-01T00:00:00.000Z"
    );
    enrollAt(
      base.course.id,
      "2026-03-01T00:00:00.000Z",
      "2026-04-30T23:59:59.999Z"
    );
    enrollAt(
      base.course.id,
      "2026-03-01T00:00:00.000Z",
      "2026-05-01T00:00:00.000Z"
    );
    enrollAt(base.course.id, "2026-03-01T00:00:00.000Z");

    expect(bucket("2025-08").completions).toBe(1);
    expect(bucket("2026-04").completions).toBe(1);
    expect(bucket("2026-05").completions).toBe(1);
    expect(bucket("2026-03").completions).toBe(0);
    expect(trends().reduce((sum, b) => sum + b.completions, 0)).toBe(3);
  });

  it("adds up the instructor's included courses only", () => {
    const second = createCourse(base.instructor.id, "second");
    const emptyDraft = createCourse(
      base.instructor.id,
      "empty-draft",
      schema.CourseStatus.Draft
    );
    const otherInstructor = testDb
      .insert(schema.users)
      .values({
        name: "Other Instructor",
        email: "other-instructor@example.com",
        role: schema.UserRole.Instructor,
      })
      .returning()
      .get();
    const theirs = createCourse(otherInstructor.id, "theirs");

    for (const courseId of [base.course.id, second.id, theirs.id]) {
      enrollAt(
        courseId,
        "2026-06-02T00:00:00.000Z",
        "2026-06-10T00:00:00.000Z"
      );
      purchaseAt(courseId, 1000, "2026-06-02T00:00:00.000Z");
    }
    // A draft nobody is enrolled in isn't included, even if a purchase exists.
    purchaseAt(emptyDraft.id, 5000, "2026-06-03T00:00:00.000Z");

    expect(bucket("2026-06")).toEqual({
      month: "2026-06",
      revenueCents: 2000,
      enrollments: 2,
      completions: 2,
    });
  });
});

describe("getCourseAnalytics", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  it("reports the course's headline numbers", () => {
    const lessons = createLessons(createModule(base.course.id).id, 2);
    const quiz = createQuiz(lessons[0].id);
    const idle = createStudent();
    enroll(base.user.id, base.course.id, "2026-05-01T00:00:00Z");
    enroll(idle.id, base.course.id);
    for (const lesson of lessons) completeLesson(base.user.id, lesson.id);
    attemptQuiz(base.user.id, quiz.id, 0.5);
    attemptQuiz(base.user.id, quiz.id, 0.9);
    createPurchase(base.user.id, base.course.id, 4000, "US");
    createPurchase(idle.id, base.course.id, 2000, "IN");
    for (const [userId, rating] of [
      [base.user.id, 5],
      [idle.id, 4],
    ]) {
      testDb
        .insert(schema.courseRatings)
        .values({ userId, courseId: base.course.id, rating })
        .run();
    }

    // Another course of the same instructor must not leak in.
    const other = createCourse(base.instructor.id, "other");
    enroll(createStudent().id, other.id);
    createPurchase(base.user.id, other.id, 7777, "US");

    const { headline } = getCourseAnalytics(base.course.id, NOW);

    expect(headline.students).toBe(2);
    expect(headline.revenueCents).toBe(6000);
    expect(headline.completionRate).toBe(0.5);
    expect(headline.averageProgress).toBe(0.5);
    expect(headline.averageQuizScore).toBeCloseTo(0.9);
    expect(headline.averageRating).toBeCloseTo(4.5);
  });

  it("reports no-data averages as null for a course without students", () => {
    expect(getCourseAnalytics(base.course.id, NOW).headline).toEqual({
      students: 0,
      revenueCents: 0,
      completionRate: null,
      averageProgress: null,
      averageQuizScore: null,
      averageRating: null,
    });
  });

  it("reports monthly trends for that course only", () => {
    const other = createCourse(base.instructor.id, "other");
    for (const courseId of [base.course.id, other.id]) {
      enrollAt(
        courseId,
        "2026-04-10T00:00:00.000Z",
        "2026-05-20T00:00:00.000Z"
      );
      purchaseAt(courseId, 1500, "2026-04-10T00:00:00.000Z");
    }

    const { trends } = getCourseAnalytics(base.course.id, NOW);

    expect(trends).toHaveLength(12);
    expect(trends.at(-1)?.month).toBe("2026-06");
    expect(trends.find((b) => b.month === "2026-04")).toMatchObject({
      revenueCents: 1500,
      enrollments: 1,
      completions: 0,
    });
    expect(trends.find((b) => b.month === "2026-05")).toMatchObject({
      revenueCents: 0,
      enrollments: 0,
      completions: 1,
    });
  });
});

describe("getCourseAnalytics breakdowns", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("quiz performance", () => {
    it("uses each student's best attempt, not the first or the last", () => {
      const [lesson] = createLessons(createModule(base.course.id).id, 1);
      const quiz = createQuiz(lesson.id);
      const other = createStudent();
      enroll(base.user.id, base.course.id);
      enroll(other.id, base.course.id);
      attemptQuiz(base.user.id, quiz.id, 0.4);
      attemptQuiz(base.user.id, quiz.id, 0.8);
      attemptQuiz(base.user.id, quiz.id, 0.6);
      attemptQuiz(other.id, quiz.id, 0.6);

      const { quizzes } = getCourseAnalytics(base.course.id, NOW);

      expect(quizzes).toHaveLength(1);
      expect(quizzes[0].quizId).toBe(quiz.id);
      expect(quizzes[0].averageScore).toBeCloseTo(0.7);
    });

    it("bases the pass rate on best attempts", () => {
      const [lesson] = createLessons(createModule(base.course.id).id, 1);
      const quiz = createQuiz(lesson.id); // passes at 0.7
      const retried = createStudent();
      const failed = createStudent();
      for (const student of [base.user, retried, failed]) {
        enroll(student.id, base.course.id);
      }
      attemptQuiz(base.user.id, quiz.id, 0.9);
      // Passed, then failed a later retry — the best attempt still passed.
      attemptQuiz(retried.id, quiz.id, 0.75);
      attemptQuiz(retried.id, quiz.id, 0.3);
      attemptQuiz(failed.id, quiz.id, 0.5);
      attemptQuiz(failed.id, quiz.id, 0.6);

      const [stats] = getCourseAnalytics(base.course.id, NOW).quizzes;

      expect(stats.students).toBe(3);
      expect(stats.passRate).toBeCloseTo(2 / 3);
    });

    it("takes pass or fail from the best attempt as it was recorded", () => {
      const [lesson] = createLessons(createModule(base.course.id).id, 1);
      const quiz = createQuiz(lesson.id); // passingScore 0.7
      enroll(base.user.id, base.course.id);
      // Scored at the passing score, but recorded as a fail.
      attemptQuiz(base.user.id, quiz.id, 0.7, false);

      const [stats] = getCourseAnalytics(base.course.id, NOW).quizzes;

      expect(stats.passRate).toBe(0);
    });

    it("lists quizzes nobody has attempted, with no-data averages", () => {
      const lessons = createLessons(createModule(base.course.id).id, 2);
      const attempted = createQuiz(lessons[0].id);
      const untouched = createQuiz(lessons[1].id);
      enroll(base.user.id, base.course.id);
      attemptQuiz(base.user.id, attempted.id, 1);

      const { quizzes } = getCourseAnalytics(base.course.id, NOW);

      expect(quizzes.map((q) => q.quizId)).toEqual([
        attempted.id,
        untouched.id,
      ]);
      expect(quizzes[1]).toMatchObject({
        students: 0,
        averageScore: null,
        passRate: null,
      });
    });
  });

  describe("lesson drop-off", () => {
    it("reports the share of enrolled students completing each lesson, in course order", () => {
      // Module 2 is created first so insertion order differs from course order.
      const second = createModule(base.course.id, 2);
      const first = createModule(base.course.id, 1);
      const [m2l1] = createLessons(second.id, 1);
      const [m1l1, m1l2] = createLessons(first.id, 2);
      const students = [
        base.user,
        createStudent(),
        createStudent(),
        createStudent(),
      ];
      for (const student of students) enroll(student.id, base.course.id);
      for (const student of students) completeLesson(student.id, m1l1.id);
      completeLesson(students[0].id, m1l2.id);
      completeLesson(students[1].id, m1l2.id);
      completeLesson(students[0].id, m2l1.id);
      // A non-enrolled user's progress doesn't count.
      completeLesson(base.instructor.id, m2l1.id);

      const { lessonDropOff } = getCourseAnalytics(base.course.id, NOW);

      expect(lessonDropOff.map((l) => [l.lessonId, l.completionRate])).toEqual([
        [m1l1.id, 1],
        [m1l2.id, 0.5],
        [m2l1.id, 0.25],
      ]);
    });

    it("reports no-data completion when nobody is enrolled", () => {
      const [lesson] = createLessons(createModule(base.course.id).id, 1);

      const { lessonDropOff } = getCourseAnalytics(base.course.id, NOW);

      expect(lessonDropOff).toEqual([
        expect.objectContaining({ lessonId: lesson.id, completionRate: null }),
      ]);
    });
  });

  describe("video engagement", () => {
    it("reports started share, average share watched over starters, and finished share", () => {
      const lesson = createVideoLesson(createModule(base.course.id).id, 1); // 600s
      const [half, full, idle, never] = [
        base.user,
        createStudent(),
        createStudent(),
        createStudent(),
      ];
      for (const s of [half, full, idle, never]) enroll(s.id, base.course.id);
      // The furthest position reached counts, not the latest event.
      watch(half.id, lesson.id, 300);
      watch(half.id, lesson.id, 120);
      watch(full.id, lesson.id, 600);
      watch(idle.id, lesson.id, 0);
      // A non-enrolled viewer doesn't count.
      watch(base.instructor.id, lesson.id, 600);

      const { videoEngagement } = getCourseAnalytics(base.course.id, NOW);

      expect(videoEngagement).toHaveLength(1);
      expect(videoEngagement[0].lessonId).toBe(lesson.id);
      expect(videoEngagement[0].startedRate).toBe(0.75);
      // (0.5 + 1 + 0) / 3 starters — the student who never started is excluded.
      expect(videoEngagement[0].averageShareWatched).toBeCloseTo(0.5);
      expect(videoEngagement[0].finishedRate).toBe(0.25);
    });

    it("counts exactly 90% as finished and just under as not", () => {
      const lesson = createVideoLesson(createModule(base.course.id).id, 1); // 600s
      const atThreshold = base.user;
      const justUnder = createStudent();
      enroll(atThreshold.id, base.course.id);
      enroll(justUnder.id, base.course.id);
      watch(atThreshold.id, lesson.id, 540);
      watch(justUnder.id, lesson.id, 539);

      const [video] = getCourseAnalytics(base.course.id, NOW).videoEngagement;

      expect(video.finishedRate).toBe(0.5);
    });

    it("caps a student's share watched at 100%", () => {
      const lesson = createVideoLesson(createModule(base.course.id).id, 1); // 600s
      const other = createStudent();
      enroll(base.user.id, base.course.id);
      enroll(other.id, base.course.id);
      watch(base.user.id, lesson.id, 1200);
      watch(other.id, lesson.id, 300);

      const [video] = getCourseAnalytics(base.course.id, NOW).videoEngagement;

      expect(video.averageShareWatched).toBeCloseTo(0.75);
    });

    it("skips lessons without a video or without a duration", () => {
      const moduleId = createModule(base.course.id).id;
      createVideoLesson(moduleId, 1, { videoUrl: null });
      createVideoLesson(moduleId, 2, { durationMinutes: null });
      const video = createVideoLesson(moduleId, 3);
      enroll(base.user.id, base.course.id);

      const { videoEngagement } = getCourseAnalytics(base.course.id, NOW);

      expect(videoEngagement.map((v) => v.lessonId)).toEqual([video.id]);
      expect(videoEngagement[0]).toMatchObject({
        startedRate: 0,
        averageShareWatched: null,
        finishedRate: 0,
      });
    });
  });
});
