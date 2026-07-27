import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, loadMasterKey, maskSecret } from "./crypto";

const key = randomBytes(32);

describe("encrypt/decrypt Credential", () => {
  it("расшифровывает то, что зашифровали", () => {
    const secret = "partner-token-Ab12/+xyz==";
    const encrypted = encryptSecret(secret, key);
    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted, key)).toBe(secret);
  });

  it("шифротекст каждый раз разный (случайный IV)", () => {
    const a = encryptSecret("same", key);
    const b = encryptSecret("same", key);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key)).toBe("same");
    expect(decryptSecret(b, key)).toBe("same");
  });

  it("чужой ключ не расшифровывает", () => {
    const encrypted = encryptSecret("secret", key);
    expect(() => decryptSecret(encrypted, randomBytes(32))).toThrow();
  });

  it("подделка шифротекста ловится GCM-тегом", () => {
    const encrypted = encryptSecret("secret", key);
    const buf = Buffer.from(encrypted, "base64");
    buf[buf.length - 1] ^= 0xff; // портим последний байт
    expect(() => decryptSecret(buf.toString("base64"), key)).toThrow();
  });

  it("пустая строка шифруется и расшифровывается", () => {
    expect(decryptSecret(encryptSecret("", key), key)).toBe("");
  });

  it("юникод сохраняется", () => {
    const secret = "ключ-№1 ✓ Ω";
    expect(decryptSecret(encryptSecret(secret, key), key)).toBe(secret);
  });
});

describe("loadMasterKey", () => {
  it("принимает hex 64 символа", () => {
    expect(loadMasterKey("a".repeat(64)).length).toBe(32);
  });

  it("принимает base64 32 байта", () => {
    expect(loadMasterKey(randomBytes(32).toString("base64")).length).toBe(32);
  });

  it("отвергает ключ неверной длины", () => {
    expect(() => loadMasterKey("short")).toThrow();
    expect(() => loadMasterKey("a".repeat(62))).toThrow();
  });

  it("отвергает отсутствующий ключ", () => {
    expect(() => loadMasterKey(undefined)).toThrow(/CREDENTIAL_MASTER_KEY/);
  });
});

describe("maskSecret", () => {
  it("показывает только хвост", () => {
    const masked = maskSecret("supersecret1234");
    expect(masked.endsWith("1234")).toBe(true);
    expect(masked).not.toContain("supersecret");
  });

  it("короткий секрет маскируется целиком", () => {
    expect(maskSecret("ab")).not.toContain("ab");
  });
});
