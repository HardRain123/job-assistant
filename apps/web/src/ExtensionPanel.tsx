import { useEffect, useState } from "react";

type ExtensionStatus = {
  paired: boolean;
  expiresAt: number | null;
  lastSeen: string | null;
  lastImport: string | null;
  importedCount: number;
};

type PairCode = {
  code: string;
  expiresAt: number;
};

type Mutate = <T>(
  path: string,
  method: string,
  body?: unknown,
) => Promise<T | undefined>;

const dateTime = (value: string | number | null) =>
  value === null ? "尚无记录" : new Date(value).toLocaleString();

export function ExtensionPanel({ mutate }: { mutate: Mutate }) {
  const [status, setStatus] = useState<ExtensionStatus | null>(null);
  const [pairCode, setPairCode] = useState<PairCode | null>(null);
  const [copied, setCopied] = useState(false);

  const readStatus = async () => {
    const next = await mutate<ExtensionStatus>("/api/extension/status", "GET");
    if (next) setStatus(next);
  };

  useEffect(() => {
    void readStatus();
  }, []);

  const createCode = async () => {
    const next = await mutate<PairCode>("/api/extension/pair-code", "POST");
    if (next) {
      setPairCode(next);
      setCopied(false);
    }
  };

  const copyCode = async () => {
    if (!pairCode) return;
    try {
      await navigator.clipboard.writeText(pairCode.code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const revoke = async () => {
    const result = await mutate<{ ok: boolean }>(
      "/api/extension/connection",
      "DELETE",
    );
    if (result?.ok) {
      setPairCode(null);
      setStatus({
        paired: false,
        expiresAt: null,
        lastSeen: null,
        lastImport: null,
        importedCount: 0,
      });
      void readStatus();
    }
  };

  return (
    <div className="grid">
      <section className="card">
        <div className="card-title">
          <h2>普通浏览器连接</h2>
          <button className="quiet" onClick={() => void readStatus()}>
            刷新状态
          </button>
        </div>
        <p>
          扩展用于“自动找岗位”：在你已登录的 BOSS 职位列表中读取岗位和完整职位描述，导入本地工作台后按匹配策略评分。手动导入可见岗位仍可使用。它不会读取其他网站，也不会发送消息、投递或上传简历。
        </p>
        <ol className="steps">
          <li>在 Chrome 或 Edge 的“扩展程序”页面开启开发者模式。</li>
          <li>
            选择“加载已解压的扩展程序”，并选取项目中的 apps/browser-extension
            文件夹。
          </li>
          <li>
            更新扩展后，请在扩展程序页面点击“重新加载”。在扩展弹窗输入下面生成的一次性配对码，然后打开 BOSS
            职位列表页；配对后可关闭扩展弹窗。
          </li>
        </ol>
      </section>

      <section className="card">
        <div className="card-title">
          <h2>配对与导入状态</h2>
          {(pairCode || status?.expiresAt != null) && (
            <button className="danger link" onClick={() => void revoke()}>
              撤销配对
            </button>
          )}
        </div>
        <p className="muted">
          配对仅允许该浏览器扩展访问本机工作台的扩展接口。工作台不会将此状态视为扩展当前在线；“已导入”是累计导入次数，可能包含重复岗位。
        </p>
        <p>
          {status?.paired ? "已配对" : "尚未配对"}；最近上报：
          {dateTime(status?.lastSeen ?? null)}；最近导入：
          {dateTime(status?.lastImport ?? null)}；已导入{" "}
          {status?.importedCount ?? 0} 个岗位。
        </p>
        <div className="button-row">
          <button onClick={() => void createCode()}>生成一次性配对码</button>
        </div>
        {pairCode && (
          <div className="form">
            <label>
              配对码（有效至 {dateTime(pairCode.expiresAt)}）
              <input
                readOnly
                value={pairCode.code}
                aria-label="一次性配对码"
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
              />
            </label>
            <div className="button-row">
              <button className="quiet" onClick={() => void copyCode()}>
                {copied ? "已复制" : "复制配对码"}
              </button>
            </div>
            <p className="muted">配对码 5 分钟后失效；请勿发送给他人。</p>
          </div>
        )}
      </section>
    </div>
  );
}
