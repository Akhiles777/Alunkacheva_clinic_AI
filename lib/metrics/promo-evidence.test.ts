import { describe, expect, it } from "vitest";
import { buildEvidenceInput, evidencePrompt, maskForModel, parseEvidenceAnswer, verifyEvidence, type DialogMessageForCheck } from "./promo-evidence";

const at = (m: number) => new Date(Date.UTC(2026, 9, 20, 7, m));
const msg = (id: string, i: number, authorType: DialogMessageForCheck["authorType"], body: string): DialogMessageForCheck => ({
  id,
  direction: authorType === "PATIENT" ? "IN" : "OUT",
  authorType,
  body,
  createdAt: at(i),
});

const dialog = [
  msg("a", 1, "PATIENT", "Здравствуйте, нам в школе Росток сказали, что у вас школьный ресурс"),
  msg("b", 2, "BOT", "Здравствуйте! Школьный ресурс — 6300 ₽. Подскажите, вы узнали о нас от школы подготовки?"),
  msg("c", 3, "OUT" as never, "x"),
  msg("d", 4, "STAFF", "Вы записаны на услугу Школьный ресурс 6+ к специалисту Ирина Алилгаджиевна на 21 октября 2026 в 10:30."),
  msg("e", 5, "PATIENT", "Моя дочь Амина, телефон +7 928 516 95 12, почта mama@mail.ru"),
];
dialog[2] = msg("c", 3, "PATIENT", "Да, от Ростока");

describe("улика школы в переписке", () => {
  it("модели уходят первые сообщения без уведомлений YCLIENTS, без телефона, почты и имён; слова школы остаются", () => {
    const input = buildEvidenceInput(dialog, "Школа подготовки «Росток»", ["Росток"], ["Ибрагимова Амина"]);
    const text = input.lines.join("\n");
    expect(text).toContain("Росток");
    expect(text).not.toContain("Вы записаны на услугу");
    expect(text).not.toContain("516");
    expect(text).not.toContain("mama@mail.ru");
    expect(text).not.toContain("Амина");
    expect(input.lines).toHaveLength(4);
    expect(evidencePrompt(input).user).toContain("Школа: Школа подготовки «Росток»");
  });

  it("явная фраза пациента про школу с верной цитатой — привязка на проверку", () => {
    const input = buildEvidenceInput(dialog, "Росток", [], []);
    const answer = parseEvidenceAnswer('{"fromSchool": true, "evidenceMessageId": "m1", "evidenceQuote": "нам в школе Росток сказали", "reason": "прямо"}');
    expect(verifyEvidence(answer!, input)).toMatchObject({ result: "ATTRIBUTED", messageId: "a" });
  });

  it("цитаты нет в тексте — отклонено проверкой", () => {
    const input = buildEvidenceInput(dialog, "Росток", [], []);
    const answer = parseEvidenceAnswer('{"fromSchool": true, "evidenceMessageId": "m1", "evidenceQuote": "нас направила школа", "reason": ""}');
    expect(verifyEvidence(answer!, input).result).toBe("REJECTED_BY_VERIFIER");
  });

  it("цитата из сообщения клиники — отклонено, даже если дословная", () => {
    const input = buildEvidenceInput(dialog, "Росток", [], []);
    const answer = parseEvidenceAnswer('{"fromSchool": true, "evidenceMessageId": "m2", "evidenceQuote": "вы узнали о нас от школы подготовки", "reason": ""}');
    expect(verifyEvidence(answer!, input)).toMatchObject({ result: "REJECTED_BY_VERIFIER", reason: "цитата из сообщения клиники, а не пациента" });
  });

  it("сообщения нет в переписке — отклонено", () => {
    const input = buildEvidenceInput(dialog, "Росток", [], []);
    expect(verifyEvidence({ fromSchool: true, evidenceMessageId: "m40", evidenceQuote: "Росток", reason: "" }, input).result).toBe("REJECTED_BY_VERIFIER");
  });

  it("инстаграм или без упоминания школы — не от школы; «наверное» — неясно", () => {
    const input = buildEvidenceInput(dialog, "Росток", [], []);
    expect(verifyEvidence({ fromSchool: false, reason: "из инстаграма" }, input).result).toBe("NOT_FROM_SCHOOL");
    expect(verifyEvidence({ fromSchool: null, reason: "наверное" }, input).result).toBe("UNCLEAR");
  });

  it("ответ не JSON — ошибка модели, а не «нет»", () => {
    expect(parseEvidenceAnswer("Думаю, да")).toBeNull();
    expect(parseEvidenceAnswer('```json\n{"fromSchool": null, "reason": "мало данных"}\n```')).toMatchObject({ fromSchool: null });
  });

  it("имя в середине фразы заменяется, начало предложения — нет", () => {
    expect(maskForModel("Здравствуйте, это Зарема", [], [])).toBe("Здравствуйте, это [ИМЯ]");
    expect(maskForModel("Учительница Мадина из Ростока посоветовала", ["Росток"], [])).toBe("Учительница [ИМЯ] из Ростока посоветовала");
  });
});
