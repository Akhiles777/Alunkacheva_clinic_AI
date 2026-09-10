import { describe, expect, it } from "vitest";
import { glanceOf, type GlanceCourse, type GlanceVisit } from "./patient-glance";

const now = new Date("2026-09-10T09:00:00Z");

const visit = (p: Partial<GlanceVisit>): GlanceVisit => ({
  status: "arrived",
  at: "2026-09-01T09:00:00Z",
  amount: 8000,
  service: "Остеопатия",
  doctor: "Ирина",
  ...p,
});

describe("что видно про пациента с первого взгляда", () => {
  it("ближайшая запись — самая ранняя из будущих", () => {
    const g = glanceOf(
      [
        visit({ status: "planned", at: "2026-09-20T09:00:00Z", service: "БОС" }),
        visit({ status: "planned", at: "2026-09-12T09:00:00Z", service: "Остеопатия" }),
        visit({ status: "planned", at: "2026-09-01T09:00:00Z", service: "Прошлое" }),
      ],
      [],
      now,
    );
    expect(g.next?.service).toBe("Остеопатия");
  });

  it("неявки — факт с основанием, а не процент риска", () => {
    const g = glanceOf(
      [
        visit({ status: "no_show" }),
        visit({ status: "no_show" }),
        visit({}),
        visit({}),
        visit({}),
      ],
      [],
      now,
    );
    expect(g.noShow).toEqual({ count: 2, of: 5 });
  });

  it("по двум визитам о неявках не говорим", () => {
    const g = glanceOf([visit({ status: "no_show" }), visit({})], [], now);
    expect(g.noShow).toBeNull();
  });

  it("идущий курс показывается с прогрессом и записанными вперёд", () => {
    const courses: GlanceCourse[] = [
      { title: "БОС-терапия", used: 4, total: 10, booked: 2, status: "active" },
      { title: "Старый курс", used: 10, total: 10, status: "done" },
    ];
    const g = glanceOf([], courses, now);
    expect(g.course).toEqual({ title: "БОС-терапия", used: 4, total: 10, booked: 2, stalled: false });
  });

  it("долг считается только там, где оплату вообще отмечают", () => {
    /** Ни одной отметки оплаты — значит их не ставят, а не «никто не платил». */
    const noMarks = glanceOf([visit({}), visit({}), visit({})], [], now);
    expect(noMarks.owes).toBeNull();

    const withMarks = glanceOf(
      [visit({ paidEarlier: true }), visit({ amount: 5000 }), visit({ amount: 3000 })],
      [],
      now,
    );
    expect(withMarks.owes).toEqual({ amount: 8000, visits: 2 });
  });

  it("покупка курса — не визит и в счёт не идёт", () => {
    const g = glanceOf(
      [visit({ kind: "purchase", amount: 28000, paidEarlier: true }), visit({ paidEarlier: true })],
      [],
      now,
    );
    expect(g.owes).toBeNull();
    expect(g.noShow).toBeNull();
  });

  it("пустая история ничего не утверждает", () => {
    const g = glanceOf([], [], now);
    expect(g).toEqual({ next: null, noShow: null, course: null, owes: null });
  });
});
