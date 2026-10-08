import { createHash } from "node:crypto";
import {
  TEMPLATE_VARIABLES,
  type MessageTemplate,
} from "../../contracts/src/index.ts";
export function renderTemplate(
  template: MessageTemplate,
  values: Record<string, string>,
): string[] {
  if (!template.segments.length || template.segments.length > 5)
    throw new Error("话术需要 1–5 段");
  return template.segments.map((segment) => {
    if (!segment.trim() || segment.length > 2000)
      throw new Error("每段话术需要 1–2000 字");
    if (/简历已附|已附上|附件请查收/.test(segment))
      throw new Error("首次话术不能声称附件已发送，请修改后保存");
    const text = segment.replace(
      /\{\{\s*([^}]+?)\s*\}\}/g,
      (_, key: string) => {
        if (!(TEMPLATE_VARIABLES as readonly string[]).includes(key))
          throw new Error(`不支持的变量：${key}`);
        if (!values[key]?.trim()) throw new Error(`请补充变量：${key}`);
        return values[key];
      },
    );
    if (/\{\{|\}\}/.test(text)) throw new Error("话术变量括号不完整");
    return text;
  });
}
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
