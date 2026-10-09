import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Synthetic DOM contract fixtures: these verify filtering and payload behavior,
// not the current BOSS selectors or Chrome's extension transport.
const script =
  readFileSync(
    new URL("../apps/browser-extension/extract.mjs", import.meta.url),
    "utf8",
  ).replace("export function", "function") + "\nextractJobs()";
function node(
  text = "",
  hidden = false,
  selectors: Record<string, any> = {},
): any {
  return {
    innerText: text,
    textContent: "HIDDEN_PRIVATE_CONTENT",
    getClientRects: () => (hidden ? [] : [{}]),
    querySelector: (selector: string) => selectors[selector] ?? null,
    querySelectorAll: (selector: string) => {
      const value = selectors[selector];
      return Array.isArray(value) ? value : value ? [value] : [];
    },
  };
}
function run(
  document: any,
  path = "/job_detail/example.html",
  origin = "https://www.zhipin.com",
) {
  if (!document.querySelectorAll) {
    document.querySelectorAll = (selector: string) => {
      const value = document.querySelector(selector);
      return value ? [value] : [];
    };
  }
  return runInNewContext(
    script,
    {
      document,
      location: { origin, pathname: path, href: origin + path },
      URL,
      getComputedStyle: (element: any) => ({ display: "block", visibility: "visible", ...element.style }),
    },
    { timeout: 1000 },
  );
}
test("扩展详情读取只使用可见岗位正文，隐藏描述或非 BOSS 页面不导入", () => {
  const description = node("公开岗位职责：Java 与 AI 开发");
  const document = {
    querySelector: (selector: string) =>
      selector.startsWith(".job-sec-text")
        ? description
        : ((
            {
              ".job-banner .name h1": node("Java 工程师"),
              ".company-info .name": node("测试公司"),
              ".job-banner .salary": node("20-30K"),
            } as Record<string, any>
          )[selector] ?? null),
  };
  const result = run(document);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].description, "公开岗位职责：Java 与 AI 开发");
  assert.equal(result.jobs[0].detail, true);
  assert.ok(!JSON.stringify(result).includes("HIDDEN_PRIVATE_CONTENT"));
  description.getClientRects = () => [];
  assert.equal(run(document).jobs.length, 0);
  assert.equal(run(document, "/", "https://evil.example").jobs.length, 0);
});

test("详情跳过同一选择器中隐藏的首节点，并检查父节点可见性", () => {
  const concealed = node("隐藏的行业");
  concealed.parentElement = { style: { display: "none" } };
  const document = node("", false, {
    ".job-banner .name h1": [node("旧职位", true), node("AI 应用开发")],
    ".company-info .name": [node("旧公司", true), node("公司名称 德比软件（上海）有限公司")],
    ".job-sec-text": [node("旧职责", true), node("Java 与 Agent 平台开发")],
    ".company-info .industry": [concealed, node("计算机软件")],
    ".job-banner .job-location": [node("北京", true), node("上海")],
  });
  const job = run(document).jobs[0];
  assert.equal(job.title, "AI 应用开发");
  assert.equal(job.company, "德比软件（上海）有限公司");
  assert.equal(job.description, "Java 与 Agent 平台开发");
  assert.equal(job.industry, "计算机软件");
  assert.equal(job.location, "上海");
});

test("薪资乱码不进入数字解析，依次寻找可读候选并保留面议", () => {
  const fields: Record<string, any> = {
    ".job-banner .name h1": node("AI 开发"),
    ".company-info .name": node("测试公司"),
    ".job-sec-text": node("Java 与 AI 开发"),
  };
  const document = node("", false, fields);
  for (const glyph of ["\uE123", "\uFFFD", "\u{F0001}", "\u{100001}"]) {
    fields[".job-banner .salary"] = [node(`2${glyph}-35K`), node("25-35K", true)];
    assert.equal(run(document).jobs[0].salaryText, "");
    fields[".job-banner .salary"].push(node("25-35K"));
    assert.equal(run(document).jobs[0].salaryText, "25-35K");
  }
  fields[".job-banner .salary"] = node("2\uE123-35K");
  fields[".job-banner .job-salary"] = node("面议");
  assert.equal(run(document).jobs[0].salaryText, "面议");
});

