import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CONVERSATION_PROBE_RESULTS } from "../../../packages/contracts/src/index.ts";
import type {
  Application,
  Assessment,
  BulkRun,
  Job,
  MatchPolicy,
  MessageTemplate,
  Resume,
} from "../../../packages/contracts/src/index.ts";
import {
  Store,
  actionCompleteForExistingContact,
} from "../../../packages/storage/src/index.ts";
import { canonicalJobUrl } from "./automation.ts";
import { evaluateGates } from "../../../packages/matching/src/index.ts";
import type { BulkApplication } from "./bulk-application.ts";
import { renderTemplate } from "../../../packages/templates/src/index.ts";

interface Options {
  store: Store;
  attachmentsDir: string;
  status: () => {
    paired: boolean;
    lastSeen: string | null;
    version: string | null;
  };
  draft: (ids: string[], manualReviewedId?: string) => Application[];
  assessment: (job: Job) => Assessment | null;
  policy: () => MatchPolicy;
  configurationKey: () => string;
  configurationKeyForTemplate: (version: number) => string | null;
  bulk: BulkApplication;
}

type AttachmentManifest = { name: string; size: number; sha256: string };
function safeAttachment(
  attachmentsDir: string,
  name: string,
): { manifest: AttachmentManifest; buffer: Buffer } {
  if (name !== basename(name) || !/^[a-f0-9-]+\.(docx|pdf)$/.test(name))
    throw new Error("简历附件名称无效");
  try {
    const path = join(attachmentsDir, name);
    const file = lstatSync(path);
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.size <= 0 ||
      file.size > 10 * 1024 * 1024
    )
      throw new Error("简历附件无效");
    const buffer = readFileSync(path);
    if (buffer.length !== file.size) throw new Error("简历附件已变化");
    return {
      manifest: {
        name,
        size: buffer.length,
        sha256: createHash("sha256").update(buffer).digest("hex"),
      },
      buffer,
    };
  } catch {
    throw new Error("简历附件不可用或已变化");
  }
}
export function attachmentManifest(
  attachmentsDir: string,
  name: string | null,
): AttachmentManifest | null {
  return name ? safeAttachment(attachmentsDir, name).manifest : null;
}

const selectionSchema = z
  .object({
    jobId: z.string().uuid(),
    expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/),
    acceptReview: z.boolean(),
  })
  .strict();
const startSchema = selectionSchema.extend({
  expectedConfigurationKey: z.string().regex(/^[a-f0-9]{64}$/),
});
const leaseSchema = z
  .object({
    taskId: z.string().uuid(),
    leaseToken: z.string().uuid(),
  })
  .strict();
const identitySchema = leaseSchema.extend({ applicationId: z.string().uuid() });
const evidenceSchema = z.enum([
  "before-action",
  "new-message",
  "new-conversation",
  "new-attachment",
  "existing-contact",
  "recipient-mismatch",
  "page-unrecognized",
  "login-required",
  "verification-required",
  "send-unconfirmed",
  "attachment-pending",
  "cancelled",
  "platform-limit",
  "daily-limit",
]);
const actionSchema = identitySchema.extend({
  actionId: z.string().uuid(),
  state: z.enum([
    "started",
    "confirmed",
    "unknown",
    "failed",
    "awaiting-acceptance",
    "skipped",
  ]),
  evidence: evidenceSchema,
});

