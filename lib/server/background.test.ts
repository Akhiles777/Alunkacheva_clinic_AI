import { describe, expect, it } from "vitest";
import { drainBackground, runSerial } from "./background";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Работа после ответа вебхуку. Из-за её отсутствия пациенту приходилось писать
 * второй и третий раз: провайдер не дожидался ответа, слал сообщение заново, а
 * оно уже было сохранено и отбрасывалось как дубль.
 */
describe("фоновая обработка", () => {
  it("выполняет задачу после возврата управления", async () => {
    const done: string[] = [];
    runSerial("chat-1", async () => {
      await sleep(5);
      done.push("готово");
    });
    // Управление вернулось сразу — это и есть смысл: вебхук отвечает мгновенно.
    expect(done).toEqual([]);
    await drainBackground();
    expect(done).toEqual(["готово"]);
  });

  it("задачи одного собеседника идут по очереди", async () => {
    // Два сообщения подряд раньше обрабатывались одновременно: оба видели одну
    // историю, оба здоровались с одним и тем же человеком.
    const order: string[] = [];
    runSerial("chat-2", async () => {
      await sleep(20);
      order.push("первое");
    });
    runSerial("chat-2", async () => {
      order.push("второе");
    });
    await drainBackground();
    expect(order).toEqual(["первое", "второе"]);
  });

  it("разные собеседники друг друга не ждут", async () => {
    const order: string[] = [];
    runSerial("chat-3", async () => {
      await sleep(30);
      order.push("медленный");
    });
    runSerial("chat-4", async () => {
      order.push("быстрый");
    });
    await drainBackground();
    expect(order).toEqual(["быстрый", "медленный"]);
  });

  it("сбой одной задачи не отменяет следующую", async () => {
    const order: string[] = [];
    runSerial("chat-5", async () => {
      throw new Error("модель недоступна");
    });
    runSerial("chat-5", async () => {
      order.push("следующее сообщение обработано");
    });
    await drainBackground();
    expect(order).toEqual(["следующее сообщение обработано"]);
  });
});