function screenshotLayout(company = "上海示例智造科技有限公司") {
  const heading = node("公司基本信息");
  heading.parentElement = node("公司基本信息\n上海示例智造科技\nB轮\n100-499人\n互联网\n查看全部职位");
  const metadata = node("上海\n3-5年\n本科");
  const banner = node("招聘中\n智能体开发工程师\n20-30K\n上海\n3-5年\n本科", false, { "p, span, li": [metadata] });
  const fields: Record<string, any> = {
    ".job-banner": banner,
    ".job-banner .name h1": node("智能体开发工程师"),
    ".company-info .name": node(company),
    ".job-sec-text": node("3年以上AI项目经验，至少1年LLM应用、Agent或RAG系统开发经验"),
    "h2, h3, h4, h5, dt": [heading],
  };
  return { fields, heading, banner, metadata, document: node("", false, fields) };
}

test("截图布局的语义回退从职位头部和同公司信息区读取字段", () => {
  const layout = screenshotLayout();
  const job = run(layout.document).jobs[0];
  assert.equal(job.salaryText, "20-30K");
  assert.equal(job.location, "上海");
  assert.equal(job.industry, "互联网");
  assert.equal(job.experienceText, "3-5年");
  assert.equal(job.education, "本科");
  assert.ok(job.description.includes("3年以上AI项目经验"));
});

test("字段诊断区分乱码、缺失、行业名称不符，只输出固定状态", () => {
  const layout = screenshotLayout();
  assert.deepEqual(JSON.parse(JSON.stringify(run(layout.document).fieldReading)), { salary: "readable", location: "readable", industry: "readable" });
  layout.banner.innerText = "智能体开发工程师\n2\uE123-30K";
  assert.equal(run(layout.document).fieldReading.salary, "encoded");
  layout.banner.innerText = "智能体开发工程师";
  assert.equal(run(layout.document).fieldReading.salary, "missing");
  layout.fields[".company-info .name"] = node("另一公司");
  assert.equal(run(layout.document).fieldReading.industry, "company-mismatch");
  delete layout.fields["h2, h3, h4, h5, dt"];
  assert.equal(run(layout.document).fieldReading.industry, "section-missing");
  assert.ok(!JSON.stringify(run(layout.document).fieldReading).includes("另一公司"));
});

test("职位头部类名变化时使用同一标题的小范围祖先，不上探整页", () => {
  const layout = screenshotLayout();
  delete layout.fields[".job-banner"];
  const heading = node("智能体开发工程师");
  heading.parentElement = layout.banner;
  layout.banner.parentElement = node("智能体开发工程师\n职位描述\n推荐职位\n80-100K");
  layout.fields.h1 = heading;
  assert.equal(run(layout.document).jobs[0].salaryText, "20-30K");
  assert.equal(run(layout.document).jobs[0].location, "上海");
  heading.innerText = "其他岗位";
  assert.equal(run(layout.document).jobs[0].salaryText, "");
});

test("语义行业回退拒绝其他公司、隐藏信息、匿名客户和冲突值", () => {
  const mismatch = screenshotLayout("另一科技有限公司");
  assert.equal(run(mismatch.document).jobs[0].industry, "");
  const anonymous = screenshotLayout("上海某公司");
  anonymous.fields[".company-info .industry"] = node("互联网");
  assert.equal(run(anonymous.document).jobs[0].industry, "");
  const hidden = screenshotLayout();
  hidden.heading.parentElement.style = { display: "none" };
  assert.equal(run(hidden.document).jobs[0].industry, "");
  const conflict = screenshotLayout();
  conflict.fields[".company-info .industry"] = node("保险");
  assert.equal(run(conflict.document).jobs[0].industry, "");
  const client = screenshotLayout();
  client.banner.querySelectorAll = () => [node("客户公司：上海示例智造科技有限公司")];
  assert.equal(run(client.document).jobs[0].industry, "");
});

test("语义回退不从整页、推荐职位、公司名称或职责猜测薪资和地点", () => {
  const layout = screenshotLayout();
  layout.banner.innerText = "招聘中\n智能体开发工程师\n2\uE123-30K";
  layout.metadata.innerText = "熟悉上海业务，3-5年经验，本科";
  layout.fields[".salary"] = node("99-100K");
  layout.fields[".job-area"] = node("北京");
  const result = run(layout.document);
  assert.equal(result.jobs[0].salaryText, "");
  assert.equal(result.jobs[0].location, "");
  assert.ok(result.warnings.some((value: string) => value.includes("薪资")));
  layout.banner.innerText = "智能体开发工程师\n推荐职位\n99-100K";
  layout.metadata.innerText = "北京 3-5年 本科";
  assert.equal(run(layout.document).jobs[0].salaryText, "");
  assert.equal(run(layout.document).jobs[0].location, "");
});

