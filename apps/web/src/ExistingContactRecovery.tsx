import { useEffect, useRef, useState } from "react";

type Application = {
  id: string;
  bulkRunId?: string;
  executor?: string;
  status: string;
  stopReason?: string;
  job: { id: string; company: string; title: string };
  actions: {
    kind: string;
    index: number;
    state: string;
    evidence: string | null;
    resolution?: string;
  }[];
};
type Preview = {
  recoveryPreviewId: string;
  applicationId: string;
  expiresAt: string;
  dailyLimit: number;
  messages: string[];
};
type Inspection = { id: string; state: string; imported: number };
type Mutate = <T>(
  path: string,
  method: string,
  body?: unknown,
) => Promise<T | undefined>;

async function request<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "操作未完成，请重试。");
  return result as T;
}

export function ExistingContactRecovery({
  application,
  paused,
  mutate,
}: {
  application: Application;
  paused: boolean;
  mutate: Mutate;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stage, setStage] = useState("");
  const [now, setNow] = useState(Date.now);
  const operation = useRef<AbortController | null>(null);
  const fingerprint = JSON.stringify(application);
  useEffect(() => {
    setPreview(null);
    setBusy(false);
    setStage("");
    return () => {
      operation.current?.abort();
      operation.current = null;
    };
  }, [fingerprint]);
  useEffect(() => {
    if (!preview) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [preview]);
  const [native, ...remaining] = application.actions;
  const eligible =
    application.executor === "extension" &&
    application.bulkRunId &&
    application.status === "needs-review" &&
    native?.kind === "native-greeting" &&
    native.index === 0 &&
    native.state === "unknown" &&
    native.evidence === "send-unconfirmed" &&
    (!native.resolution || native.resolution === "contact-exists") &&
    remaining.length > 0 &&
    remaining.every(
      (action) =>
        action.kind === "message" &&
        action.state === "pending" &&
        !action.evidence &&
        !action.resolution,
    );
  if (!eligible) return null;
  const expired = !!preview && Date.parse(preview.expiresAt) <= now;

  const prepare = async () => {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError("");
    setPreview(null);
    setStage("正在检查是否可单独接续…");
    try {
      const data = await request<Preview>(
        "/api/extension-application/recovery-preview",
        { applicationId: application.id },
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setPreview(data);
        setNow(Date.now());
        setStage("");
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : "无法生成接续预览。");
    } finally {
      if (!controller.signal.aborted) {
        operation.current = null;
        setBusy(false);
        setStage("");
      }
    }
  };
  const resume = async () => {
    if (operation.current || !preview || expired || paused) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError("");
    setStage("正在核对岗位及已有沟通状态…");
    try {
      const started = await request<{ run: Inspection }>(
        "/api/automation/start",
        { inspectJobId: application.job.id },
        controller.signal,
      );
      let run = started.run;
      for (
        let attempt = 0;
        run.state === "running" && attempt < 45;
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (controller.signal.aborted) return;
        const current = await request<{ run: Inspection | null }>(
          "/api/automation",
          undefined,
          controller.signal,
        );
        if (current.run?.id !== started.run.id)
          throw new Error("岗位核对任务已变化，请重新预览。");
        run = current.run;
      }
      if (controller.signal.aborted) return;
      if (run.state !== "completed" || run.imported !== 1)
        throw new Error("岗位核对尚未完成，本次未接续发送。请先查看采集状态。");
      if (Date.parse(preview.expiresAt) <= Date.now())
        throw new Error("预览已过期，请重新预览。");
      setStage("正在建立单岗位接续批次…");
      const result = await mutate<{ applicationId: string; bulkRunId: string }>(
        "/api/extension-application/resume-existing-contact",
        "POST",
        {
          applicationId: application.id,
          inspectionRunId: run.id,
          recoveryPreviewId: preview.recoveryPreviewId,
        },
      );
      if (result && !controller.signal.aborted) {
        setPreview(null);
        setStage("已加入单岗位接续批次，可在批量投递页查看进度。");
      } else if (!controller.signal.aborted) {
        setStage("");
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : "接续未完成。");
        setStage("");
      }
    } finally {
      if (!controller.signal.aborted) {
        operation.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <details>
      <summary>单独接续未发送话术</summary>
      <p className="muted">
        适用于已结束批次中原生招呼待核对、后续话术尚未执行的岗位。程序会重新核对岗位及已有沟通，再按原话术接续。原招呼不会重发，历史待核对记录会保留。
      </p>
      <button
        className="quiet"
        disabled={paused || busy}
        onClick={() => void prepare()}
      >
        {preview ? "重新生成接续预览" : "检查并预览话术"}
      </button>
      {preview && (
        <div>
          <p>
            {application.job.company} · {application.job.title}
          </p>
          {preview.messages.map((message, index) => (
            <blockquote key={index} style={{ whiteSpace: "pre-wrap" }}>
              {message}
            </blockquote>
          ))}
          <p>
            仅接续此岗位。每日上限仍为 {preview.dailyLimit} 个；预览有效期至{" "}
            {new Date(preview.expiresAt).toLocaleTimeString("zh-CN")}。
          </p>
          {expired && <p role="status">预览已过期，请重新预览。</p>}
          <button
            disabled={paused || busy || expired}
            onClick={() => void resume()}
          >
            {busy ? "正在核对…" : "核对已有沟通并接续这些话术"}
          </button>
        </div>
      )}
      {stage && <p role="status">{stage}</p>}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
