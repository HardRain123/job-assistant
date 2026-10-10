import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import { accountLabel, isChatGPTAccount, modelNames } from "./provider-view";
import { ExtensionPanel } from "./ExtensionPanel";
import { AutomationPanel } from "./AutomationPanel";
import type { Application as StoredApplication } from "../../../packages/contracts/src/index";

type Tab =
  | "工作台"
  | "自动找岗位"
  | "岗位库"
  | "简历资料"
  | "匹配策略"
  | "话术"
  | "招聘来源"
  | "模型连接"
  | "投递记录"
  | "浏览器";
type Json = Record<string, unknown>;
interface Resume {
  id: string;
  name: string;
  text: string;
  skills: string[];
  years: number;
  attachmentName: string | null;
}
interface Job {
  id: string;
  contentHash: string;
  company: string;
  title: string;
  location: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  source: "boss" | "official";
  url: string;
  description: string;
  skills: string[];
  status: string;
  assessment?: Assessment | null;
  similarity?: number | null;
}
interface Gate {
  field: string;
  status: "pass" | "fail" | "unknown";
  reason: string;
}
interface Assessment {
  score: number | null;
  decision: string;
  gates: Gate[];
  dimensions: Record<string, { score: number; evidence: string }>;
  reasons: string[];
  provider: string | null;
  model: string | null;
}
interface Source {
  id: string;
  name: string;
  kind: "boss" | "official";
  url: string;
  allowedHosts: string[];
  enabled: boolean;
  lastSuccess: string | null;
  lastError: string | null;
}
interface Template {
  name: string;
  segments: string[];
  attachmentPolicy: "message-only" | "send-after-messages";
}
interface Provider {
  id: string;
  name: string;
  kind: "openai-compatible" | "codex";
  baseUrl: string;
  model: string;
  protocol: "chat-completions" | "responses";
  enabled: boolean;
  priority: number;
  timeoutMs: number;
  hasKey?: boolean;
  apiKey?: string;
}
interface Policy {
  cities: string[];
  allowRemote: boolean;
  salaryMin: number;
  excludedCompanies: string[];
  excludedIndustries: string[];
  requiredSkills: string[];
  autoThreshold: number;
  reviewThreshold: number;
  reviewMargin: number;
  weights: {
    skills: number;
    responsibilities: number;
    experience: number;
    qualifications: number;
    preferences: number;
  };
}
interface Application {
  id: string;
  stopReason?: string;
  pageDiagnostic?: StoredApplication["pageDiagnostic"];
  job: Job;
  status: string;
  frozenMessages: string[];
  actions: {
    kind: string;
    state: string;
    evidence: string | null;
    resolution?: "contact-exists";
  }[];
  createdAt: string;
}
interface State {
  resume: Resume | null;
  policy: Policy;
  template: Template;
  sources: Source[];
  providers: Provider[];
  embedding: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    hasKey?: boolean;
    apiKey?: string;
  };
  jobs: Job[];
  applications: Application[];
  tasks: { id: string; kind: string; status: string }[];
  paused: boolean;
  takeover: boolean;
}
const tabs: Tab[] = [
  "工作台",
  "自动找岗位",
  "岗位库",
  "简历资料",
  "匹配策略",
  "话术",
  "招聘来源",
  "模型连接",
  "投递记录",
  "浏览器",
];
const defaultPolicy: Policy = {
  cities: ["上海"],
  allowRemote: true,
  salaryMin: 20000,
  excludedCompanies: [],
  excludedIndustries: [],
  requiredSkills: [],
  autoThreshold: 80,
  reviewThreshold: 65,
  reviewMargin: 5,
  weights: {
    skills: 35,
    responsibilities: 30,
    experience: 20,
    qualifications: 10,
    preferences: 5,
  },
};
const api = async <T,>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> => {
  const r = await fetch(path, {
    method,
    headers:
      body === undefined || body instanceof FormData
        ? undefined
        : { "content-type": "application/json" },
    body:
      body instanceof FormData
        ? body
        : body === undefined
          ? undefined
          : JSON.stringify(body),
  });
  const data: unknown = await r
    .json()
    .catch(() => ({ error: "服务返回了无法读取的内容" }));
  if (!r.ok)
    throw new Error(
      isRecord(data) && typeof data.error === "string"
        ? data.error
        : `请求失败（${r.status}）`,
    );
  return data as T;
};
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null;
const list = (value: string) =>
  value
    .split(/[、，,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
const errorMessage = async (response: Response) => {
  const data: unknown = await response.json().catch(() => null);
  return isRecord(data) && typeof data.error === "string"
    ? data.error
    : `请求失败（${response.status}）`;
};
const download = async (
  path: string,
  method: "GET" | "POST",
  filename: string,
  contentType: string,
) => {
  const response = await fetch(path, { method });
  if (!response.ok) throw new Error(await errorMessage(response));
  if (!response.headers.get("content-type")?.includes(contentType))
    throw new Error("服务返回的文件类型不正确");
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};
const money = (n: number | null) =>
  n === null ? "—" : `${Math.round(n / 1000)}k`;
function Notice({ error, children }: { error: string; children: ReactNode }) {
  return (
    <>
      {error && (
        <div role="alert" className="notice">
          {error}
        </div>
      )}
      {children}
    </>
  );
}
function Card({
  title,
  children,
  actions,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="card">
      {title && (
        <div className="card-title">
          <h2>{title}</h2>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
function Empty({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <p>{detail}</p>
      {action}
    </div>
  );
}
function App() {
  const [state, setState] = useState<State | null>(null),
    [tab, setTab] = useState<Tab>("工作台"),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [logged, setLogged] = useState(false),
    [mutating, setMutating] = useState(false);
  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      setState(await api<State>("/api/state"));
      setLogged(true);
    } catch (e) {
      if (e instanceof Error && e.message.includes("请登录")) setLogged(false);
      else setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const mutate = async <T,>(path: string, method: string, body?: unknown) => {
    if (mutating) return undefined;
    setMutating(true);
    setError("");
    try {
      const result = await api<T>(path, method, body);
      await refresh();
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
      return undefined;
    } finally {
      setMutating(false);
    }
  };
  if (!logged && !loading) return <Login onDone={refresh} />;
  if (loading && !state)
    return (
      <main className="loading" aria-live="polite">
        正在读取本地工作台…
      </main>
    );
  if (!state)
    return (
      <main className="loading">
        <Notice error={error}>无法载入工作台。</Notice>
      </main>
    );
  const content =
    tab === "工作台" ? (
      <Home s={state} select={setTab} mutate={mutate} />
    ) : tab === "自动找岗位" ? (
      <AutomationPanel
        mutate={mutate}
        onPolicy={() => setTab("匹配策略")}
        onConnect={() => setTab("浏览器")}
      />
    ) : tab === "岗位库" ? (
      <Jobs s={state} mutate={mutate} />
    ) : tab === "简历资料" ? (
      <ResumePanel resume={state.resume} mutate={mutate} />
    ) : tab === "匹配策略" ? (
      <PolicyPanel policy={state.policy} mutate={mutate} />
    ) : tab === "话术" ? (
      <TemplatePanel
        template={state.template}
        jobs={state.jobs}
        mutate={mutate}
      />
    ) : tab === "招聘来源" ? (
      <SourcesPanel sources={state.sources} mutate={mutate} />
    ) : tab === "模型连接" ? (
      <Models s={state} mutate={mutate} />
    ) : tab === "投递记录" ? (
      <Records s={state} mutate={mutate} />
    ) : (
      <Browser s={state} mutate={mutate} />
    );
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <span>JA</span>
          <div>
            求职工作台<small>本地优先</small>
          </div>
        </div>
        <nav aria-label="主导航">
          {tabs.map((t) => (
            <button
              key={t}
              className={tab === t ? "active" : ""}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <span className={state.paused ? "dot warn" : "dot"} />
          {state.takeover
            ? "人工接管中"
            : state.paused
              ? "投递队列已暂停"
              : "投递队列可用"}
          <button
            className="link"
            onClick={() =>
              void mutate("/api/logout", "POST").then(() => {
                setState(null);
                setLogged(false);
              })
            }
          >
            退出
          </button>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <p className="eyebrow">LOCAL JOB ASSISTANT</p>
            <h1>{tab}</h1>
          </div>
          <button
            className="quiet"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? "更新中…" : "刷新"}
          </button>
        </header>
        <Notice error={error}>{content}</Notice>
      </main>
    </div>
  );
}
function Login({ onDone }: { onDone: () => Promise<void> }) {
  const [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/login", "POST", { password });
      await onDone();
    } catch (x) {
      setError(x instanceof Error ? x.message : "登录失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login">
      <form onSubmit={submit} className="login-card">
        <div className="brand">
          <span>JA</span>
          <div>
            求职工作台<small>仅限本机访问</small>
          </div>
        </div>
        <h1>进入工作台</h1>
        <p>使用启动时设置的本地密码。密码不会保存在浏览器中。</p>
        {error && (
          <div role="alert" className="notice">
            {error}
          </div>
        )}
        <label>
          本地密码
          <input
            type="password"
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button disabled={busy}>{busy ? "正在验证…" : "登录"}</button>
      </form>
    </main>
  );
}
function Home({
  s,
  select,
  mutate,
}: {
  s: State;
  select: (t: Tab) => void;
  mutate: <T>(p: string, m: string, b?: unknown) => Promise<T | undefined>;
}) {
  const eligible = s.jobs.filter(
    (j) => j.assessment?.decision === "eligible",
  ).length;
  return (
    <div className="grid home">
      <Card title="自动找岗位">
        <p>
          让已配对的浏览器扩展逐个读取 BOSS 职位描述，导入本地并按你的策略评分。
        </p>
        <p className="muted">不会自动发送消息、投递或上传简历。</p>
        <button onClick={() => select("自动找岗位")}>开始自动找岗位</button>
      </Card>
      <Card>
        <p className="metric">{s.jobs.length}</p>
        <p>已收集岗位</p>
        <button className="link" onClick={() => select("岗位库")}>
          查看岗位库
        </button>
      </Card>
      <Card>
        <p className="metric">{s.resume ? "已就绪" : "未设置"}</p>
        <p>简历资料</p>
        <button className="link" onClick={() => select("简历资料")}>
          {s.resume ? "编辑资料" : "开始填写"}
        </button>
      </Card>
      <Card>
        <p className="metric">{eligible}</p>
        <p>达到自动投递门槛</p>
        <button className="link" onClick={() => select("岗位库")}>
          核对匹配
        </button>
      </Card>
      <Card title="下一步">
        <ol className="steps">
          <li className={s.resume ? "done" : ""}>填写或上传简历</li>
          <li className={s.sources.length ? "done" : ""}>添加招聘来源并同步</li>
          <li>评估岗位，确认后生成投递预览</li>
        </ol>
      </Card>
      <Card
        title="当前状态"
        actions={
          <button
            className="quiet"
            onClick={() =>
              void mutate(
                s.paused ? "/api/queue/resume" : "/api/queue/pause",
                "POST",
              )
            }
          >
            {s.paused ? "恢复队列" : "暂停队列"}
          </button>
        }
      >
        <p>
          {s.tasks.length
            ? `有 ${s.tasks.length} 个任务记录。`
            : "还没有任务。添加来源后可开始同步。"}
        </p>
        {!s.resume && (
          <Empty
            title="先准备简历"
            detail="系统不会凭空生成候选人资料；请填写文字或上传 DOCX / PDF。"
            action={
              <button onClick={() => select("简历资料")}>前往简历资料</button>
            }
          />
        )}
      </Card>
    </div>
  );
}
function ResumePanel({
  resume,
  mutate,
}: {
  resume: Resume | null;
  mutate: <T>(p: string, m: string, b?: unknown) => Promise<T | undefined>;
}) {
  const [form, setForm] = useState({
    name: resume?.name ?? "",
    text: resume?.text ?? "",
    skills: resume?.skills.join("、") ?? "",
    years: String(resume?.years ?? ""),
  });
  useEffect(
    () =>
      setForm({
        name: resume?.name ?? "",
        text: resume?.text ?? "",
        skills: resume?.skills.join("、") ?? "",
        years: String(resume?.years ?? ""),
      }),
    [resume],
  );
  const save = (e: FormEvent) => {
    e.preventDefault();
    void mutate("/api/resume", "PUT", {
      name: form.name,
      text: form.text,
      skills: list(form.skills),
      years: Number(form.years),
    });
  };
  const upload = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const input = e.currentTarget.elements.namedItem(
      "file",
    ) as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    await mutate("/api/resume/upload", "POST", fd);
  };
  return (
    <div className="split">
      <Card title="简历文字">
        <form onSubmit={save} className="form">
          <label>
            名称
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            工作年限
            <input
              type="number"
              min="0"
              max="60"
              required
              value={form.years}
              onChange={(e) => setForm({ ...form, years: e.target.value })}
            />
          </label>
          <label>
            技能（用逗号分隔）
            <input
              value={form.skills}
              onChange={(e) => setForm({ ...form, skills: e.target.value })}
            />
          </label>
          <label>
            简历内容
            <textarea
              required
              minLength={20}
              value={form.text}
              onChange={(e) => setForm({ ...form, text: e.target.value })}
            />
          </label>
          <button>保存简历</button>
        </form>
      </Card>
      <Card title="上传附件">
        <p>
          支持 DOCX 或带文本的 PDF，最大 10
          MB。上传会提取文字，已有技能和年限会保留供你核对。
        </p>
        <form onSubmit={upload} className="form">
          <input
            aria-label="选择简历文件"
            name="file"
            type="file"
            accept=".docx,.pdf"
            required
          />
          <button>上传并提取</button>
        </form>
        {resume?.attachmentName ? (
          <p className="ok">已保存附件：{resume.attachmentName}</p>
        ) : (
          <p className="muted">
            尚未上传附件。仅在选择“多轮后发送附件”时需要它。
          </p>
        )}
      </Card>
    </div>
  );
}
function PolicyPanel({
  policy,
  mutate,
}: {
  policy: Policy;
  mutate: <T>(p: string, m: string, b?: unknown) => Promise<T | undefined>;
}) {
  const [p, setP] = useState(policy);
  useEffect(() => setP(policy), [policy]);
  const setWeight = (key: keyof Policy["weights"], v: number) =>
    setP({ ...p, weights: { ...p.weights, [key]: v } });
  const total = Object.values(p.weights).reduce((a, b) => a + b, 0);
  return (
    <Card title="匹配策略">
      <form
        className="form policy"
        onSubmit={(e) => {
          e.preventDefault();
          void mutate("/api/policy", "PUT", p);
        }}
      >
        <label>
          目标城市
          <input
            value={p.cities.join("、")}
            onChange={(e) => setP({ ...p, cities: list(e.target.value) })}
          />
        </label>
        <label>
          最低月薪（元）
          <input
            type="number"
            value={p.salaryMin}
            onChange={(e) => setP({ ...p, salaryMin: Number(e.target.value) })}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={p.allowRemote}
            onChange={(e) => setP({ ...p, allowRemote: e.target.checked })}
          />
          允许远程岗位
        </label>
        <label>
          排除公司
          <input
            value={p.excludedCompanies.join("、")}
            onChange={(e) =>
              setP({ ...p, excludedCompanies: list(e.target.value) })
            }
          />
        </label>
        <label>
          排除行业
          <input
            value={p.excludedIndustries.join("、")}
            onChange={(e) =>
              setP({ ...p, excludedIndustries: list(e.target.value) })
            }
          />
        </label>
        <label>
          必要技能
          <input
            value={p.requiredSkills.join("、")}
            onChange={(e) =>
              setP({ ...p, requiredSkills: list(e.target.value) })
            }
          />
        </label>
        <div className="triple">
          <label>
            自动投递阈值
            <input
              type="number"
              value={p.autoThreshold}
              onChange={(e) =>
                setP({ ...p, autoThreshold: Number(e.target.value) })
              }
            />
          </label>
          <label>
            人工复核阈值
            <input
              type="number"
              value={p.reviewThreshold}
              onChange={(e) =>
                setP({ ...p, reviewThreshold: Number(e.target.value) })
              }
            />
          </label>
          <label>
            边界范围
            <input
              type="number"
              value={p.reviewMargin}
              onChange={(e) =>
                setP({ ...p, reviewMargin: Number(e.target.value) })
              }
            />
          </label>
        </div>
        <fieldset>
          <legend>评分权重（合计 {total}%）</legend>
          {(Object.keys(p.weights) as (keyof Policy["weights"])[]).map((k) => (
            <label key={k} className="weight">
              {
                {
                  skills: "技能",
                  responsibilities: "职责",
                  experience: "经验",
                  qualifications: "资质",
                  preferences: "偏好",
                }[k]
              }
              <input
                type="number"
                min="0"
                value={p.weights[k]}
                onChange={(e) => setWeight(k, Number(e.target.value))}
              />
              %
            </label>
          ))}
        </fieldset>
        <button disabled={total !== 100}>保存策略</button>
      </form>
    </Card>
  );
}
function TemplatePanel({
  template,
  jobs,
  mutate,
}: {
  template: Template;
  jobs: Job[];
  mutate: <T>(p: string, m: string, b?: unknown) => Promise<T | undefined>;
}) {
  const [t, setT] = useState(template),
    [preview, setPreview] = useState<string[]>([]);
  useEffect(() => setT(template), [template]);
  return (
    <div className="split">
      <Card title="沟通话术">
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void mutate("/api/template", "PUT", t);
          }}
        >
          <label>
            名称
            <input
              value={t.name}
              onChange={(e) => setT({ ...t, name: e.target.value })}
            />
          </label>
          {t.segments.map((x, i) => (
            <label key={i}>
              第 {i + 1} 段
              <textarea
                value={x}
                onChange={(e) =>
                  setT({
                    ...t,
                    segments: t.segments.map((v, n) =>
                      n === i ? e.target.value : v,
                    ),
                  })
                }
              />
              <button
                type="button"
                className="link"
                disabled={t.segments.length === 1}
                onClick={() =>
                  setT({ ...t, segments: t.segments.filter((_, n) => n !== i) })
                }
              >
                移除此段
              </button>
            </label>
          ))}
          {t.segments.length < 5 && (
            <button
              type="button"
              className="quiet"
              onClick={() => setT({ ...t, segments: [...t.segments, ""] })}
            >
              添加一段
            </button>
          )}
          <label>
            附件策略
            <select
              value={t.attachmentPolicy}
              onChange={(e) =>
                setT({
                  ...t,
                  attachmentPolicy: e.target
                    .value as Template["attachmentPolicy"],
                })
              }
            >
              <option value="message-only">只发消息</option>
              <option value="send-after-messages">全部消息后发送简历</option>
            </select>
          </label>
          <button>保存话术</button>
        </form>
      </Card>
      <Card title="发送前预览">
        <p>
          变量：&#123;&#123;company&#125;&#125;、&#123;&#123;title&#125;&#125;、&#123;&#123;candidateName&#125;&#125;、&#123;&#123;years&#125;&#125;、&#123;&#123;skills&#125;&#125;
        </p>
        <button
          onClick={async () => {
            const r = await mutate<{ messages: string[] }>(
              "/api/template/preview",
              "POST",
              jobs[0] ? { jobId: jobs[0].id } : {},
            );
            if (r) setPreview(r.messages);
          }}
        >
          生成预览
        </button>
        {preview.length ? (
          <ol className="messages">
            {preview.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ol>
        ) : (
          <Empty
            title="尚未预览"
            detail="预览使用第一条岗位或示例信息，不会发送消息。"
          />
        )}
      </Card>
    </div>
  );
}
function SourcesPanel({
  sources,
  mutate,
}: {
  sources: Source[];
  mutate: <T>(p: string, m: string, b?: unknown) => Promise<T | undefined>;
}) {
  const [f, setF] = useState({
    name: "",
    kind: "official" as Source["kind"],
    url: "",
    allowedHosts: "",
    enabled: true,
  });
  const add = (e: FormEvent) => {
    e.preventDefault();
    void mutate("/api/sources", "POST", {
      ...f,
      allowedHosts: list(f.allowedHosts),
    });
  };
  return (
    <div className="split">
      <Card title="添加招聘来源">
        <form className="form" onSubmit={add}>
          <label>
            名称
            <input
              required
              value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })}
            />
          </label>
          <label>
            类型
            <select
              value={f.kind}
              onChange={(e) =>
                setF({ ...f, kind: e.target.value as Source["kind"] })
              }
            >
              <option value="official">公司官网</option>
              <option value="boss">BOSS</option>
            </select>
          </label>
          <label>
            入口网址
            <input
              type="url"
              required
              value={f.url}
              onChange={(e) => setF({ ...f, url: e.target.value })}
            />
          </label>
          <label>
            允许的域名
            <input
              required
              placeholder="careers.example.com"
              value={f.allowedHosts}
              onChange={(e) => setF({ ...f, allowedHosts: e.target.value })}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={f.enabled}
              onChange={(e) => setF({ ...f, enabled: e.target.checked })}
            />
            启用此来源
          </label>
          <button>添加来源</button>
        </form>
      </Card>
      <Card title="已添加来源">
        {sources.length ? (
          sources.map((s) => (
            <div className="row" key={s.id}>
              <div>
                <strong>{s.name}</strong>
                <small>
                  {s.kind === "boss" ? "BOSS" : "官网"} ·{" "}
                  {s.lastError
                    ? `上次错误：${s.lastError}`
                    : s.lastSuccess
                      ? `上次同步：${new Date(s.lastSuccess).toLocaleString()}`
                      : "尚未同步"}
                </small>
              </div>
              <div>
                <button
                  className="quiet"
                  disabled={!s.enabled}
                  onClick={() =>
                    void mutate(`/api/sources/${s.id}/sync`, "POST")
                  }
                >
                  同步
                </button>
                <button
                  className="danger link"
                  onClick={() => void mutate(`/api/sources/${s.id}`, "DELETE")}
                >
                  移除
                </button>
              </div>
            </div>
          ))
        ) : (
          <Empty
            title="还没有来源"
            detail="添加公开入口和允许域名后，才能建立采集任务。"
          />
        )}
      </Card>
    </div>
  );
}
function Jobs({
  s,
  mutate,
}: {
  s: State;
  mutate: <T>(p: string, m: string, b?: unknown) => Promise<T | undefined>;
}) {
  const [filters, setFilters] = useState({
      query: "",
      company: "",
      title: "",
      location: "",
      salaryMin: 0,
      exact: false,
      semantic: false,
    }),
    [results, setResults] = useState<Job[] | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [preview, setPreview] = useState<{
      previewId: string;
      applications: Application[];
    } | null>(null),
    [singlePreview, setSinglePreview] = useState<{
      application: Application;
      configurationKey: string;
      expectedContentHash: string;
      acceptReview: boolean;
    } | null>(null),
    [startingSingle, setStartingSingle] = useState(false);
  const jobs = results ?? s.jobs;
  const search = async (e: FormEvent) => {
    e.preventDefault();
    const r = await mutate<Job[]>("/api/jobs/search", "POST", filters);
    if (r) setResults(r);
  };
  const assess = () => void mutate("/api/assess", "POST", { jobIds: selected });
  const makePreview = async () => {
    const r = await mutate<{ previewId: string; applications: Application[] }>(
      "/api/batches/preview",
      "POST",
      { jobIds: selected },
    );
    if (r) setPreview(r);
  };
  const makeSinglePreview = async () => {
    const job = s.jobs.find((item) => item.id === selected[0]);
    if (selected.length !== 1 || !job) return;
    const acceptReview = job.assessment?.decision === "review";
    const r = await mutate<{
      application: Application;
      configurationKey: string;
    }>("/api/extension-application/preview", "POST", {
      jobId: job.id,
      expectedContentHash: job.contentHash,
      acceptReview,
    });
    if (r)
      setSinglePreview({
        ...r,
        expectedContentHash: job.contentHash,
        acceptReview,
      });
  };
  return (
    <>
      <Card title="筛选岗位">
        <form className="search" onSubmit={search}>
          <input
            placeholder="关键词"
            value={filters.query}
            onChange={(e) => setFilters({ ...filters, query: e.target.value })}
          />
          <input
            placeholder="公司"
            value={filters.company}
            onChange={(e) =>
              setFilters({ ...filters, company: e.target.value })
            }
          />
          <input
            placeholder="职位"
            value={filters.title}
            onChange={(e) => setFilters({ ...filters, title: e.target.value })}
          />
          <input
            placeholder="城市"
            value={filters.location}
            onChange={(e) =>
              setFilters({ ...filters, location: e.target.value })
            }
          />
          <input
            type="number"
            placeholder="最低月薪"
            value={filters.salaryMin || ""}
            onChange={(e) =>
              setFilters({ ...filters, salaryMin: Number(e.target.value) })
            }
          />
          <label className="check">
            <input
              type="checkbox"
              checked={filters.exact}
              onChange={(e) =>
                setFilters({ ...filters, exact: e.target.checked })
              }
            />
            精确匹配
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={filters.semantic}
              onChange={(e) =>
                setFilters({ ...filters, semantic: e.target.checked })
              }
            />
            语义搜索
          </label>
          <button>搜索</button>
        </form>
      </Card>
      <div className="toolbar">
        <span>已选 {selected.length} / 10</span>
        <button
          className="quiet"
          disabled={!selected.length || !s.resume}
          onClick={assess}
        >
          评估匹配
        </button>
        <button
          disabled={!selected.length || selected.length > 10}
          onClick={() => void makePreview()}
        >
          生成投递预览
        </button>
        <button
          disabled={selected.length !== 1 || !s.resume}
          onClick={() => void makeSinglePreview()}
        >
          普通浏览器单岗位验证
        </button>
      </div>
      {!jobs.length ? (
        <Empty
          title="没有岗位数据"
          detail="先在招聘来源中添加入口并同步，或由你的流程导入岗位。"
        />
      ) : (
        <div className="job-list">
          {jobs.map((j) => (
            <JobItem
              key={j.id}
              job={j}
              checked={selected.includes(j.id)}
              onSelect={() =>
                setSelected((x) =>
                  x.includes(j.id)
                    ? x.filter((id) => id !== j.id)
                    : x.length < 10
                      ? [...x, j.id]
                      : x,
                )
              }
            />
          ))}
        </div>
      )}
      {preview && (
        <Dialog title="投递预览" onClose={() => setPreview(null)}>
          <p>
            以下 {preview.applications.length}{" "}
            个岗位将进入队列。系统会先执行平台原生“打招呼”；消息与附件各自记录状态，避免把“简历已发”误认成“问候已发送”。
          </p>
          {preview.applications.map((a) => (
            <p key={a.id}>
              <strong>
                {a.job.company} · {a.job.title}
              </strong>
              <br />
              {a.frozenMessages.join(" / ")}
            </p>
          ))}
          <button
            onClick={async () => {
              const r = await mutate<{ count: number }>(
                "/api/batches",
                "POST",
                { previewId: preview.previewId },
              );
              if (r) setPreview(null);
            }}
          >
            确认入队
          </button>
        </Dialog>
      )}
      {singlePreview && (
        <Dialog
          title="单岗位投递确认"
          onClose={() => {
            if (!startingSingle) setSinglePreview(null);
          }}
        >
          <p>
            <strong>
              {singlePreview.application.job.company} ·{" "}
              {singlePreview.application.job.title}
            </strong>
          </p>
          {singlePreview.acceptReview && (
            <p>
              该岗位处于匹配度复核区间，硬条件均已通过。确认后只允许这个岗位进入投递，不改变全局匹配策略。
            </p>
          )}
          <p>
            扩展将核对岗位和收件人，先执行平台原生打招呼，再依次发送以下话术：
          </p>
          {singlePreview.application.frozenMessages.map((message, index) => (
            <p key={index} style={{ whiteSpace: "pre-wrap" }}>
              {message}
            </p>
          ))}
          <p>
            {singlePreview.application.actions.some(
              (action) => action.kind === "attachment",
            )
              ? "话术确认发送后，再发送当前简历附件。等待对方同意或发送结果不明确时会暂停，并记录实际状态。"
              : "当前话术配置只发送消息。"}
          </p>
          {s.paused && <p>投递队列已暂停，请先通过页面顶部恢复队列。</p>}
          <button
            disabled={startingSingle || s.paused}
            onClick={async () => {
              setStartingSingle(true);
              try {
                const r = await mutate<{ applicationId: string }>(
                  "/api/extension-application/start",
                  "POST",
                  {
                    jobId: singlePreview.application.job.id,
                    expectedContentHash: singlePreview.expectedContentHash,
                    acceptReview: singlePreview.acceptReview,
                    expectedConfigurationKey: singlePreview.configurationKey,
                  },
                );
                if (r) setSinglePreview(null);
              } finally {
                setStartingSingle(false);
              }
            }}
          >
            {startingSingle ? "正在启动…" : "确认发送并启动"}
          </button>
        </Dialog>
      )}
    </>
  );
}
function JobItem({
  job,
  checked,
  onSelect,
}: {
  job: Job;
  checked: boolean;
  onSelect: () => void;
}) {
  const a = job.assessment;
  return (
    <article className="job">
      <label className="pick">
        <input type="checkbox" checked={checked} onChange={onSelect} />
        <span className="sr-only">选择 {job.title}</span>
      </label>
      <div className="job-main">
        <div className="job-head">
          <h2>{job.title}</h2>
          <a href={job.url} target="_blank" rel="noreferrer">
            原始来源 ↗
          </a>
        </div>
        <p>
          {job.company} · {job.location ?? "地点未标注"} ·{" "}
          {money(job.salaryMin)}–{money(job.salaryMax)}
        </p>
        <p className="muted">
          {job.description.slice(0, 180)}
          {job.description.length > 180 ? "…" : ""}
        </p>
        {job.similarity !== null && job.similarity !== undefined && (
          <p className="similarity">
            内容相似度 {Math.round(job.similarity * 100)}%{" "}
            <span>仅用于排序，不代表适合投递。</span>
          </p>
        )}
        <AssessmentView assessment={a} />
      </div>
    </article>
  );
}
function AssessmentView({
  assessment,
}: {
  assessment: Assessment | null | undefined;
}) {
  if (!assessment) return <p className="muted">尚未评估适配度。</p>;
  const decisionLabels: Record<string, string> = {
    eligible: "符合门槛",
    review: "待复核",
    skip: "不符合条件",
    unavailable: "评估失败",
  };
  return (
    <details>
      <summary>
        <span className={`badge ${assessment.decision}`}>
          {decisionLabels[assessment.decision] ?? assessment.decision}
        </span>{" "}
        {assessment.score === null
          ? assessment.decision === "skip"
            ? "未通过必要条件，未调用模型"
            : assessment.decision === "unavailable"
              ? "模型评分暂不可用"
              : "尚无评分"
          : `适配度 ${assessment.score}`}
      </summary>
      <div className="assessment">
        <p>{assessment.reasons.join("；") || "暂无额外说明"}</p>
        <div className="gates">
          {assessment.gates.map((g) => (
            <span key={g.field} className={`gate ${g.status}`}>
              {g.field}：{g.reason}
            </span>
          ))}
        </div>
        {Object.entries(assessment.dimensions).map(([k, v]) => (
          <p key={k}>
            <strong>{k}</strong> {v.score} 分：{v.evidence}
          </p>
        ))}
      </div>
    </details>
  );
}
function Models({
  s,
  mutate,
}: {
  s: State;
  mutate: <T>(p: string, m: string, b?: unknown) => Promise<T | undefined>;
}) {
  const [providers, setProviders] = useState(s.providers),
    [embedding, setEmbedding] = useState(s.embedding),
    [msg, setMsg] = useState("");
  useEffect(() => {
    setProviders(s.providers);
    setEmbedding(s.embedding);
  }, [s.providers, s.embedding]);
  const update = (index: number, change: Partial<Provider>) =>
    setProviders(
      providers.map((p, i) => (i === index ? { ...p, ...change } : p)),
    );
  const withoutBlankKeys = () =>
    providers.map(({ apiKey, ...p }) =>
      apiKey?.trim() ? { ...p, apiKey: apiKey.trim() } : p,
    );
  const savedProvider = (p: Provider) =>
    !p.apiKey?.trim() &&
    s.providers.some(
      (saved) =>
        saved.id === p.id &&
        saved.baseUrl === p.baseUrl &&
        saved.model === p.model &&
        saved.kind === p.kind &&
        saved.protocol === p.protocol &&
        saved.timeoutMs === p.timeoutMs,
    );
  const embeddingSaved =
    !embedding.apiKey?.trim() &&
    embedding.enabled === s.embedding.enabled &&
    embedding.baseUrl === s.embedding.baseUrl &&
    embedding.model === s.embedding.model;
  return (
    <div className="models">
      <Card title="聊天模型">
        <p>
          密钥只在填写或替换时提交；已保存的密钥以占位提示显示，留空不会覆盖。
          修改配置后请先保存，再测试连接。
        </p>
        {providers.map((p, i) => (
          <fieldset className="provider" key={p.id}>
            <legend>模型 {i + 1}</legend>
            <label>
              名称
              <input
                value={p.name}
                onChange={(e) => update(i, { name: e.target.value })}
              />
            </label>
            <label>
              类型
              <select
                value={p.kind}
                onChange={(e) =>
                  update(i, { kind: e.target.value as Provider["kind"] })
                }
              >
                <option value="openai-compatible">OpenAI 兼容</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <label>
              服务地址
              <input
                type="url"
                value={p.baseUrl}
                onChange={(e) => update(i, { baseUrl: e.target.value })}
              />
            </label>
            <label>
              模型名
              <input
                value={p.model}
                onChange={(e) => update(i, { model: e.target.value })}
              />
            </label>
            <label>
              协议
              <select
                value={p.protocol}
                onChange={(e) =>
                  update(i, {
                    protocol: e.target.value as Provider["protocol"],
                  })
                }
              >
                <option value="chat-completions">Chat Completions</option>
                <option value="responses">Responses</option>
              </select>
            </label>
            <label>
              优先级
              <input
                type="number"
                min="0"
                max="100"
                value={p.priority}
                onChange={(e) =>
                  update(i, { priority: Number(e.target.value) })
                }
              />
            </label>
            <label>
              超时（毫秒）
              <input
                type="number"
                min="1000"
                max="180000"
                value={p.timeoutMs}
                onChange={(e) =>
                  update(i, { timeoutMs: Number(e.target.value) })
                }
              />
            </label>
            <label>
              密钥
              <input
                type="password"
                placeholder={p.hasKey ? "已保存；留空不变" : "API Key"}
                value={p.apiKey ?? ""}
                onChange={(e) => update(i, { apiKey: e.target.value })}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={p.enabled}
                onChange={(e) => update(i, { enabled: e.target.checked })}
              />
              启用
            </label>
            <div>
              <button
                type="button"
                className="quiet"
                onClick={() =>
                  void mutate<Json>("/api/providers/test", "POST", {
                    id: p.id,
                  }).then((r) => r && setMsg(`${p.name} 已收到连接测试结果。`))
                }
                disabled={!savedProvider(p)}
                title={
                  savedProvider(p) ? "测试已保存的配置" : "请先保存模型配置"
                }
              >
                测试
              </button>
              <button
                type="button"
                className="danger link"
                onClick={() =>
                  setProviders(providers.filter((_, n) => n !== i))
                }
              >
                移除
              </button>
            </div>
          </fieldset>
        ))}
        <div className="button-row">
          <button
            className="quiet"
            onClick={() =>
              setProviders([
                ...providers,
                {
                  id: crypto.randomUUID(),
                  name: "新模型",
                  kind: "openai-compatible",
                  baseUrl: "https://api.openai.com/v1",
                  model: "",
                  protocol: "chat-completions",
                  enabled: true,
                  priority: providers.length,
                  timeoutMs: 30000,
                },
              ])
            }
          >
            添加模型
          </button>
          <button
            onClick={() =>
              void mutate("/api/providers", "PUT", withoutBlankKeys()).then(
                (r) => r && setMsg("模型配置已保存。"),
              )
            }
          >
            保存模型
          </button>
        </div>
      </Card>
      <Card title="向量模型">
        <p>
          向量搜索独立于聊天模型。它只计算岗位文本相似度，不能代替适配评估。
        </p>
        <div className="form">
          <label className="check">
            <input
              type="checkbox"
              checked={embedding.enabled}
              onChange={(e) =>
                setEmbedding({ ...embedding, enabled: e.target.checked })
              }
            />
            启用向量搜索
          </label>
          <label>
            服务地址
            <input
              type="url"
              value={embedding.baseUrl}
              onChange={(e) =>
                setEmbedding({ ...embedding, baseUrl: e.target.value })
              }
            />
          </label>
          <label>
            模型
            <input
              value={embedding.model}
              onChange={(e) =>
                setEmbedding({ ...embedding, model: e.target.value })
              }
            />
          </label>
          <label>
            密钥
            <input
              type="password"
              placeholder={embedding.hasKey ? "已保存；留空不变" : "API Key"}
              value={embedding.apiKey ?? ""}
              onChange={(e) =>
                setEmbedding({ ...embedding, apiKey: e.target.value })
              }
            />
          </label>
          <div className="button-row">
            <button
              className="quiet"
              onClick={() =>
                void mutate("/api/embedding/test", "POST").then(
                  (r) => r && setMsg("向量连接测试已返回结果。"),
                )
              }
              disabled={!embeddingSaved}
              title={
                embeddingSaved ? "测试已保存的向量配置" : "请先保存向量配置"
              }
            >
              测试连接
            </button>
            <button
              onClick={() => {
                const { apiKey, ...rest } = embedding;
                void mutate(
                  "/api/embedding",
                  "PUT",
                  apiKey?.trim() ? { ...rest, apiKey: apiKey.trim() } : rest,
                ).then((r) => r && setMsg("向量配置已保存。"));
              }}
            >
              保存向量配置
            </button>
          </div>
        </div>
      </Card>
      <Card title="ChatGPT 连接">
        <ChatGPT mutate={mutate} />
      </Card>
      {msg && (
        <p className="ok" role="status">
          {msg}
        </p>
      )}
    </div>
  );
}
type DeviceLogin = {
  verificationUrl: string;
  userCode: string;
  loginId?: string;
};
const getString = (value: unknown, key: string) =>
  isRecord(value) && typeof value[key] === "string" ? value[key] : null;
function ChatGPT({
  mutate,
}: {
  mutate: <T>(p: string, m: string, b?: unknown) => Promise<T | undefined>;
}) {
  const [account, setAccount] = useState("尚未读取账户状态。"),
    [models, setModels] = useState<string[]>([]),
    [device, setDevice] = useState<DeviceLogin | null>(null),
    [loginBusy, setLoginBusy] = useState(false),
    [copied, setCopied] = useState("");
  const readAccount = async () => {
    const r = await mutate<unknown>("/api/chatgpt/account", "GET");
    if (r !== undefined) {
      setAccount(accountLabel(r));
      if (isChatGPTAccount(r)) setDevice(null);
    }
  };
  const readModels = async () => {
    const r = await mutate<unknown>("/api/chatgpt/models", "GET");
    if (r !== undefined) setModels(modelNames(r));
  };
  const login = async () => {
    if (loginBusy) return;
    setLoginBusy(true);
    setDevice(null);
    try {
      const r = await mutate<unknown>("/api/chatgpt/login", "POST");
      const verificationUrl = getString(r, "verificationUrl"),
        userCode = getString(r, "userCode");
      if (verificationUrl && userCode) {
        try {
          const u = new URL(verificationUrl);
          if (u.protocol === "https:")
            setDevice({
              verificationUrl: u.toString(),
              userCode,
              loginId: getString(r, "loginId") ?? undefined,
            });
          else setAccount("登录服务返回了非 HTTPS 验证地址，未显示该链接。");
        } catch {
          setAccount("登录服务返回了无效的验证地址。");
        }
      }
    } finally {
      setLoginBusy(false);
    }
  };
  return (
    <div className="chatgpt">
      <p>{account}</p>
      <p className="muted">
        该连接的能力状态由服务端验证；连接成功不代表可用于岗位评分。
      </p>
      <div className="button-row">
        <button className="quiet" onClick={() => void readAccount()}>
          账户状态
        </button>
        <button className="quiet" onClick={() => void readModels()}>
          可用模型
        </button>
        <button disabled={loginBusy} onClick={() => void login()}>
          {loginBusy ? "正在获取设备码…" : "登录 / 连接设备"}
        </button>
      </div>
      {device && (
        <div className="device">
          <strong>在浏览器中完成 ChatGPT 授权</strong>
          <p>
            请先在 ChatGPT
            安全设置中启用设备代码登录，并使用下方当前设备码完成授权。
          </p>
          <p>
            验证码：<code>{device.userCode}</code>
          </p>
          <a href={device.verificationUrl} target="_blank" rel="noreferrer">
            打开安全验证页面 ↗
          </a>
        </div>
      )}
      {models.length > 0 && (
        <ul className="model-names">
          {models.map((name) => (
            <li key={name}>
              <code>{name}</code>
              <button
                className="link"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(name)
                    .then(() => setCopied(name))
                    .catch(() => setCopied("复制失败，请手动复制"))
                }
              >
                {copied === name ? "已复制" : "复制"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
function Records({
  s,
  mutate,
}: {
  s: State;
  mutate: <T>(p: string, m: string, b?: unknown) => Promise<T | undefined>;
}) {
  const stopReasons: Record<string, string> = {
    "recipient-mismatch": "当前会话与目标岗位或公司无法对应，已停止。",
    "page-unrecognized": "未能可靠识别目标页面，已停止。",
    "login-required": "需要登录 BOSS 后人工核对。",
    "verification-required": "需要完成 BOSS 页面验证后人工核对。",
    "send-unconfirmed": "未观察到明确发送回执，不会自动重发。",
    "attachment-pending": "简历请求正在等待对方同意，尚未确认附件送达。",
    cancelled: "暂停、配置变化或发送前授权失效，已停止。",
  };
  const [busy, setBusy] = useState(false),
    [downloadError, setDownloadError] = useState("");
  const save = async (
    path: string,
    method: "GET" | "POST",
    name: string,
    type: string,
  ) => {
    if (busy) return;
    setBusy(true);
    setDownloadError("");
    try {
      await download(path, method, name, type);
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : "下载失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      {downloadError && (
        <div role="alert" className="notice">
          {downloadError}
        </div>
      )}
      <div className="toolbar">
        <button
          className="quiet"
          disabled={busy}
          onClick={() =>
            void save(
              "/api/export",
              "GET",
              "job-assistant-export.json",
              "application/json",
            )
          }
        >
          导出 JSON
        </button>
        <button
          className="quiet"
          disabled={busy}
          onClick={() =>
            void save(
              "/api/backup",
              "POST",
              "job-assistant.sqlite",
              "application/vnd.sqlite3",
            )
          }
        >
          {busy ? "正在准备…" : "下载备份"}
        </button>
      </div>
      <Card title="投递记录">
        {s.applications.length ? (
          s.applications.map((a) => (
            <article className="record" key={a.id}>
              <div>
                <strong>
                  {a.job.company} · {a.job.title}
                </strong>
                <p>
                  <span className={`badge ${a.status}`}>{a.status}</span> ·{" "}
                  {new Date(a.createdAt).toLocaleString()}
                </p>
                {a.stopReason && (
                  <p>{stopReasons[a.stopReason] ?? "投递需人工核对。"}</p>
                )}
                {a.pageDiagnostic?.stage === "conversation" && (
                  <p>
                    会话识别：输入框 {a.pageDiagnostic.editorCount}
                    ，当前岗位区域 {a.pageDiagnostic.activeJobCardCount}
                    ，目标岗位链接 {a.pageDiagnostic.exactJobLinkCount}
                    ，雇主匹配 {a.pageDiagnostic.employerFieldMatchCount}。
                  </p>
                )}
                {a.status === "needs-review" &&
                  ["page-unrecognized", "recipient-mismatch"].includes(
                    a.stopReason ?? "",
                  ) &&
                  a.actions.length > 0 &&
                  a.actions.every((action) => action.state === "pending") && (
                    <button
                      className="quiet"
                      disabled={s.paused}
                      onClick={() =>
                        void mutate(
                          "/api/extension-application/retry",
                          "POST",
                          { applicationId: a.id },
                        )
                      }
                    >
                      重试尚未发送的任务
                    </button>
                  )}
              </div>
              <div>
                {a.actions.map((x, i) => (
                  <p key={i}>
                    <strong>
                      {x.kind === "native-greeting"
                        ? "平台打招呼"
                        : x.kind === "attachment"
                          ? "简历附件"
                          : "消息"}
                    </strong>
                    ：{x.state}
                    {x.evidence ? `（${x.evidence}）` : ""}
                    {x.resolution === "contact-exists"
                      ? "；已核对已有沟通，保留未知记录，不重发招呼"
                      : ""}
                  </p>
                ))}
              </div>
            </article>
          ))
        ) : (
          <Empty
            title="还没有投递记录"
            detail="确认批次后，每个动作都会单独保存状态和证据。"
          />
        )}
      </Card>
    </div>
  );
}
function Browser({
  s,
  mutate,
}: {
  s: State;
  mutate: <T>(p: string, m: string, b?: unknown) => Promise<T | undefined>;
}) {
  const [status, setStatus] = useState<Json | null>(null),
    [show, setShow] = useState(s.takeover);
  useEffect(() => setShow(s.takeover), [s.takeover]);
  const describe = (x: Json | null) => {
    if (!x) return "尚未读取浏览器服务状态。";
    const ready = x.ready === true ? "服务已就绪" : "服务尚未就绪";
    const adapter =
      x.liveApplyReady === false
        ? "BOSS 实际发送适配尚未验证，已禁用"
        : `适配器：${String(x.bossAdapter ?? "未报告")}`;
    return `${ready}。${adapter}。${x.takeover === true ? "当前处于人工接管。" : "当前未接管。"}${x.working === true ? " 正在处理任务。" : ""}`;
  };
  const read = async () => {
    const r = await mutate<Json>("/api/browser/status", "GET");
    if (r) setStatus(r);
  };
  const takeover = async () => {
    const r = await mutate<Json>("/api/browser/takeover", "POST");
    if (r) {
      setShow(true);
      setStatus(r);
    }
  };
  return (
    <div className="browser">
      <ExtensionPanel mutate={mutate} />
      <Card title="受控浏览器">
        <p>
          接管会暂停自动队列，让你在隔离浏览器中完成登录、验证码或人工核对。仅接管成功后才会显示远程浏览画面。
        </p>
        <p className="muted" aria-live="polite">
          {describe(status)}
        </p>
        {typeof status?.navigationError === "string" && (
          <p role="status">{status.navigationError}</p>
        )}
        <button className="quiet" onClick={() => void read()}>
          检查状态
        </button>
        {s.takeover ? (
          <button
            onClick={async () => {
              const r = await mutate<Json>("/api/browser/release", "POST");
              if (r) {
                setShow(false);
                setStatus(r);
              }
            }}
          >
            结束人工接管
          </button>
        ) : (
          <button onClick={() => void takeover()}>开始人工接管</button>
        )}
      </Card>
      {s.takeover && show && (
        <Card title="人工接管画面">
          <iframe
            title="受控浏览器"
            src="/browser/vnc.html?autoconnect=1&resize=scale&path=browser/websockify"
          />
        </Card>
      )}
      <Card title="实际发送保护">
        <p>
          即使已生成投递预览，BOSS
          的实际发送仍由后端验证决定。若尚未验证，系统会如实返回错误，不会伪造发送成功。
        </p>
      </Card>
    </div>
  );
}
function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const priorFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    priorFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeRef.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      priorFocus.current?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <button
          ref={closeRef}
          className="close"
          aria-label="关闭"
          onClick={onClose}
        >
          ×
        </button>
        <h2 id="dialog-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}
export default App;
