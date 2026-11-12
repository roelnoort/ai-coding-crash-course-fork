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
import { getInstructorOverview } from "./analyticsService";
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

function createQuiz(lessonId: number) {
  return testDb
    .insert(schema.quizzes)
    .values({ lessonId, title: "Quiz", passingScore: 0.7 })
    .returning()
    .get();
}

function attemptQuiz(userId: number, quizId: number, score: number) {
  testDb
    .insert(schema.quizAttempts)
    .values({ userId, quizId, score, passed: score >= 0.7 })
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

      expect(getInstructorOverview(newInstructor.id, NOW)).toEqual({
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