test("头部语义回退遇到多组不同薪资或地点时保留未知", () => {
  const layout = screenshotLayout();
  layout.banner.innerText += "\n30-40K";
  layout.banner.querySelectorAll = () => [layout.metadata, node("北京 3-5年 本科")];
  const job = run(layout.document).jobs[0];
  assert.equal(job.salaryText, "");
  assert.equal(job.location, "");
});

test("公司行业必须有明确人数和职位链接边界，不能把融资或混合内容当行业", () => {
  for (const body of [
    "公司基本信息\n上海示例智造科技\n互联网\n查看全部职位",
    "公司基本信息\n上海示例智造科技\n100-499人\nB轮\n查看全部职位",
    "公司基本信息\n上海示例智造科技\n100-499人\n互联网\n推荐职位",
    "公司基本信息\n上海示例智造科技\n100-499人\n互联网\n公司介绍",
  ]) {
    const layout = screenshotLayout();
    layout.heading.parentElement.innerText = body;
    assert.equal(run(layout.document).jobs[0].industry, "");
  }
});

test("公司区标题可以是普通元素，逐层寻找完整信息且不进入页面正文", () => {
  const layout = screenshotLayout();
  delete layout.fields["h2, h3, h4, h5, dt"];
  layout.fields["div, p, span"] = [layout.heading];
  const section = layout.heading.parentElement;
  layout.heading.parentElement = node("公司基本信息\n上海示例智造科技");
  layout.heading.parentElement.parentElement = section;
  section.parentElement = node("公司基本信息\n职位描述\n上海示例智造科技\n100-499人\n保险\n查看全部职位");
  assert.equal(run(layout.document).jobs[0].industry, "互联网");
});

test("公司展示名只有在唯一信息区内有可见 BOSS 公司链接时才成为别名", () => {
  const layout = screenshotLayout("示例信息科技（苏州）有限公司");
  const link = node("示例软件");
  link.href = "https://www.zhipin.com/gongsi/fixture.html";
  layout.heading.parentElement = node("公司基本信息\n示例软件\nD轮\n1000-9999人\n计算机软件\n查看全部职位", false, { "a[href*='/gongsi/']": [link] });
  const accepted = run(layout.document).jobs[0];
  assert.equal(accepted.industry, "计算机软件");
  assert.deepEqual(Array.from(accepted.companyAliases), ["示例软件"]);
  link.href = "https://evil.example/gongsi/fixture.html";
  assert.equal(run(layout.document).jobs[0].industry, "");
  assert.equal(run(layout.document).jobs[0].companyAliases, undefined);
  link.href = "https://www.zhipin.com/gongsi/fixture.html";
  link.getClientRects = () => [];
  assert.equal(run(layout.document).jobs[0].industry, "");
  link.getClientRects = () => [{}];
  layout.fields[".company-info .name"] = node("上海某公司");
  assert.equal(run(layout.document).jobs[0].industry, "");
  assert.equal(run(layout.document).jobs[0].companyAliases, undefined);
});

test("公司名称仅去除明确标签前缀，保留普通名称主体", () => {
  const fields: Record<string, any> = {
    ".job-banner .name h1": node("AI 开发"),
    ".job-sec-text": node("Java 与 AI 开发"),
  };
  const document = node("", false, fields);
  for (const [input, expected] of [
    ["公司名称：华勤技术股份有限公司", "华勤技术股份有限公司"],
    ["公司名称 : 测试公司", "测试公司"],
    ["公司名称科技有限公司", "公司名称科技有限公司"],
    ["测试公司名称服务有限公司", "测试公司名称服务有限公司"],
  ]) {
    fields[".company-info .name"] = node(input);
    assert.equal(run(document).jobs[0].company, expected);
  }
});

