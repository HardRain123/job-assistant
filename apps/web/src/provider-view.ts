function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function modelNames(value: unknown): string[] {
  const candidates = Array.isArray(value)
    ? value
    : record(value) && Array.isArray(value.data)
      ? value.data
      : record(value) && Array.isArray(value.models)
        ? value.models
        : [];
  return [
    ...new Set(
      candidates.flatMap((item) => {
        if (!record(item)) return [];
        const name = item.model ?? item.id ?? item.name;
        return typeof name === "string" && name.trim() ? [name] : [];
      }),
    ),
  ];
}
export function accountLabel(value: unknown): string {
  if (!record(value)) return "无法读取账户状态。";
  if (value.account === null) return "尚未登录 ChatGPT，请先连接设备。";
  const account = record(value.account) ? value.account : value;
  if (account.type === "apiKey")
    return "当前是 API Key 授权；如需 ChatGPT 账号，请重新连接设备。";
  const label = account.email ?? account.name;
  if (typeof label === "string" && label) return `已连接：${label}`;
  if (account.type === "chatgpt") return "已连接 ChatGPT 账号。";
  return "服务已响应，账户登录状态尚未确认。";
}
export function isChatGPTAccount(value: unknown): boolean {
  if (!record(value)) return false;
  const account = record(value.account) ? value.account : value;
  return account.type === "chatgpt";
}
