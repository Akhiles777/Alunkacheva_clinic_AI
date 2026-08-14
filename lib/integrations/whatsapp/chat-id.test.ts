import { describe, expect, it } from "vitest";
import { phoneFromChatId } from "./chat-id";

describe("адрес, который телефоном не является", () => {
  it("@lid не превращается в номер", () => {
    // WhatsApp адресует часть собеседников идентификатором устройства. По
    // длине он похож на телефон, и прежде из него получался номер вида
    // +123456789012345: карточка с несуществующим номером, а настоящая
    // история визитов оставалась в стороне.
    expect(phoneFromChatId("123456789012345@lid")).toBeNull();
  });

  it("рассылки и каналы тоже не номера", () => {
    expect(phoneFromChatId("status@broadcast")).toBeNull();
    expect(phoneFromChatId("120363000000000000@newsletter")).toBeNull();
  });

  it("настоящие адреса разбираются по-прежнему", () => {
    expect(phoneFromChatId("79280001122@c.us")).toBe("+79280001122");
    expect(phoneFromChatId("79280001122@s.whatsapp.net")).toBe("+79280001122");
  });
});