test("字段证据限定公开头部和公司区域，移除外链、查询参数与隐藏内容", () => {
  const layout = screenshotLayout();
  const publicLink = node("示例智造"); publicLink.href = "https://www.zhipin.com/gongsi/example.html?tracking=PRIVATE_QUERY#fragment";
  const externalLink = node("外部链接"); externalLink.href = "https://evil.example/gongsi/example.html";
  const hiddenLink = node("隐藏公司", true); hiddenLink.href = "https://www.zhipin.com/gongsi/hidden.html";
  const section = node("公司基本信息\n示例智造\n100-499人\n互联网\n查看全部职位", false, { "a[href]": [publicLink, externalLink, hiddenLink] });
  layout.heading.parentElement = section;
  const result = run(layout.document);
  assert.equal(result.pageUrl, "https://www.zhipin.com/job_detail/example.html");
  assert.equal(result.pageEvidence.descriptionPresent, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.pageEvidence.companySections[0].links)), [{ text: "示例智造", path: "/gongsi/example.html" }]);
  const evidence = JSON.stringify(result.pageEvidence);
  for (const value of ["PRIVATE_QUERY", "HIDDEN_PRIVATE_CONTENT", "隐藏公司", "evil.example", "fragment"]) assert.ok(!evidence.includes(value));
  section.innerText = "公司基本信息\n" + Array.from({ length: 25 }, (_, i) => `行${i}`).join("\n");
  assert.equal(run(layout.document).pageEvidence.companySections[0].lines.length, 16);
});

test("猎头隐藏头部不会遮蔽可见客户公司或泄漏中介行业", () => {
  const client = node("客户公司：上海某大型公司");
  const banner = node("公开职位头部", false, { "p, span, a, div": [client] });
  const document = node("", false, {
    ".job-banner": [node("旧头部", true), banner],
    ".job-banner .name h1": node("AI 开发"),
    ".job-sec-text": node("Java 与 AI 开发"),
    ".company-info .name": node("中介公司"),
    ".company-info .industry": node("人力资源服务"),
  });
  assert.equal(run(document).jobs[0].company, "上海某大型公司");
  assert.equal(run(document).jobs[0].industry, "");
  client.innerText = "客户公司：";
  assert.equal(run(document).jobs.length, 0);
});
test("扩展列表去重、限制数量，忽略隐藏卡片与外部链接且生成非空摘要", () => {
  const links = Array.from({ length: 40 }, (_, index) => {
    const card = node("", index === 0, {
      ".company-name": node("测试公司"),
      ".salary": node("25-35K"),
    });
    const link = node("岗位", false, {
      ".job-name, .job-title, h3": node(`岗位 ${index}`),
    });
    link.href = `https://www.zhipin.com/job_detail/${index}.html`;
    link.closest = () => card;
    return link;
  });
  links[1].href = "https://evil.example/job_detail/1.html";
  const document = {
    querySelectorAll: () => [
      links[0],
      links[1],
      links[2],
      links[2],
      ...links.slice(3),
    ],
  };
  const result = run(document, "/web/geek/job");
  assert.equal(result.jobs.length, 30);
  assert.equal(new Set(result.jobs.map((job: any) => job.url)).size, 30);
  assert.ok(
    result.jobs.every((job: any) => job.description && job.detail === false),
  );
  assert.ok(
    !result.jobs.some(
      (job: any) =>
        job.url.endsWith("/0.html") || job.url.includes("evil.example"),
    ),
  );
});

test("猎头详情优先读取可见客户公司，保留匿名名称且不套用中介行业", () => {
  const client = node("客户公司：上海某大型电子商务公司");
  const banner = node("公开职位头部");
  banner.querySelectorAll = () => [client, node("客户公司：隐藏公司", true)];
  const fields: Record<string, any> = {
    ".job-banner": banner,
    ".job-banner .name h1": node("AI Agent开发工程师"),
    ".company-info .name": node("招聘中介公司"),
    ".company-info .industry": node("人力资源服务"),
    ".job-banner .salary": node("40-65K"),
  };
  const document = { querySelector: (selector: string) => selector.startsWith(".job-sec-text") ? node("AI Agent架构、RAG与工具开发") : fields[selector] ?? null };
  const result = run(document);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].company, "上海某大型电子商务公司");
  assert.equal(result.jobs[0].industry, "");
  assert.equal(result.jobs[0].salaryText, "40-65K");
  banner.querySelectorAll = () => [node("客户公司：")];
  assert.equal(run(document).jobs.length, 0);
  banner.querySelectorAll = () => [client, node("客户公司：另一客户公司")];
  assert.equal(run(document).jobs.length, 0);
  assert.equal(run(document).diagnosticCode, "card-incomplete");
  delete fields[".company-info .name"];
  client.getClientRects = () => [];
  banner.querySelectorAll = () => [client];
  assert.equal(run(document).jobs.length, 0);
});

