export function localApiBase(port = 3000) {
  const value = String(port);
  if (!/^\d{4,5}$/.test(value) || Number(value) < 1024 || Number(value) > 65535)
    throw new Error("工作台端口应为 1024–65535 的整数。");
  return `http://127.0.0.1:${Number(value)}`;
}

export function connectionApiBase(connection, expectedToken) {
  if (!expectedToken || connection.jobAssistantToken !== expectedToken)
    throw new Error("本地连接已变化，请重新检查任务。");
  return localApiBase(connection.jobAssistantPort ?? 3000);
}
