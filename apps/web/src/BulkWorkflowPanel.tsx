import { useEffect, useState } from "react";

type Workflow = {
  id: string;
  state: "running" | "paused" | "completed" | "cancelled";
  phase: "collecting" | "sending" | "done";
  target: number;
  rounds: number;
  budgetUsed: number;
  message: string;
  counts: { planned: number; targetUsed?: number; completed: number; review: number; skipped: number; queued: number };
};
type Preview = {
  previewId: string;
  expiresAt: string;
  target: number;
  applications: { id: string; job: { company: string; title: string; location: string | null } }[];
  messageTemplates: string[];
};
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/bulk-workflow${path}`, {
    method: body === undefined ? "GET" : "POST", signal,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "操作未完成，请重试");
  return result as T;
}

export function BulkWorkflowPanel({ onActiveChange, onChanged }: {
  onActiveChange: (active: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  const [run, setRun] = useState<Workflow | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ keywords: "Java后端开发、Java开发工程师、AI应用开发", target: 10, dailyLimit: 150, intervalSeconds: 30, maxJobsPerRound: 50, maxPages: 2, maxRounds: 3 });
  const active = run?.state === "running" || run?.state === "paused";
  useEffect(() => {
    const controller = new AbortController();
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const data = await request<{ run: Workflow | null }>("", undefined, controller.signal);
        if (!controller.signal.aborted) { setRun(data.run); setError(""); }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "暂时无法读取自动补采状态");
      } finally { reading = false; }
    };
    void read();
    const timer = window.setInterval(() => void read(), 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  useEffect(() => { onActiveChange(active); }, [active, onActiveChange]);
  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await fn(); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作未完成"); }
    finally { setBusy(false); }
  };
  const control = (action: "pause" | "resume" | "cancel") => act(async () => {
    const result = await request<{ run: Workflow }>("/control", { action });
    setRun(result.run);
  });
  return <section className="card">
    <div className="card-title"><h2>自动补充并投递</h2></div>
    <p>按当前筛选条件和话术处理岗位，候选不足时自动采集、评分后继续。已沟通跳过和明确未发送的失败不占目标，会补充新岗位；已尝试但结果未知的岗位保留名额，等待核对。</p>
    <p className="muted">单岗位异常保留待核验并继续；连续三次异常、登录、验证码或平台额度限制会暂停。最多补采五轮，累计采集入库三百个岗位，不会降低筛选门槛。不发送附件或图片。</p>
    {error && <p className="notice" role="alert">{error}</p>}
    {run && <div aria-live="polite">
      <p>{run.state === "running" ? (run.phase === "collecting" ? "正在采集和评分" : "正在依次发送") : run.state === "paused" ? "已暂停" : run.state === "completed" ? "本次处理结束" : "本次已取消"}：{run.message}</p>
      <p>目标占用 {run.counts.targetUsed ?? run.counts.planned} / {run.target} 个 · 话术完成 {run.counts.completed} · 待核验 {run.counts.review} · 已沟通跳过 {run.counts.skipped} · 排队 {run.counts.queued}；累计处理候选 {run.counts.planned} 个，补采 {run.rounds} 轮，累计入库 {run.budgetUsed} 个岗位。</p>
      {active && <div className="button-row">
        <button disabled={busy} onClick={() => void control(run.state === "paused" ? "resume" : "pause")}>{run.state === "paused" ? "继续自动批次" : "暂停自动批次"}</button>
        <button className="quiet danger" disabled={busy} onClick={() => void control("cancel")}>结束自动批次</button>
      </div>}
    </div>}
    {!active && <form className="form" onSubmit={(event) => {
      event.preventDefault();
      void act(async () => {
        const keywords = form.keywords.split(/[、，,\n]/).map((word) => word.trim()).filter(Boolean);
        const data = await request<Preview>("/preview", { ...form, keywords, city: "上海", continueOnJobFailure: true });
        setPreview(data); setAccepted(false);
      });
    }}>
      <label>补采关键词（最多五个）<input required disabled={busy} value={form.keywords} onChange={(event) => { setForm({ ...form, keywords: event.target.value }); setPreview(null); }} /></label>
      <div className="bulk-config">
        {([
          ["target", "本次目标岗位数", 1, 150], ["dailyLimit", "每日沟通上限", 1, 150],
          ["intervalSeconds", "岗位间隔（秒）", 15, 300], ["maxJobsPerRound", "每轮最多采集", 1, 100],
          ["maxPages", "每个关键词最多页数", 1, 10], ["maxRounds", "最多补采轮数", 1, 5],
        ] as const).map(([field, label, min, max]) => <label key={field}>{label}<input type="number" required min={min} max={max} disabled={busy} value={form[field]} onChange={(event) => { setForm({ ...form, [field]: Number(event.target.value) }); setPreview(null); }} /></label>)}
      </div>
      <p className="muted">补采地点：上海。薪资、排除公司与行业、匹配分数沿用工作台当前设置；修改简历、话术或配置后需要重新预览。</p>
      <button disabled={busy}>预览自动批次</button>
    </form>}
    {!active && preview && <div>
      <p>已有候选 {preview.applications.length} 个，目标 {preview.target} 个；不足部分将按上述范围自动补采。</p>
      {preview.applications.length > 0 && <details><summary>查看现有候选</summary><ul>{preview.applications.map((application) => <li key={application.id}>{application.job.company} · {application.job.title} · {application.job.location}</li>)}</ul></details>}
      <details open><summary>将使用的话术模板（岗位名称自动填入）</summary>{preview.messageTemplates?.map((message, index) => <pre className="bulk-message" key={index}>{message}</pre>)}</details>
      <label className="check"><input type="checkbox" checked={accepted} disabled={busy} onChange={(event) => setAccepted(event.target.checked)} />我已核对话术，允许按当前条件自动补采并发送至本次目标数。</label>
      <button disabled={busy || !accepted || Date.parse(preview.expiresAt) <= Date.now()} onClick={() => void act(async () => {
        const result = await request<{ run: Workflow }>("/start", { previewId: preview.previewId });
        setRun(result.run); setPreview(null); setAccepted(false);
      })}>开始自动批次</button>
    </div>}
  </section>;
}
