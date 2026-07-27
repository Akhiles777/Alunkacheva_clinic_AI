/**
 * Шифрование секретов интеграций (Credential.valueEncrypted).
 *
 * AES-256-GCM, мастер-ключ из env (§3.8, §9). GCM даёт и шифрование, и
 * проверку целостности: подделанный шифротекст не расшифруется. В логи и в
 * интерфейс открытое значение не попадает — только маска.
 *
 * Формат хранения: base64( iv[12] ‖ authTag[16] ‖ ciphertext ). Один
 * самодостаточный токен, ключ в нём не хранится.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export const MASTER_KEY_ENV = "CREDENTIAL_MASTER_KEY";

/**
 * Читает мастер-ключ из env. Принимает base64 (44 симв.) или hex (64 симв.),
 * ровно 32 байта. Кидает, если ключа нет или длина не та — на проде секреты
 * без ключа шифровать нельзя.
 */
export function loadMasterKey(raw = process.env[MASTER_KEY_ENV]): Buffer {
  if (!raw) {
    throw new Error(`${MASTER_KEY_ENV} не задан: нечем шифровать секреты`);
  }
  const trimmed = raw.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, "hex");
  } else {
    key = Buffer.from(trimmed, "base64");
  }
  if (key.length !== KEY_LEN) {
    throw new Error(`${MASTER_KEY_ENV} должен быть 32 байта (получено ${key.length})`);
  }
  return key;
}

export function encryptSecret(plaintext: string, masterKey: Buffer = loadMasterKey()): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decryptSecret(payload: string, masterKey: Buffer = loadMasterKey()): string {
  const buf = Buffer.from(payload, "base64");
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error("Повреждённый шифротекст: слишком короткий");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Маска для интерфейса: показываем хвост, остальное скрыто. Полное значение
 * не отдаём никогда (§3.8). Короткие секреты маскируются целиком.
 */
export function maskSecret(plaintext: string, visibleTail = 4): string {
  if (plaintext.length <= visibleTail) return "•".repeat(Math.max(plaintext.length, 4));
  return `${"•".repeat(Math.min(plaintext.length - visibleTail, 8))}${plaintext.slice(-visibleTail)}`;
}
