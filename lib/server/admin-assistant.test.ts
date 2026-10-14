import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { patientWhere: unknown[] } = { patientWhere: [] };
let patients: { id: string; name: string; lastVisitAt: Date | null; phones: { phone: string }[] }[] = [];

vi.mock("@/lib/db", () => ({
  prisma: {
    staff: { findMany: async () => [{ id: "s1", name: "Ирина Алилгаджиевна" }] },
    service: { findMany: async () => [{ id: "v1", title: "БОС-терапия" }] },
    patient: {
      findMany: async (args: { where: unknown }) => {
        calls.patientWhere.push(args.where);
        return patients;
      },
      findFirst: async () => null,
    },
  },
}));

const { answerAdmin } = await import("./admin-assistant");

const admin = { companyId: "c1", canSeeRevenue: true, canMessage: true, canViewOthers: true };

beforeEach(() => {
  calls.patientWhere = [];
  patients = [];
});

describe("поиск пациентов ассистентом", () => {
  it("врач без доступа к чужим ищет только среди своих приёмов", async () => {
    await answerAdmin("найди Диану", { ...admin, canViewOthers: false, ownStaffId: "s9" });
    const where = JSON.stringify(calls.patientWhere[0]);
    expect(where).toContain('"staffId":"s9"');
  });

  it("врач без карточки сотрудника не получает ничего", async () => {
    const a = await answerAdmin("найди Диану", { ...admin, canViewOthers: false, ownStaffId: null });
    expect(calls.patientWhere).toHaveLength(0);
    expect(a.text).toMatch(/доступом к карточкам/);
  });

  it("несколько совпадений — список и вопрос, без выбора", async () => {
    patients = [
      { id: "p1", name: "Алиева Диана", lastVisitAt: null, phones: [{ phone: "+79280000001" }] },
      { id: "p2", name: "Магомедова Диана", lastVisitAt: null, phones: [] },
    ];
    const a = await answerAdmin("найди Диану", admin);
    expect(a.text).toMatch(/1\. Алиева Диана · …0001/);
    expect(a.text).toMatch(/сам я не выбираю/);
    expect(a.memory).toEqual({ focus: null, candidates: [{ id: "p1", name: "Алиева Диана" }, { id: "p2", name: "Магомедова Диана" }], lastText: null });
  });

  it("местоимение при двух кандидатах — снова список, а не догадка", async () => {
    const a = await answerAdmin("а ей напиши: перенос на понедельник", {
      ...admin,
      memory: { focus: null, candidates: [{ id: "p1", name: "Алиева Диана" }, { id: "p2", name: "Магомедова Диана" }], lastText: null },
    });
    expect(a.plan).toBeUndefined();
    expect(a.text).toMatch(/Уточните, о ком речь/);
  });

  it("рассылка «всем пациентам» без условия не готовится", async () => {
    const a = await answerAdmin("напиши всем пациентам: клиника завтра не работает", admin);
    expect(a.plan).toBeUndefined();
    expect(a.text).toMatch(/без условия я не рассылаю/);
  });
});
