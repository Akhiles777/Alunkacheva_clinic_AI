import { describe, expect, it } from "vitest";
import { isStaleBuildError } from "./stale-build";

/**
 * Вкладка платформы живёт неделями. После обновления она остаётся на прежнем
 * коде, и серверные действия перестают опознаваться: сообщение не уходит,
 * запись не создаётся. Отличить это от обычного сбоя обязательно — из-за
 * случайной ошибки сети перезагружать вкладку нельзя, человек потеряет то,
 * что печатал.
 */
describe("узнаём старую сборку", () => {
  it("ошибка серверного действия — это она", () => {
    expect(isStaleBuildError(new Error("Server Action \"abc123\" was not found on the server"))).toBe(true);
    expect(isStaleBuildError("Failed to find Server Action \"x\"")).toBe(true);
  });

  it("обычный сбой сети — не она", () => {
    expect(isStaleBuildError(new Error("Failed to fetch"))).toBe(false);
    expect(isStaleBuildError(new Error("NetworkError when attempting to fetch resource"))).toBe(false);
  });

  it("ошибка бизнес-логики — не она", () => {
    expect(isStaleBuildError(new Error("Кабинет room-2 не найден в базе клиники"))).toBe(false);
  });

  it("не ломается на чём угодно", () => {
    expect(isStaleBuildError(null)).toBe(false);
    expect(isStaleBuildError(undefined)).toBe(false);
    expect(isStaleBuildError({ weird: true })).toBe(false);
  });
});
