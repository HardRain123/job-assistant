import { FormEvent, useEffect, useRef, useState } from "react";

type RunState = "running" | "paused" | "blocked" | "completed" | "cancelled";
type Phase = "collecting" | "scoring" | "done";
type Run = {
  id: string;
  state: RunState;
  phase: Phase;
  config: {
    keywords: string[];
    city: "上海" | "全国";
    maxJobs: number;
    maxPages: number;
    autoAssess: boolean;
    intervalSeconds: number;
  };
  discovered: number;
  visited: number;
  imported: number;
  scored: number;
  failed: number;
  unreadableJobs?: { url: string; reason: string }[];
  fieldReadings?: { url: string; message: string; evidence?: {
    title: string; company: string; descriptionPresent: boolean; clientLabelSeen: boolean;
    clientNames: string[]; headerLines: string[];
    companySections: { lines: string[]; links: { text: string; path: string }[] }[];
  } }[];
  eligible: number;
  review: number;
  skipped: number;
  currentUrl: string | null;
  message: string;
  createdAt: string;
  updatedAt: string;
};
type Automation = {
  run: Run | null;
  extension: { paired: boolean; lastSeen: string | null; version: string | null };
};
type Mutate = <T>(path: string, method: string, body?: unknown) => Promise<T | undefined>;

const initial = {
  keywords: "AI应用开发、Java AI",
  city: "上海" as "上海" | "全国",
  maxJobs: 10,
  maxPages: 3,
  autoAssess: true,
  intervalSeconds: 5,
};
const splitKeywords = (value: string) =>
  value.split(/[、，,\n]/).map((item) => item.trim()).filter(Boolean);
const dateTime = (value: string | null) => value ? new Date(value).toLocaleString() : "尚无记录";
const isRecent = (value: string | null) => value !== null && Date.now() - new Date(value).getTime() <= 90_000;
const supportsAutomation = (version: string | null | undefined) => {
  if (!version) return false;
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return major > 0 || minor > 2 || (minor === 2 && patch >= 4);
};

