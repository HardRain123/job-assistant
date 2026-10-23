import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type {
  Job,
  Task,
  Application,
  ApplicationAction,
} from "../../contracts/src/index.ts";

export const actionCompleteForExistingContact = (action: ApplicationAction) =>
  action.state === "confirmed" ||
  action.state === "skipped" ||
  (action.state === "unknown" &&
    action.evidence === "send-unconfirmed" &&
    ((action.kind === "native-greeting" &&
      action.resolution === "contact-exists") ||
      (action.kind === "message" &&
        action.resolution === "user-confirmed-sent")));

export const shanghaiDate = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_version VALUES(1);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, source_key TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, job_id TEXT NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(job_id,hash));
      CREATE TABLE IF NOT EXISTS applications(id TEXT PRIMARY KEY, job_id TEXT UNIQUE NOT NULL, batch_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, lease_token TEXT, lease_until TEXT, result TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, event TEXT NOT NULL, body TEXT NOT NULL);`);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS contact_quota(action_id TEXT PRIMARY KEY, app_id TEXT NOT NULL, day TEXT NOT NULL)",
    );
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  get<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key);
    return row ? (JSON.parse(String(row.value)) as T) : fallback;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  audit(event: string, body: unknown) {
    this.db
      .prepare("INSERT INTO audit(at,event,body) VALUES(?,?,?)")
      .run(new Date().toISOString(), event, JSON.stringify(body));
  }
  jobs(): Job[] {
    return this.db
      .prepare("SELECT body FROM jobs ORDER BY rowid DESC")
      .all()
      .map((r) => JSON.parse(String(r.body)));
  }
  job(id: string): Job | undefined {
    const r = this.db.prepare("SELECT body FROM jobs WHERE id=?").get(id);
    return r ? JSON.parse(String(r.body)) : undefined;
  }
  upsertJob(job: Job) {
    const key = `${job.source}:${job.sourceId}:${job.sourceJobId || job.url}`;
    const existing = this.db
      .prepare("SELECT body FROM jobs WHERE source_key=?")
      .get(key);
    const prev: Job | undefined = existing
      ? JSON.parse(String(existing.body))
      : undefined;
    const {
      id: ignoredId,
      firstSeen: ignoredFirst,
      lastSeen: ignoredLast,
      contentHash: ignoredHash,
      ...content
    } = job;
    const next = {
      ...job,
      id: prev?.id ?? job.id,
      firstSeen: prev?.firstSeen ?? job.firstSeen,
      contentHash: createHash("sha256")
        .update(JSON.stringify(content))
        .digest("hex"),
    };
    this.db
      .prepare(
        "INSERT INTO jobs VALUES(?,?,?) ON CONFLICT(source_key) DO UPDATE SET body=excluded.body",
      )
      .run(next.id, key, JSON.stringify(next));
    this.db
      .prepare("INSERT OR IGNORE INTO snapshots VALUES(?,?,?,?,?)")
      .run(
        randomUUID(),
        next.id,
        next.contentHash,
        JSON.stringify(next),
        new Date().toISOString(),
      );
    return next;
  }
  applications(): Application[] {
    return this.db
      .prepare("SELECT body FROM applications ORDER BY rowid DESC")
      .all()
      .map((r) => JSON.parse(String(r.body)));
  }
  application(id: string): Application | undefined {
    const r = this.db
      .prepare("SELECT body FROM applications WHERE id=?")
      .get(id);
    return r ? JSON.parse(String(r.body)) : undefined;
  }
  insertApplication(app: Application) {
    this.db
      .prepare("INSERT INTO applications VALUES(?,?,?,?)")
      .run(app.id, app.jobId, app.batchId, JSON.stringify(app));
  }
  updateApplication(app: Application) {
    this.db
      .prepare("UPDATE applications SET body=? WHERE id=?")
      .run(JSON.stringify(app), app.id);
  }
  reusableCancelledApplication(app: Application) {
    return (
      app.status === "cancelled" &&
      app.actions.length > 0 &&
      app.actions.every(
        (action) =>
          action.state === "pending" && !action.evidence && !action.resolution,
      ) &&
      !this.db
        .prepare("SELECT action_id FROM contact_quota WHERE app_id=? LIMIT 1")
        .get(app.id)
    );
  }
  archiveCancelledApplication(app: Application) {
    const current = this.application(app.id);
    if (
      !current ||
      !this.reusableCancelledApplication(current) ||
      this.tasks().some(
        (task) =>
          ["queued", "leased"].includes(task.status) &&
          (task.payload as Application)?.id === app.id,
      )
    )
      throw new Error("仅从未执行且已取消的记录可以重新进入批次");
    // Preserve the full frozen draft and all old tasks; only release the unique job slot.
    this.audit("application.unattemptedCancelledArchived", {
      application: current,
    });
    this.db.prepare("DELETE FROM applications WHERE id=?").run(app.id);
  }
  dailyQuota(date = new Date(), limit = this.get("bulk.dailyLimit", 150)) {
    // Import historical attempts once. Existing-contact navigation does not consume a new contact.
    const applications = this.applications();
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO contact_quota VALUES(?,?,?)",
    );
    for (const application of applications) {
      for (const action of application.actions) {
        if (
          action.kind === "native-greeting" &&
          !["pending", "skipped"].includes(action.state)
        )
          insert.run(
            action.id,
            application.id,
            shanghaiDate(new Date(action.updatedAt)),
          );
      }
    }
    const day = shanghaiDate(date);
    const entries = this.db
      .prepare("SELECT action_id,app_id FROM contact_quota WHERE day=?")
      .all(day);
    let contacts = 0,
      completed = 0,
      uncertain = 0;
    for (const entry of entries) {
      const application = applications.find((a) => a.id === entry.app_id);
      const action = application?.actions.find((a) => a.id === entry.action_id);
      if (action?.state === "confirmed") contacts++;
      if (application?.status === "completed") completed++;
      if (
        !application ||
        application.actions.some(
          (a) =>
            ["started", "unknown"].includes(a.state) &&
            !actionCompleteForExistingContact(a),
        )
      )
        uncertain++;
    }
    return {
      date: day,
      limit,
      occupied: entries.length,
      contacts,
      completed,
      uncertain,
      remaining: Math.max(0, limit - entries.length),
    };
  }
  reserveContact(application: Application, action: ApplicationAction) {
    if (action.kind !== "native-greeting") return;
    if (
      this.db
        .prepare("SELECT action_id FROM contact_quota WHERE action_id=?")
        .get(action.id)
    )
      return;
    const quota = this.dailyQuota();
    if (quota.remaining <= 0) throw new Error("daily-limit");
    this.db
      .prepare("INSERT INTO contact_quota VALUES(?,?,?)")
      .run(action.id, application.id, quota.date);
  }
  enqueue(kind: Task["kind"], payload: unknown) {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO tasks(id,kind,status,payload,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        id,
        kind,
        "queued",
        JSON.stringify(payload),
        new Date().toISOString(),
      );
    return id;
  }
  tasks(): Task[] {
    return this.db
      .prepare("SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC")
      .all()
      .map((r) => this.taskRow(r));
  }
  taskRow(r: Record<string, unknown>): Task {
    return {
      id: String(r.id),
      kind: r.kind as Task["kind"],
      status: r.status as Task["status"],
      payload: JSON.parse(String(r.payload)),
      leaseToken: r.lease_token ? String(r.lease_token) : null,
      leaseUntil: r.lease_until ? String(r.lease_until) : null,
    };
  }
  recoverExpired() {
    const expired = this.db
      .prepare("SELECT * FROM tasks WHERE status='leased' AND lease_until < ?")
      .all(new Date().toISOString());
    for (const row of expired) {
      const task = this.taskRow(row);
      this.db
        .prepare(
          "UPDATE tasks SET status=?,lease_token=NULL,lease_until=NULL WHERE id=?",
        )
        .run(task.kind === "apply" ? "needs-review" : "queued", task.id);
      if (task.kind === "apply") {
        const app = this.application((task.payload as Application).id);
        if (app) {
          app.status = "needs-review";
          app.actions = app.actions.map((a) =>
            a.state === "started" ? { ...a, state: "unknown" } : a,
          );
          this.updateApplication(app);
        }
      }
    }
  }
  claim(executor: "worker" | "extension" = "worker", taskId?: string): Task | null {
    return this.transaction(() => {
      this.recoverExpired();
      if (this.get("paused", false) || this.get("takeover", false)) return null;
      if (this.db.prepare("SELECT id FROM tasks WHERE status='leased'").get())
        return null;
      const row = this.db
        .prepare(
          executor === "extension"
            ? "SELECT * FROM tasks WHERE status='queued' AND kind='apply' AND json_extract(payload,'$.executor')='extension' AND (? IS NULL OR id=?) ORDER BY created_at, rowid LIMIT 1"
            : "SELECT * FROM tasks WHERE status='queued' AND (kind!='apply' OR coalesce(json_extract(payload,'$.executor'),'worker')='worker') AND (? IS NULL OR id=?) ORDER BY created_at, rowid LIMIT 1",
        )
        .get(taskId ?? null, taskId ?? null);
      if (!row) return null;
      const task = this.taskRow(row);
      task.status = "leased";
      task.leaseToken = randomUUID();
      task.leaseUntil = new Date(Date.now() + 60000).toISOString();
      this.db
        .prepare(
          "UPDATE tasks SET status=?,lease_token=?,lease_until=? WHERE id=?",
        )
        .run(task.status, task.leaseToken, task.leaseUntil, task.id);
      if (task.kind === "apply") {
        const app = this.application((task.payload as Application).id);
        if (app) {
          app.status = "running";
          this.updateApplication(app);
          task.payload = app;
        }
      }
      return task;
    });
  }
  requireLease(id: string, token: string): Task {
    const r = this.db
      .prepare(
        "SELECT * FROM tasks WHERE id=? AND status='leased' AND lease_token=? AND lease_until>=?",
      )
      .get(id, token, new Date().toISOString());
    if (!r) throw new Error("任务租约无效，需要人工核对");
    return this.taskRow(r);
  }
  heartbeat(id: string, token: string) {
    this.requireLease(id, token);
    this.db
      .prepare("UPDATE tasks SET lease_until=? WHERE id=?")
      .run(new Date(Date.now() + 60000).toISOString(), id);
  }
  recordAction(
    taskId: string,
    token: string,
    appId: string,
    action: ApplicationAction,
    onTransition?: (changed: boolean) => void,
  ) {
    return this.transaction(() => {
      const task = this.requireLease(taskId, token);
      if (task.kind !== "apply" || (task.payload as Application).id !== appId)
        throw new Error("动作不属于当前任务");
      if (
        action.state === "started" &&
        (this.get("takeover", false) || this.get("paused", false))
      )
        throw new Error("任务已暂停或被接管");
      const app = this.application(appId);
      if (!app) throw new Error("投递记录不存在");
      const old = app.actions.find((a) => a.id === action.id);
      if (
        !old ||
        old.kind !== action.kind ||
        old.index !== action.index ||
        old.text !== action.text ||
        old.resolution !== action.resolution
      )
        throw new Error("动作与冻结批次不一致");
      if (old.state === action.state) {
        onTransition?.(false);
        return app;
      }
      const transitions: Record<string, string[]> = {
        pending: ["started", "skipped"],
        started: ["confirmed", "unknown", "failed", "awaiting-acceptance"],
        unknown: [],
        confirmed: [],
        failed: [],
        skipped: [],
        "awaiting-acceptance": [],
      };
      if (!transitions[old.state]?.includes(action.state))
        throw new Error("不允许重复或倒退动作状态");
      if (
        action.state === "started" &&
        action.kind !== "native-greeting" &&
        app.actions.some(
          (a) => a.index < action.index && !actionCompleteForExistingContact(a),
        )
      )
        throw new Error("前序话术尚未确认发送");
      if (action.state === "started") this.reserveContact(app, action);
      app.actions = app.actions.map((a) =>
        a.id === action.id
          ? { ...action, updatedAt: new Date().toISOString() }
          : a,
      );
      this.updateApplication(app);
      this.audit("action", { appId, actionId: action.id, state: action.state });
      onTransition?.(true);
      return app;
    });
  }
  finishTask(
    id: string,
    token: string,
    result: unknown,
    status: Task["status"] = "completed",
  ) {
    this.requireLease(id, token);
    this.db
      .prepare(
        "UPDATE tasks SET status=?,result=?,lease_token=NULL,lease_until=NULL WHERE id=?",
      )
      .run(status, JSON.stringify(result), id);
  }
  async backup(path: string) {
    await backup(this.db, path);
  }
}
