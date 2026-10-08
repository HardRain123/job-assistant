import { readFileSync } from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
export function secret(name: string, fallback?: string): string {
  const file = process.env[`${name}_FILE`];
  const value = file
    ? readFileSync(file, "utf8").trim()
    : (process.env[name] ?? fallback);
  if (!value) throw new Error(`${name}_FILE 未配置，请先运行部署初始化脚本`);
  return value;
}
export function equal(a: string, b: string) {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}
export function encrypt(value: unknown, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    createHash("sha256").update(key).digest(),
    iv,
  );
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), data]
    .map((b) => b.toString("base64"))
    .join(".");
}
export function decrypt<T>(value: string, key: string): T {
  const [iv, tag, data] = value.split(".").map((s) => Buffer.from(s, "base64"));
  const cipher = createDecipheriv(
    "aes-256-gcm",
    createHash("sha256").update(key).digest(),
    iv,
  );
  cipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8"),
  ) as T;
}