export function registerExtensionApplication(app: FastifyInstance, o: Options) {
  const { store } = o;
  const configKey = (id: string) => `extensionApplication.configuration:${id}`;
  const attachmentKey = (id: string) => `extensionApplication.attachment:${id}`;
  const receiptKey = (id: string) => `extensionApplication.receipt:${id}`;
  const versionAtLeast = (version: string | null, minimum: number[]) => {
    const numbers = version?.split(".").map(Number);
    if (
      !numbers ||
      numbers.length !== 3 ||
      numbers.some((n) => !Number.isInteger(n))
    )
      return false;
    for (let i = 0; i < 3; i++) {
      if (numbers[i]! > minimum[i]!) return true;
      if (numbers[i]! < minimum[i]!) return false;
    }
    return true;
  };
  const requireConnection = (minimum = [0, 3, 0]) => {
    const status = o.status();
    if (
      !status.paired ||
      !versionAtLeast(status.version, minimum) ||
      !status.lastSeen ||
      Date.now() - Date.parse(status.lastSeen) > 90000
    )
      throw new Error("请先连接并启用最新版浏览器扩展");
  };
  const requireReady = () => {
    if (
      store.get("paused", false) ||
      store.get("takeover", false) ||
      store.get("browserUncertain", false)
    )
      throw new Error("队列已暂停或浏览器正在人工接管");
    const run = store.get<{ state?: string; phase?: string } | null>(
      "automation.current",
      null,
    );
    if (run?.state === "running" && run.phase === "collecting")
      throw new Error("请等待当前岗位采集结束");
    if (
      store
        .tasks()
        .some(
          (t) => t.kind === "apply" && ["queued", "leased"].includes(t.status),
        )
    )
      throw new Error("已有投递任务等待完成");
  };
  const prepare = (body: z.infer<typeof selectionSchema>) => {
    const job = store.job(body.jobId);
    if (
      !job ||
      job.contentHash !== body.expectedContentHash ||
      job.status !== "active"
    )
      throw new Error("岗位内容已变化，请重新核对");
    const assessment = o.assessment(job);
    const manualReview = assessment?.decision === "review";
    if (manualReview && !body.acceptReview)
      throw new Error("复核岗位需要明确确认");
    const draft = o.draft(
      [body.jobId],
      manualReview && body.acceptReview ? body.jobId : undefined,
    )[0]!;
    return { draft, manualReview };
  };
  const requireExtensionLease = (body: z.infer<typeof identitySchema>) => {
    const task = store.requireLease(body.taskId, body.leaseToken);
    if (
      task.kind !== "apply" ||
      (task.payload as Application).executor !== "extension" ||
      (task.payload as Application).id !== body.applicationId
    )
      throw new Error("投递任务不匹配");
    const application = store.application(body.applicationId);
    if (
      !application ||
      application.executor !== "extension" ||
      application.status !== "running"
    )
      throw new Error("投递记录不在运行中");
    return application;
  };
  const requireConfig = (application: Application) => {
    if (
      store.get<string | null>(configKey(application.id), null) !==
      o.configurationKey()
    )
      throw new Error("简历、话术或策略已变化，请人工核对");
    const frozen = store.get<AttachmentManifest | null>(
      attachmentKey(application.id),
      null,
    );
    const current = attachmentManifest(
      o.attachmentsDir,
      application.resumeAttachment,
    );
    if (JSON.stringify(frozen) !== JSON.stringify(current))
      throw new Error("简历附件已变化，请人工核对");
  };
  const requireFrozenJob = (application: Application) => {
    const current = store.job(application.jobId);
    if (
      !current ||
      current.status !== "active" ||
      current.contentHash !== application.job.contentHash
    )
      throw new Error("岗位内容已变化，请人工核对");
  };
  const companyName = (value: string) =>
    value
      .replace(/\s+/g, " ")
      .trim()
      .replace(/(?:股份有限公司|有限责任公司|有限公司)$/, "");
  const sameEmployer = (oldJob: Job, newJob: Job) => {
    const oldName = companyName(oldJob.company);
    const newName = companyName(newJob.company);
    return (
      Boolean(oldName && newName) &&
      (oldName === newName ||
        oldJob.companyAliases.some((alias) => companyName(alias) === newName) ||
        newJob.companyAliases.some((alias) => companyName(alias) === oldName))
    );
  };
  const sameBusinessFacts = (oldJob: Job, newJob: Job) => {
    if (
      oldJob.id !== newJob.id ||
      oldJob.source !== newJob.source ||
      oldJob.sourceId !== newJob.sourceId ||
      !sameEmployer(oldJob, newJob)
    )
      return false;
    const fields: (keyof Job)[] = [
      "sourceJobId",
      "companyAliases",
      "title",
      "description",
      "location",
      "remote",
      "salaryMin",
      "salaryMax",
      "salaryMonths",
      "experienceMin",
      "education",
      "industry",
      "skills",
    ];
    if (
      fields.some(
        (field) =>
          JSON.stringify(oldJob[field]) !== JSON.stringify(newJob[field]),
      )
    )
      return false;
    try {
      return canonicalJobUrl(oldJob.url) === canonicalJobUrl(newJob.url);
    } catch {
      return false;
    }
  };
  const inspectionShape = z
    .object({
      id: z.string().uuid(),
      state: z.literal("completed"),
      phase: z.literal("done"),
      inspectionJobId: z.string().uuid(),
      updatedAt: z.string(),
      config: z
        .object({
          maxJobs: z.literal(1),
          maxPages: z.literal(1),
          autoAssess: z.literal(false),
        })
        .passthrough(),
      visited: z.literal(1),
      imported: z.literal(1),
      discovered: z.literal(1),
      seenUrls: z.array(z.string()).length(0),
      jobIds: z.array(z.string().uuid()).length(1),
      fieldReadings: z
        .array(
          z
            .object({
              url: z.string(),
              evidence: z
                .object({
                  title: z.string(),
                  company: z.string(),
                  descriptionPresent: z.literal(true),
                  headerLines: z.array(z.string()),
                })
                .passthrough(),
            })
            .passthrough(),
        )
        .length(1),
    })
    .passthrough();
  const isContinueContact = (line: string) =>
    /(?:^|[\s，,。;；:：|/])继续沟通(?:$|[\s，,。;；:：|/])/u.test(line);
  const requireContactInspection = (
    application: Application,
    current: Job,
    inspectionRunId: string,
  ) => {
    const run = inspectionShape.safeParse(
      store.get("automation.current", null),
    );
    const checkedAt = run.success ? Date.parse(run.data.updatedAt) : NaN;
    if (
      !run.success ||
      run.data.id !== inspectionRunId ||
      run.data.inspectionJobId !== application.jobId ||
      run.data.jobIds[0] !== application.jobId ||
      !Number.isFinite(checkedAt) ||
      Date.now() - checkedAt > 90000 ||
      checkedAt > Date.now() + 5000
    )
      throw new Error("指定岗位的只读检查缺失或已过期");
    if (
      store.db
        .prepare(
          "SELECT id FROM audit WHERE event IN ('extensionApplication.existingContactResumed','extensionApplication.messageConfirmedAndResumed') AND json_extract(body,'$.applicationId')=? AND json_extract(body,'$.inspectionRunId')=? LIMIT 1",
        )
        .get(application.id, inspectionRunId)
    )
      throw new Error("请重新只读检查该岗位后再接续");
    const evidence = run.data.fieldReadings[0]!;
    if (
      canonicalJobUrl(evidence.url) !== canonicalJobUrl(current.url) ||
      evidence.evidence.title !== current.title ||
      companyName(evidence.evidence.company) !== companyName(current.company) ||
      !evidence.evidence.headerLines.some(isContinueContact) ||
      evidence.evidence.headerLines.some((line) => line.includes("立即沟通"))
    )
      throw new Error("只读页面未能确认该岗位已有联系");
    return run.data;
  };
  const requireExistingContactAudit = (application: Application) => {
    if (
      !store.db
        .prepare(
          "SELECT id FROM audit WHERE event='extensionApplication.existingContactResumed' AND json_extract(body,'$.applicationId')=? AND json_extract(body,'$.currentHash')=? LIMIT 1",
        )
        .get(application.id, application.job.contentHash)
    )
      throw new Error("已有联系人接续记录缺失，请人工核对");
  };
  const manuallyConfirmedMessage = (action: Application["actions"][number]) =>
    action.kind === "message" &&
    action.state === "unknown" &&
    action.evidence === "send-unconfirmed" &&
    action.resolution === "user-confirmed-sent";
  const requireMessageConfirmationAudit = (
    application: Application,
    action: Application["actions"][number],
  ) => {
    const textHash = createHash("sha256")
      .update(action.text ?? "")
      .digest("hex");
    if (
      !store.db
        .prepare(
          "SELECT id FROM audit WHERE event='extensionApplication.messageConfirmedAndResumed' AND json_extract(body,'$.applicationId')=? AND json_extract(body,'$.actionId')=? AND json_extract(body,'$.textHash')=? LIMIT 1",
        )
        .get(application.id, action.id, textHash)
    )
      throw new Error("话术人工确认记录缺失，请人工核对");
  };
  const requireBeginReady = (application: Application) => {
    if (
      store.get("paused", false) ||
      store.get("takeover", false) ||
      store.get("browserUncertain", false)
    )
      throw new Error("队列已暂停或浏览器状态不确定");
    requireConfig(application);
    requireFrozenJob(application);
    if (!o.bulk.allowedDuringAction(application))
      throw new Error("批量任务已暂停或结束");
  };

  app.post("/api/extension-application/preview", (req) => {
    const body = selectionSchema.parse(req.body);
    const { draft } = prepare(body);
    return { application: draft, configurationKey: o.configurationKey() };
  });
  app.post("/api/extension-application/start", (req) => {
    const body = startSchema.parse(req.body);
    requireConnection();
    const { draft, manualReview } = prepare(body);
    if (body.expectedConfigurationKey !== o.configurationKey())
      throw new Error("简历、话术或策略已变化，请重新预览");
    store.transaction(() => {
      requireReady();
      const latest = store.job(body.jobId);
      if (!latest || latest.contentHash !== body.expectedContentHash)
        throw new Error("岗位内容已变化，请重新核对");
      // Re-evaluate against the current resume, policy and cached assessment inside the lock.
      prepare(body);
      if (body.expectedConfigurationKey !== o.configurationKey())
        throw new Error("简历、话术或策略已变化，请重新预览");
      draft.executor = "extension";
      store.insertApplication(draft);
      store.set(configKey(draft.id), body.expectedConfigurationKey);
      store.set(
        attachmentKey(draft.id),
        attachmentManifest(o.attachmentsDir, draft.resumeAttachment),
      );
      store.enqueue("apply", draft);
      if (manualReview)
        store.audit("extensionApplication.manualReviewAccepted", {
          jobId: draft.jobId,
          contentHash: draft.job.contentHash,
          policyVersion: o.policy().version,
        });
    });
    return { applicationId: draft.id };
  });
  app.post("/api/extension-application/retry", (req) => {
    const body = z
      .object({ applicationId: z.string().uuid() })
      .strict()
      .parse(req.body);
    requireConnection();
    return store.transaction(() => {
      requireReady();
      const application = store.application(body.applicationId);
      if (
        !application ||
        application.executor !== "extension" ||
        application.status !== "needs-review" ||
        ![
          "page-unrecognized",
          "recipient-mismatch",
          "send-unconfirmed",
        ].includes(application.stopReason ?? "") ||
        !application.actions.length ||
        application.actions.some(
          (action) =>
            action.state !== "pending" || action.evidence || action.resolution,
        )
      )
        throw new Error("只有所有动作尚未执行的失败任务可以重试");
      requireConfig(application);
      requireFrozenJob(application);
      if (application.bulkRunId) {
        const run = store.get<(BulkRun & { configurationKey: string }) | null>(
          "bulk.current",
          null,
        );
        const assessment = o.assessment(application.job);
        if (
          !run ||
          run.id !== application.bulkRunId ||
          !["running", "paused"].includes(run.state) ||
          run.configurationKey !== o.configurationKey() ||
          assessment?.decision !== "eligible" ||
          !assessment.gates.length ||
          assessment.gates.some((gate) => gate.status !== "pass")
        )
          throw new Error("原批次或岗位资格已变化，无法重试");
      }
      store.audit("extensionApplication.unsentRetry", {
        applicationId: application.id,
        reason: application.stopReason,
      });
      application.status = "queued";
      delete application.stopReason;
      delete application.pageDiagnostic;
      store.updateApplication(application);
      store.enqueue("apply", application);
      return { applicationId: application.id };
    });
  });
  app.post("/api/extension-application/resume-existing-contact", (req) => {
    const body = z
      .object({
        applicationId: z.string().uuid(),
        inspectionRunId: z.string().uuid(),
      })
      .strict()
      .parse(req.body);
    requireConnection([0, 3, 4]);
    return store.transaction(() => {
      requireReady();
      const application = store.application(body.applicationId);
      if (
        !application ||
        application.executor !== "extension" ||
        application.status !== "needs-review" ||
        application.actions.length < 2
      )
        throw new Error("当前投递不可按已有联系人接续");
      const [native, ...remaining] = application.actions;
      const previouslyResolved = native?.resolution === "contact-exists";
      if (
        native!.kind !== "native-greeting" ||
        native!.index !== 0 ||
        native!.state !== "unknown" ||
        native!.evidence !== "send-unconfirmed" ||
        (native!.resolution && !previouslyResolved) ||
        remaining.some((action) => action.state !== "pending")
      )
        throw new Error("仅原生招呼结果未知且后续未执行时可接续");
      if (
        previouslyResolved &&
        !["recipient-mismatch", "page-unrecognized"].includes(
          application.stopReason ?? "",
        )
      )
        throw new Error("已有联系人任务仅页面识别失败时可再次接续");
      requireConfig(application);
      if (!previouslyResolved) {
        const prior = o.assessment(application.job);
        if (
          !prior ||
          !["eligible", "review"].includes(prior.decision) ||
          (prior.decision === "review" &&
            (prior.score === null || prior.score < o.policy().autoThreshold)) ||
          !prior.gates.length ||
          prior.gates.some((gate) => gate.status !== "pass")
        )
          throw new Error("原岗位匹配条件已失效，请人工核对");
      } else requireExistingContactAudit(application);
      const current = store.job(application.jobId);
      if (
        !current ||
        current.status !== "active" ||
        (previouslyResolved &&
          current.contentHash !== application.job.contentHash) ||
        !sameBusinessFacts(application.job, current)
      )
        throw new Error("岗位业务信息已变化，请重新人工核对");
      const resume = store.get<Resume | null>("resume", null);
      if (
        !resume ||
        evaluateGates(current, resume, o.policy()).some(
          (gate) => gate.status !== "pass",
        )
      )
        throw new Error("当前岗位硬条件未通过，请人工核对");
      const run = requireContactInspection(
        application,
        current,
        body.inspectionRunId,
      );
      const oldHash = application.job.contentHash;
      const previousStopReason = application.stopReason ?? null;
      native!.resolution = "contact-exists";
      application.job = current;
      application.status = "queued";
      delete application.stopReason;
      delete application.pageDiagnostic;
      store.updateApplication(application);
      store.enqueue("apply", application);
      store.audit("extensionApplication.existingContactResumed", {
        applicationId: application.id,
        inspectionRunId: run.id,
        retry: previouslyResolved,
        previousStopReason,
        nativeState: "unknown",
        nativeEvidence: "send-unconfirmed",
        oldHash,
        currentHash: current.contentHash,
      });
      return { applicationId: application.id };
    });
  });
  app.post("/api/extension-application/confirm-message-and-resume", (req) => {
    const body = z
      .object({
        applicationId: z.string().uuid(),
        actionId: z.string().uuid(),
        expectedTextHash: z.string().regex(/^[a-f0-9]{64}$/),
        inspectionRunId: z.string().uuid(),
        updatedTemplate: z
          .object({
            version: z.number().int().positive(),
            expectedConfigurationKey: z.string().regex(/^[a-f0-9]{64}$/),
            expectedMessages: z
              .array(z.string().min(1).max(2000))
              .min(1)
              .max(5),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(req.body);
    requireConnection([0, 3, 4]);
    return store.transaction(() => {
      requireReady();
      const application = store.application(body.applicationId);
      if (
        !application ||
        application.executor !== "extension" ||
        application.status !== "needs-review" ||
        application.stopReason !== "send-unconfirmed"
      )
        throw new Error("当前投递不支持人工确认话术后接续");
      const action = application.actions.find(
        (item) => item.id === body.actionId,
      );
      if (
        !action ||
        action.kind !== "message" ||
        action.state !== "unknown" ||
        action.evidence !== "send-unconfirmed" ||
        action.resolution ||
        !action.text ||
        createHash("sha256").update(action.text).digest("hex") !==
          body.expectedTextHash
      )
        throw new Error("只能确认内容一致且发送结果未知的话术");
      const native = application.actions[0];
      if (
        !native ||
        native.kind !== "native-greeting" ||
        native.index !== 0 ||
        native.state !== "unknown" ||
        native.evidence !== "send-unconfirmed" ||
        native.resolution !== "contact-exists"
      )
        throw new Error("当前扩展仅支持已核对的既有联系人接续");
      const earlier = application.actions.filter(
        (item) => item.index < action.index,
      );
      const later = application.actions.filter(
        (item) => item.index > action.index,
      );
      if (
        !earlier.length ||
        earlier.some((item) => !actionCompleteForExistingContact(item)) ||
        earlier.some(
          (item) => item.id !== native.id && !manuallyConfirmedMessage(item),
        ) ||
        application.actions.length !==
          1 +
            application.frozenMessages.length +
            (application.attachmentPolicy === "send-after-messages" ? 1 : 0) ||
        application.actions.some(
          (item) =>
            item.kind === "message" &&
            item.text !== application.frozenMessages[item.index - 1],
        ) ||
        later.some((item) => item.state !== "pending" || item.resolution)
      )
        throw new Error("前序动作未核对，或后续动作已执行，无法安全接续");
      // Reconciliation only queues untouched work. A paused batch must be
      // resolvable before it can resume; actual claims/actions still require a
      // running batch. Never resurrect a cancelled, completed or replaced run.
      requireFrozenJob(application);
      if (application.bulkRunId) {
        const run = store.get<BulkRun | null>("bulk.current", null);
        if (
          !run ||
          run.id !== application.bulkRunId ||
          !["running", "paused"].includes(run.state)
        )
          throw new Error("原批量任务已结束或被替换，无法接续");
      }
      if (body.updatedTemplate) {
        // Explicitly reviewed template updates are restricted to a one-job,
        // text-only batch. Reconstructing the prior hash proves that the resume,
        // policy and attachment bytes have not changed along with the template.
        const originalKey = store.get<string | null>(
          configKey(application.id),
          null,
        );
        const batch = store.get<
          (BulkRun & { configurationKey: string }) | null
        >("bulk.current", null);
        const template = store.get<MessageTemplate | null>("template", null);
        const resume = store.get<Resume | null>("resume", null);
        const selection = o.assessment(application.job);
        if (
          !application.bulkRunId ||
          !batch ||
          batch.state !== "paused" ||
          batch.id !== application.bulkRunId ||
          batch.configurationKey !== originalKey ||
          store.applications().filter((item) => item.bulkRunId === batch.id)
            .length !== 1 ||
          application.attachmentPolicy !== "message-only" ||
          application.resumeAttachment ||
          application.actions.some((item) => item.kind === "attachment") ||
          !originalKey ||
          o.configurationKeyForTemplate(application.templateVersion) !==
            originalKey ||
          !template ||
          !resume ||
          resume.id !== application.resumeId ||
          template.version !== body.updatedTemplate.version ||
          o.configurationKey() !==
            body.updatedTemplate.expectedConfigurationKey ||
          selection?.decision !== "eligible" ||
          !selection.gates.length ||
          selection.gates.some((gate) => gate.status !== "pass")
        )
          throw new Error(
            "仅限配置未变的单岗位暂停批次更新未发送话术，请重新核对",
          );
        const messages = renderTemplate(
          { ...template, attachmentPolicy: "message-only" },
          {
            company: application.job.company,
            title: application.job.title,
            candidateName: resume.name,
            years: String(resume.years),
            skills: resume.skills.join("、"),
          },
        );
        if (
          messages.length !== application.frozenMessages.length ||
          JSON.stringify(messages) !==
            JSON.stringify(body.updatedTemplate.expectedMessages) ||
          application.actions
            .filter((item) => item.kind === "message")
            .some(
              (item) =>
                item.index <= action.index &&
                messages[item.index - 1] !== item.text,
            )
        )
          throw new Error("话术预览已变化，或已尝试的段落被修改，无法接续");
        store.audit("extensionApplication.pendingTemplateUpdated", {
          applicationId: application.id,
          bulkRunId: batch.id,
          previousVersion: application.templateVersion,
          version: template.version,
          previousConfigurationKey: originalKey,
          configurationKey: body.updatedTemplate.expectedConfigurationKey,
          changes: later.map((item) => ({
            actionId: item.id,
            before: item.text,
            after: messages[item.index - 1],
          })),
        });
        for (const item of later) item.text = messages[item.index - 1]!;
        application.frozenMessages = messages;
        application.templateVersion = template.version;
        store.set(
          configKey(application.id),
          body.updatedTemplate.expectedConfigurationKey,
        );
        batch.configurationKey = body.updatedTemplate.expectedConfigurationKey;
        store.set("bulk.current", batch);
      }
      requireConfig(application);
      requireExistingContactAudit(application);
      for (const item of earlier.filter(manuallyConfirmedMessage))
        requireMessageConfirmationAudit(application, item);
      const current = store.job(application.jobId)!;
      const resume = store.get<Resume | null>("resume", null);
      if (
        !resume ||
        evaluateGates(current, resume, o.policy()).some(
          (gate) => gate.status !== "pass",
        )
      )
        throw new Error("当前岗位硬条件未通过，请人工核对");
      const run = requireContactInspection(
        application,
        current,
        body.inspectionRunId,
      );
      const previousDiagnostic = application.pageDiagnostic ?? null;
      const previousStopReason = application.stopReason;
      // A user's observation resolves whether to proceed, without rewriting the
      // missing browser receipt as an automatically confirmed send.
      action.resolution = "user-confirmed-sent";
      action.updatedAt = new Date().toISOString();
      application.status = later.length ? "queued" : "completed";
      delete application.stopReason;
      delete application.pageDiagnostic;
      store.audit("extensionApplication.messageConfirmedAndResumed", {
        applicationId: application.id,
        actionId: action.id,
        inspectionRunId: run.id,
        textHash: body.expectedTextHash,
        previousState: action.state,
        previousEvidence: action.evidence,
        previousStopReason,
        previousDiagnostic,
        resolution: action.resolution,
        currentHash: current.contentHash,
        completed: application.status === "completed",
      });
      store.updateApplication(application);
      if (later.length) store.enqueue("apply", application);
      else o.bulk.afterResult(application);
      return { applicationId: application.id, status: application.status };
    });
  });
  app.post("/extension/v1/application/claim", () => {
    requireConnection();
    const candidate = store
      .tasks()
      .reverse()
      .find(
        (t) =>
          t.status === "queued" &&
          t.kind === "apply" &&
          (t.payload as Application).executor === "extension",
      );
    if (candidate) {
      const application = store.application(
        (candidate.payload as Application).id,
      );
      if (application?.bulkRunId) {
        requireConnection([0, 4, 2]);
        if (!o.bulk.canClaim(application)) return { task: null };
      }
      let current = false;
      try {
        if (application) {
          requireConfig(application);
          requireFrozenJob(application);
          for (const action of application.actions.filter(
            manuallyConfirmedMessage,
          ))
            requireMessageConfirmationAudit(application, action);
          current = true;
        }
      } catch {
        /* A changed job or configuration cannot be claimed. */
      }
      if (!current) {
        store.transaction(() => {
          store.db
            .prepare(
              "UPDATE tasks SET status='needs-review' WHERE id=? AND status='queued'",
            )
            .run(candidate.id);
          if (application) {
            application.status = "needs-review";
            store.updateApplication(application);
            o.bulk.afterResult(application, "page-unrecognized");
          }
        });
        return { task: null };
      }
    }
    const task = store.claim("extension");
    if (!task) return { task: null };
    const application = store.application((task.payload as Application).id)!;
    // The installed extension only accepts pending work and its existing-contact
    // navigation action. Keep reconciled messages in storage and the task payload.
    return {
      task: {
        id: task.id,
        leaseToken: task.leaseToken,
        application: {
          ...application,
          actions: application.actions.filter(
            (action) => !manuallyConfirmedMessage(action),
          ),
        },
      },
    };
  });
  app.post("/extension/v1/application/heartbeat", (req) => {
    const body = leaseSchema.parse(req.body);
    const task = store.requireLease(body.taskId, body.leaseToken);
    if (
      task.kind !== "apply" ||
      (task.payload as Application).executor !== "extension"
    )
      throw new Error("投递任务不匹配");
    store.heartbeat(body.taskId, body.leaseToken);
    const application = store.application((task.payload as Application).id);
    return {
      paused:
        store.get("paused", false) ||
        store.get("browserUncertain", false) ||
        Boolean(application && !o.bulk.allowedDuringAction(application)),
      takeover: store.get("takeover", false),
    };
  });
  app.post("/extension/v1/application/authorize", (req) => {
    const body = identitySchema
      .extend({ actionId: z.string().uuid() })
      .parse(req.body);
    const application = requireExtensionLease(body);
    requireBeginReady(application);
    const action = application.actions.find(
      (item) => item.id === body.actionId,
    );
    if (
      !action ||
      (action.state !== "started" &&
        !(
          action.kind === "native-greeting" &&
          ((action.state === "skipped" &&
            action.evidence === "existing-contact") ||
            (action.state === "unknown" &&
              action.evidence === "send-unconfirmed" &&
              action.resolution === "contact-exists"))
        ))
    )
      throw new Error("动作尚未获准");
    return { allowed: true, expiresAt: Date.now() + 1500 };
  });
  app.post("/extension/v1/application/action", (req) => {
    const body = actionSchema.parse(req.body);
    const application = requireExtensionLease(body);
    const old = application.actions.find((a) => a.id === body.actionId);
    if (!old) throw new Error("动作不属于当前投递");
    if (body.state === "started") {
      requireBeginReady(application);
      if (body.evidence !== "before-action")
        throw new Error("动作开始前证据不匹配");
    }
    if (
      body.state === "skipped" &&
      (old.kind !== "native-greeting" || body.evidence !== "existing-contact")
    )
      throw new Error("只有既有联系人招呼动作可以跳过");
    if (
      body.state === "confirmed" &&
      !(old.kind === "native-greeting"
        ? ["new-message", "new-conversation"].includes(body.evidence)
        : body.evidence ===
          (old.kind === "attachment" ? "new-attachment" : "new-message"))
    )
      throw new Error("发送确认需要新消息或新附件证据");
    let execute = false;
    let updated: Application;
    try {
      updated = store.recordAction(
        body.taskId,
        body.leaseToken,
        body.applicationId,
        {
          ...old,
          state: body.state,
          evidence: body.evidence,
          updatedAt: new Date().toISOString(),
        },
        (changed) => {
          execute = changed && body.state === "started";
        },
      );
    } catch (error) {
      if (error instanceof Error && error.message === "daily-limit")
        o.bulk.pause("今日配置名额已用完，批量已暂停。");
      throw error;
    }
    return { execute, application: updated };
  });
  app.post("/extension/v1/application/attachment", (req) => {
    const body = identitySchema
      .extend({ actionId: z.string().uuid() })
      .parse(req.body);
    const application = requireExtensionLease(body);
    requireConfig(application);
    const action = application.actions.find((a) => a.id === body.actionId);
    if (
      !action ||
      action.kind !== "attachment" ||
      action.state !== "started" ||
      application.actions.some(
        (a) => a.index < action.index && !actionCompleteForExistingContact(a),
      )
    )
      throw new Error("附件动作尚未获准");
    const name = application.resumeAttachment;
    if (!name) throw new Error("简历附件不存在");
    const { manifest, buffer } = safeAttachment(o.attachmentsDir, name);
    if (
      JSON.stringify(manifest) !==
      JSON.stringify(
        store.get<AttachmentManifest | null>(
          attachmentKey(application.id),
          null,
        ),
      )
    )
      throw new Error("简历附件已变化，请人工核对");
    return {
      name,
      mimeType:
        extname(name) === ".pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      base64: buffer.toString("base64"),
      sha256: manifest.sha256,
    };
  });
  app.post("/extension/v1/application/result", (req) => {
    const body = identitySchema
      .extend({
        diagnostic: z
          .discriminatedUnion("stage", [
            z
              .object({
                stage: z.literal("message-receipt"),
                beforeCount: z.number().int().min(0).max(1000),
                afterCount: z.number().int().min(0).max(1000),
                messageRowCount: z.number().int().min(0).max(1000),
                matchingCount: z.number().int().min(0).max(1000),
                newMatchingCount: z.number().int().min(0).max(1000),
                acknowledgedCount: z.number().int().min(0).max(1000),
                failedCount: z.number().int().min(0).max(1000),
                editorEmpty: z.boolean(),
              })
              .strict(),
            z
              .object({
                stage: z.literal("detail-entry"),
                controlCount: z.number().int().min(0).max(20),
                knownControlCount: z.number().int().min(0).max(20),
                titleCount: z.number().int().min(0).max(20),
                tags: z
                  .array(z.enum(["a", "button", "div", "span", "other"]))
                  .max(5),
              })
              .strict(),
            z
              .object({
                stage: z.literal("conversation"),
                editorCount: z.number().int().min(0).max(20),
                activeJobCardCount: z.number().int().min(0).max(20),
                exactJobLinkCount: z.number().int().min(0).max(20),
                employerFieldMatchCount: z.number().int().min(0).max(20),
                probes: z
                  .array(
                    z
                      .object({
                        depth: z.number().int().min(0).max(11),
                        result: z.enum(CONVERSATION_PROBE_RESULTS),
                        viewControlCount: z.number().int().min(0).max(20),
                        viewTextCount: z.number().int().min(0).max(20),
                        titleMatchCount: z.number().int().min(0).max(20),
                        cityMatchCount: z.number().int().min(0).max(20),
                        salaryMatchCount: z.number().int().min(0).max(20),
                        employerMatchCount: z.number().int().min(0).max(20),
                        recruiterCount: z.number().int().min(0).max(20),
                      })
                      .strict(),
                  )
                  .max(12)
                  .optional(),
              })
              .strict(),
          ])
          .optional(),
        reason: z
          .enum([
            "recipient-mismatch",
            "page-unrecognized",
            "login-required",
            "verification-required",
            "send-unconfirmed",
            "attachment-pending",
            "cancelled",
            "existing-contact",
            "platform-limit",
            "daily-limit",
          ])
          .optional(),
      })
      .parse(req.body);
    const identity = createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex");
    const receipt = store.get<{ identity: string; status: string } | null>(
      receiptKey(body.taskId),
      null,
    );
    if (receipt) {
      if (receipt.identity !== identity) throw new Error("重复回调身份不一致");
      return { ok: true, status: receipt.status };
    }
    const application = requireExtensionLease(body);
    let status: Application["status"] = "needs-review";
    store.transaction(() => {
      application.actions = application.actions.map((a) =>
        a.state === "started"
          ? {
              ...a,
              state: "unknown" as const,
              updatedAt: new Date().toISOString(),
            }
          : a,
      );
      status = application.actions.every(actionCompleteForExistingContact)
        ? "completed"
        : "needs-review";
      if (body.reason === "existing-contact") {
        if (
          !application.bulkRunId ||
          !application.actions.some(
            (a) =>
              a.kind === "native-greeting" &&
              a.state === "skipped" &&
              a.evidence === "existing-contact",
          ) ||
          application.actions.some(
            (a) => a.kind !== "native-greeting" && a.state !== "pending",
          )
        )
          throw new Error("既有联系人跳过证据不匹配");
        status = "cancelled";
      }
      application.status = status;
      if (body.reason && status !== "completed")
        application.stopReason = body.reason;
      else delete application.stopReason;
      if (body.diagnostic && status !== "completed")
        application.pageDiagnostic = body.diagnostic;
      else delete application.pageDiagnostic;
      store.updateApplication(application);
      store.finishTask(
        body.taskId,
        body.leaseToken,
        { status },
        status === "completed" || status === "cancelled"
          ? "completed"
          : "needs-review",
      );
      store.set(receiptKey(body.taskId), { identity, status });
      o.bulk.afterResult(application, body.reason);
    });
    return { ok: true, status };
  });
}
