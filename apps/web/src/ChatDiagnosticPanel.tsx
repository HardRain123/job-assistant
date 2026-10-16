import { useEffect, useState } from "react";

type Diagnostic = {
  status: "pending" | "leased" | "completed" | "expired" | "invalidated";
  result?: {
    outcome: "observed" | "not-found" | "ambiguous" | "unavailable";
    headerEvidence?: { names: string[]; roles: string[] };
  };
};
type Mutate = <T>(path: string, method: string, body?: unknown) => Promise<T | undefined>;
export function ChatDiagnosticPanel({ applicationId, mutate }: { applicationId: string; mutate: Mutate }) {
  const [open, setOpen] = useState(false);
  const [diagnostic, setDiagnostic] = useState<Diagnostic | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = diagnostic?.status === "pending" || diagnostic?.status === "leased";
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const response = await fetch(`/api/extension-application/diagnose/${applicationId}`, { signal: controller.signal });
        if (!response.ok) throw new Error();
        const data = await response.json() as { diagnostic: Diagnostic | null };
        if (!controller.signal.aborted) { setDiagnostic(data.diagnostic); setError(""); }
      } catch {
        if (!controller.signal.aborted) setError("暂时无法读取诊断状态。");
      } finally { reading = false; }
    };
    void read();
    const timer = pending ? window.setInterval(() => void read(), 3000) : undefined;
    return () => { controller.abort(); if (timer) window.clearInterval(timer); };
  }, [applicationId, open, pending]);
  const request = async () => {
    setBusy(true);
    try {
      const data = await mutate<{ diagnostic: Diagnostic }>("/api/extension-application/diagnose", "POST", { applicationId });
      if (data) { setDiagnostic(data.diagnostic); setError(""); }
    } finally { setBusy(false); }
  };
  const outcome = diagnostic?.result?.outcome;
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>检查聊天页识别问题</summary>
    <p className="muted">只检查已打开的 BOSS 聊天页中与此岗位对应的姓名、职务。不会读取聊天消息或发送内容，诊断也不会更改投递结果。</p>
    <button className="quiet" disabled={busy || pending} onClick={() => void request()}>{pending ? "正在等待扩展检查…" : busy ? "正在请求…" : "只读检查页面"}</button>
    {diagnostic?.status === "expired" && <p>检查已过期，未自动重试。</p>}
    {diagnostic?.status === "invalidated" && <p>投递记录已变化，这次检查已失效。</p>}
    {outcome === "observed" && <p>姓名位置：{diagnostic?.result?.headerEvidence?.names.join(" / ") || "未读到文字"}；职务位置：{diagnostic?.result?.headerEvidence?.roles.join(" / ") || "未读到文字"}。以上仅用于排查识别问题。</p>}
    {outcome === "not-found" && <p>已打开的聊天页中未找到可核对的目标岗位头部。</p>}
    {outcome === "ambiguous" && <p>找到多个可能对应的页面或区域，无法确定唯一目标。</p>}
    {outcome === "unavailable" && <p>页面未完成读取，可能正在跳转或浏览器暂时没有响应。</p>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