export function AutomationPanel({ mutate, onPolicy, onConnect }: { mutate: Mutate; onPolicy?: () => void; onConnect?: () => void }) {
  const [data, setData] = useState<Automation | null>(null);
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(new Set<AbortController>());

  const read = async (signal?: AbortSignal) => {
    const controller = signal ? null : new AbortController();
    if (controller) pending.current.add(controller);
    try {
      const response = await fetch("/api/automation", { credentials: "same-origin", signal: signal ?? controller?.signal });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error("暂时无法读取自动找岗位状态");
      if (body && typeof body === "object" && "run" in body && "extension" in body) {
        setData(body as Automation);
        setError("");
      }
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setError("暂时无法读取自动找岗位状态");
    } finally {
      if (controller) pending.current.delete(controller);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal);
    return () => {
      controller.abort();
      pending.current.forEach((request) => request.abort());
    };
  }, []);
  useEffect(() => {
    const shouldPoll = data?.run?.state === "running" || data === null || !isRecent(data.extension.lastSeen);
    if (!shouldPoll) return;
    const timer = window.setInterval(() => void read(), 3_000);
    return () => window.clearInterval(timer);
  }, [data?.run?.state]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const keywords = splitKeywords(form.keywords);
    if (!keywords.length) {
      setError("请至少填写一个关键词。");
      return;
    }
    if (keywords.length > 5) {
      setError("最多可填写 5 个关键词。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await mutate<{ run: Run }>("/api/automation/start", "POST", { ...form, keywords });
      if (result?.run) setData((previous) => previous ? { ...previous, run: result.run } : previous);
      await read();
    } finally {
      setBusy(false);
    }
  };
  const control = async (action: "pause" | "resume" | "cancel") => {
    setBusy(true);
    setError("");
    try {
      const result = await mutate<{ run: Run }>("/api/automation/control", "POST", { action });
      if (result?.run) setData((previous) => previous ? { ...previous, run: result.run } : previous);
      await read();
    } finally {
      setBusy(false);
    }
  };

  const run = data?.run;
  const paired = data?.extension.paired === true;
  const recent = isRecent(data?.extension.lastSeen ?? null);
  const canConfigure = !run || ["completed", "cancelled"].includes(run.state);
  const canStart = paired && supportsAutomation(data?.extension.version) && canConfigure && !busy;
  return <div className="grid">
    <section className="card">
      <div className="card-title"><h2>自动找岗位</h2></div>
      <p>保持已登录 BOSS 的浏览器运行，扩展会自动打开专用搜索和详情标签页，读取完整职位描述，导入本地并按现有匹配策略评分。不会发送消息、投递或上传简历。</p>
      <p className="muted">升级后在 Chrome/Edge 扩展管理页刷新扩展，已有配对会保留。首次使用需完成配对；运行时扩展弹窗可以关闭。</p>
      <p>{data === null ? "正在读取扩展状态；若长时间未显示，请在扩展管理页重新加载或升级扩展后刷新此页。" : paired ? (recent ? "扩展已配对，最近有上报。" : "扩展已配对，但最近没有上报；请保持已登录 BOSS 的浏览器运行后再开始。") : "尚未配对扩展。请先到“浏览器”完成配对。"} 版本：{data?.extension.version ?? "未检测到"}；最近上报：{dateTime(data?.extension.lastSeen ?? null)}。</p>
      {data !== null && !supportsAutomation(data.extension.version) && <p className="notice">请在扩展管理页重新加载版本 0.2.4 或更新版本的扩展后再开始。</p>}
      {error && <p className="notice" role="alert">{error}</p>}
      <div className="button-row"><button type="button" className="quiet" onClick={() => void read()}>刷新连接状态</button>{!paired && onConnect && <button type="button" className="link" onClick={onConnect}>前往浏览器配对</button>}</div>
      {canConfigure && <form className="form policy" onSubmit={submit}>
        <label>关键词（最多 5 个，用逗号分隔）<input value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} /></label>
        <label>城市<select value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value as "上海" | "全国" })}><option>上海</option><option>全国</option></select></label>
        <label>最多岗位数<input type="number" min="1" max="50" value={form.maxJobs} onChange={(e) => setForm({ ...form, maxJobs: Math.min(50, Math.max(1, Number(e.target.value))) })} /></label>
        <label>每个关键词最多页数<input type="number" min="1" max="10" value={form.maxPages} onChange={(e) => setForm({ ...form, maxPages: Math.min(10, Math.max(1, Number(e.target.value))) })} /></label>
        <label>每次操作间隔（秒）<input type="number" min="3" max="30" value={form.intervalSeconds} onChange={(e) => setForm({ ...form, intervalSeconds: Math.min(30, Math.max(3, Number(e.target.value))) })} /></label>
        <label className="check"><input type="checkbox" checked={form.autoAssess} onChange={(e) => setForm({ ...form, autoAssess: e.target.checked })} />导入后自动评分</label>
        <div className="button-row"><button disabled={!canStart}>{busy ? "正在启动…" : "开始自动找岗位"}</button>{onPolicy && <button type="button" className="quiet" onClick={onPolicy}>查看匹配策略</button>}</div>
      </form>}
    </section>
    {run && <section className="card" aria-live="polite">
      <div className="card-title"><h2>{run.state === "running" ? "正在自动找岗位" : run.state === "paused" ? "自动找岗位已暂停" : run.state === "blocked" ? "自动找岗位等待处理" : run.state === "completed" ? "本次自动找岗位已完成" : "自动找岗位已停止"}</h2></div>
      <p>{run.phase === "collecting" ? "当前阶段：采集岗位。" : run.phase === "scoring" ? "当前阶段：匹配评分。" : "本次处理已结束。"} {run.message}</p>
      <p>已发现 {run.discovered} 个，已浏览 {run.visited} 个，已导入 {run.imported} / {run.config.maxJobs} 个；评分已处理 {run.scored + run.failed} / {run.imported} 个（成功 {run.scored} 个）。符合门槛 {run.eligible} 个，待复核 {run.review} 个，跳过 {run.skipped} 个。</p>
      {run.failed > 0 && <p className="muted">有 {run.failed} 个岗位未能处理，系统已继续处理其余岗位。</p>}
      {!!run.unreadableJobs?.length && <details><summary>{run.unreadableJobs.length} 个岗位信息不完整，未导入</summary><ul>{run.unreadableJobs.map((item) => <li key={item.url}><a href={item.url} target="_blank" rel="noreferrer">查看原岗位</a>：{item.reason}</li>)}</ul></details>}
      {!!run.fieldReadings?.length && <details><summary>字段读取情况（{run.fieldReadings.length} 条）</summary><ul>{run.fieldReadings.map((item) => <li key={item.url}>
        <a href={item.url} target="_blank" rel="noreferrer">查看原岗位</a>：{item.message}
        {item.evidence && <details><summary>页面字段证据</summary>
          <p className="muted">仅为该岗位头部和公司信息区的可见文字，用于检查读取问题；不代表字段已经核实，不参与评分。</p>
          <p>标题：{item.evidence.title || "未识别"}；公司：{item.evidence.company || "未识别"}；正文：{item.evidence.descriptionPresent ? "已读取" : "未读取"}</p>
          <p>客户公司标签：{item.evidence.clientLabelSeen ? "存在" : "未识别"}；客户名称：{item.evidence.clientNames.join("、") || "未识别"}</p>
          <p>岗位头部：{item.evidence.headerLines.join(" / ") || "未识别"}</p>
          {item.evidence.companySections.map((section, index) => <div key={index}>
            <p>公司区域 {index + 1}：{section.lines.join(" / ")}</p>
            <p>公司链接：{section.links.map((link) => `${link.text || "无文字"} (${link.path})`).join(" / ") || "未识别"}</p>
          </div>)}
        </details>}
      </li>)}</ul></details>}
      <p className="muted">暂停或取消会阻止后续操作；当前正在读取的一个岗位可能会先完成。</p>
      <div className="button-row">
        {run.state === "running" && <><button className="quiet" disabled={busy} onClick={() => void control("pause")}>暂停</button><button className="danger" disabled={busy} onClick={() => void control("cancel")}>取消</button></>}
        {(run.state === "paused" || run.state === "blocked") && <><button disabled={busy || !paired || !supportsAutomation(data?.extension.version)} onClick={() => void control("resume")}>继续</button><button className="danger" disabled={busy} onClick={() => void control("cancel")}>取消</button></>}
      </div>
    </section>}
  </div>;
}
