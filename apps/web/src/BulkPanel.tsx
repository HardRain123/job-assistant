import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  Application,
  BulkRun,
} from "../../../packages/contracts/src/index";

type BulkState = {
  run: BulkRun | null;
  today: {
    date: string;
    limit: number;
    occupied: number;
    contacts: number;
    completed: number;
    uncertain: number;
    remaining: number;
  };
  extension: {
    paired: boolean;
    version: string | null;
    lastSeen: string | null;
  };
};
type Preview = {
  previewId: string;
  expiresAt: string;
  applications: Application[];
  summary: {
    eligible: number;
    selected: number;
    shortfall: number;
    unassessed: number;
    review: number;
    excluded: number;
    duplicates: number;
  };
};
async function request<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    signal,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "操作未完成，请重试");
  return result as T;
}
const labels: Record<BulkRun["state"], string> = {
  running: "正在执行",
  paused: "已暂停",
  completed: "本批处理结束",
  cancelled: "本批已结束",
};

export function BulkPanel({
  onCollect,
  onJobs,
  onConnect,
  onRecords,
  onChanged,
}: {
  onCollect: () => void;
  onJobs: () => void;
  onConnect: () => void;
  onRecords: () => void;
  onChanged: () => Promise<void>;
}) {
  const [data, setData] = useState<BulkState | null>(null);
  const [config, setConfig] = useState({
    dailyLimit: 150,
    target: 150,
    intervalSeconds: 30,
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
    running: boolean;
  } | null>(null);
  const stopScoring = useRef(false);
  const mounted = useRef(true);
  const initialized = useRef(false);
  const read = async () => {
    const state = await request<BulkState>("/api/bulk-application");
    if (mounted.current) setData(state);
  };
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let reading = false;
    const poll = async () => {
      if (reading) return;
      reading = true;
      try {
        const state = await request<BulkState>(
          "/api/bulk-application",
          undefined,
          controller.signal,
        );
        if (mounted.current) {
          setData(state);
          if (!initialized.current) {
            initialized.current = true;
            setConfig({
              dailyLimit: state.today.limit,
              target: state.run?.target ?? 150,
              intervalSeconds: state.run?.intervalSeconds ?? 30,
            });
          }
        }
      } catch (e) {
        if (!controller.signal.aborted && mounted.current)
          setError(e instanceof Error ? e.message : "读取状态失败");
      } finally {
        reading = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      mounted.current = false;
      stopScoring.current = true;
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
      await read();
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const assess = () =>
    act(async () => {
      const state = await request<{
        jobs: {
          id: string;
          source: string;
          status: string;
          assessment?: { decision: string } | null;
        }[];
        applications: { jobId: string }[];
      }>("/api/state");
      const applied = new Set(state.applications.map((a) => a.jobId));
      const jobs = state.jobs.filter(
        (j) =>
          j.source === "boss" &&
          j.status === "active" &&
          !applied.has(j.id) &&
          (!j.assessment || j.assessment.decision === "unavailable"),
      );
      stopScoring.current = false;
      setPreview(null);
      setAccepted(false);
      setProgress({ done: 0, total: jobs.length, running: true });
      let done = 0;
      try {
        for (const job of jobs) {
          if (stopScoring.current || !mounted.current) break;
          await request("/api/assess", { jobIds: [job.id] });
          done++;
          if (mounted.current)
            setProgress({ done, total: jobs.length, running: true });
        }
      } finally {
        if (mounted.current) {
          setProgress({ done, total: jobs.length, running: false });
          await onChanged();
        }
      }
    });
  const makePreview = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      const next = await request<Preview>(
        "/api/bulk-application/preview",
        config,
      );
      if (mounted.current) {
        setPreview(next);
        setAccepted(false);
      }
    });
  };
  const control = (action: "pause" | "resume" | "cancel") =>
    act(async () => {
      await request("/api/bulk-application/control", { action });
      await onChanged();
    });
  const run = data?.run;
  const active = run?.state === "running" || run?.state === "paused";
  const version = (data?.extension.version ?? "").split(".").map(Number);
  const connected = Boolean(
    data?.extension.paired &&
      (version[0]! > 0 || version[1]! > 4 || (version[1] === 4 && version[2]! >= 1)) &&
      data.extension.lastSeen &&
      Date.now() - Date.parse(data.extension.lastSeen) < 90000,
  );
  const fresh = Boolean(preview && Date.parse(preview.expiresAt) > Date.now());
  return (
    <div className="grid bulk-panel">
      <section className="card">
        <div className="card-title">
          <h2>批量发送求职话术</h2>
          <button className="quiet" onClick={onRecords}>
            查看投递记录
          </button>
        </div>
        <p>
          按当前匹配规则选择岗位，先建立沟通，再依次发送你配置的话术。此次批量不发送简历附件或图片。
        </p>
        <p className="muted">
          每日目标默认
          150，可调低；这不是所有账号的统一平台额度。遇到平台限制或结果不明确时暂停。
        </p>
        {!connected && (
          <div className="notice">
          {data && !data.extension.paired ? "配对已失效或尚未连接，请重新生成配对码并连接扩展。" : ""}
            请保持 BOSS 已登录，并将普通浏览器扩展刷新到 0.4.1。当前上报版本：
            {data?.extension.version ?? "未连接"}。{" "}
            <button className="link" onClick={onConnect}>
              查看连接
            </button>
          </div>
        )}
        {error && (
          <div className="notice" role="alert">
            {error}
          </div>
        )}
        {data && (
          <>
            <div className="bulk-metrics">
              <div>
                <strong>
                  {data.today.occupied} / {data.today.limit}
                </strong>
                <span>今日已占名额</span>
              </div>
              <div>
                <strong>{data.today.contacts}</strong>
                <span>已确认建立沟通</span>
              </div>
              <div>
                <strong>{data.today.completed}</strong>
                <span>话术全部完成</span>
              </div>
              <div>
                <strong>{data.today.uncertain}</strong>
                <span>结果待核验</span>
              </div>
            </div>
            <p className="muted">
              按上海日期 {data.today.date} 统计，剩余 {data.today.remaining}{" "}
              个名额。已开始但未确认的操作仍占名额；你在 BOSS
              手动发起的沟通不在本地计数中。
            </p>
          </>
        )}
      </section>
      {run && (
        <section className="card">
          <div className="card-title">
            <h2>{labels[run.state]}</h2>
            <span>本批目标 {run.target} 个</span>
          </div>
          <p role="status">{run.message}</p>
          <p>
            排队 {run.counts.queued} · 执行中 {run.counts.running} · 话术完成{" "}
            {run.counts.completed} · 待核验 {run.counts.review} · 已沟通跳过{" "}
            {run.counts.skipped} · 已取消 {run.counts.cancelled}
          </p>
          {run.state === "running" && run.nextRunAt && (
            <p className="muted">
              下个岗位最早开始时间：
              {new Date(run.nextRunAt).toLocaleTimeString("zh-CN")}
              ；实际开始还取决于浏览器连接。
            </p>
          )}
          {active && (
            <div className="toolbar">
              {run.state === "running" ? (
                <button
                  className="quiet"
                  disabled={busy}
                  onClick={() => void control("pause")}
                >
                  暂停批量
                </button>
              ) : (
                <button
                  disabled={busy || !connected}
                  onClick={() => void control("resume")}
                >
                  保留待核验，继续未执行岗位
                </button>
              )}
              <button
                className="quiet danger"
                disabled={busy}
                onClick={() => void control("cancel")}
              >
                结束本批待执行任务
              </button>
              <span>暂停或结束后，已点击发送的动作仍可能完成；不会重发。</span>
            </div>
          )}
        </section>
      )}
      <section className="card">
        <div className="card-title">
          <h2>准备候选岗位</h2>
        </div>
        <p>
          只选择评估为合格且所有硬条件通过的岗位，按匹配分数排序，每家公司选一个岗位，排除已有投递记录。
        </p>
        <div className="toolbar">
          <button
            className="quiet"
            disabled={busy || active}
            onClick={() => void assess()}
          >
            评估尚未评估的岗位
          </button>
          <button
            className="quiet"
            disabled={busy || active}
            onClick={onCollect}
          >
            自动找更多岗位
          </button>
          <button className="link" onClick={onJobs}>
            查看岗位与复核原因
          </button>
          {progress?.running && (
            <button
              className="quiet"
              onClick={() => {
                stopScoring.current = true;
              }}
            >
              停止后续评估
            </button>
          )}
        </div>
        {progress && (
          <p role="status">
            {progress.running ? "正在评估" : "本次评估结束"}：{progress.done} /{" "}
            {progress.total}。停止后，正在评估的一项仍可能完成。
          </p>
        )}
        <form className="bulk-config" onSubmit={makePreview}>
          <label>
            每日最多发起沟通
            <input
              type="number"
              min="1"
              max="150"
              required
              disabled={busy || active}
              value={config.dailyLimit}
              onChange={(e) => {
                setConfig({ ...config, dailyLimit: Number(e.target.value) });
                setPreview(null);
                setAccepted(false);
              }}
            />
          </label>
          <label>
            本批目标岗位数
            <input
              type="number"
              min="1"
              max="150"
              required
              disabled={busy || active}
              value={config.target}
              onChange={(e) => {
                setConfig({ ...config, target: Number(e.target.value) });
                setPreview(null);
                setAccepted(false);
              }}
            />
          </label>
          <label>
            岗位之间至少间隔（秒）
            <input
              type="number"
              min="15"
              max="300"
              required
              disabled={busy || active}
              value={config.intervalSeconds}
              onChange={(e) => {
                setConfig({
                  ...config,
                  intervalSeconds: Number(e.target.value),
                });
                setPreview(null);
                setAccepted(false);
              }}
            />
          </label>
          <button disabled={busy || active}>生成批量预览</button>
        </form>
      </section>
      {preview && (
        <section className="card">
          <div className="card-title">
            <h2>发送前预览：{preview.summary.selected} 个岗位</h2>
          </div>
          <p>
            合格候选 {preview.summary.eligible} · 待评估{" "}
            {preview.summary.unassessed} · 需复核 {preview.summary.review} ·
            条件不符 {preview.summary.excluded} · 去重排除{" "}
            {preview.summary.duplicates}
          </p>
          {preview.summary.shortfall > 0 && (
            <div className="notice">
              距离本批目标还差 {preview.summary.shortfall}{" "}
              个，可能是合格岗位不足或今日剩余名额不足。不会降低门槛补足数量。
            </div>
          )}
          {preview.applications.map((application) => (
            <details className="bulk-job" key={application.id}>
              <summary>
                {application.job.company} · {application.job.title} ·{" "}
                {application.job.location} ·{" "}
                {(application.job.salaryMin ?? 0) / 1000}–
                {(application.job.salaryMax ?? 0) / 1000}K
              </summary>
              <p>
                <a href={application.job.url} target="_blank" rel="noreferrer">
                  查看原岗位
                </a>
              </p>
              {application.frozenMessages.map((message, i) => (
                <div key={i}>
                  <strong>第 {i + 1} 段</strong>
                  <pre className="bulk-message">{message}</pre>
                </div>
              ))}
            </details>
          ))}
          {preview.applications.length > 0 && (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={accepted}
                  disabled={busy || active}
                  onChange={(e) => setAccepted(e.target.checked)}
                />
                我已核对岗位和话术，启动后按上述顺序发送。
              </label>
              <div className="toolbar">
                <button
                  disabled={busy || active || !connected || !fresh || !accepted}
                  onClick={() =>
                    void act(async () => {
                      await request("/api/bulk-application/start", {
                        previewId: preview.previewId,
                      });
                      if (mounted.current) {
                        setPreview(null);
                        setAccepted(false);
                      }
                      await onChanged();
                    })
                  }
                >
                  开始发送这 {preview.applications.length} 个岗位
                </button>
                <span>
                  {fresh
                    ? `预览有效至 ${new Date(preview.expiresAt).toLocaleTimeString("zh-CN")}`
                    : "预览已过期，请重新生成"}
                </span>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
