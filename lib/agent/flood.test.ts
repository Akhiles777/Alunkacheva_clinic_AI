import { describe, expect, it } from "vitest";
import { FLOOD_LIMIT, floodJustStarted, flooding } from "./flood";

describe("поток сообщений", () => {
  it("обычный разговор пределом не считается", () => {
    expect(flooding(1)).toBe(false);
    expect(flooding(FLOOD_LIMIT)).toBe(false);
  });

  it("за пределом модель не зовём, а человека зовём один раз", () => {
    expect(flooding(FLOOD_LIMIT + 1)).toBe(true);
    expect(floodJustStarted(FLOOD_LIMIT + 1)).toBe(true);
    expect(floodJustStarted(FLOOD_LIMIT + 5)).toBe(false);
  });
});
