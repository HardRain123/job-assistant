import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error The injected module is deliberately plain JavaScript.
import { inspectSplitSearch, clickAndReadSplitDetail } from "./split-page.mjs";

type Fake = {
  innerText: string; href?: string; tagName?: string; isConnected: boolean; nodeType: number;
  parentElement: Fake | null; display: string; rects: number; selected: boolean;
  children: Record<string, Fake | null>; clicked: number; onClick?: () => void;
  getClientRects(): unknown[]; querySelector(selector: string): Fake | null;
  querySelectorAll(selector: string): Fake[];
  contains(other: Fake): boolean;
  getAttribute(name: string): string | null; classList: { contains(name: string): boolean };
  click(): void;
};
const url = (id: string) => "https://www.zhipin.com/job_detail/" + id + ".html";
function node(text = "", parent: Fake | null = null): Fake {
  const n: Fake = {
    innerText: text, isConnected: true, nodeType: 1, parentElement: parent,
    display: "block", rects: 1, selected: false, children: {}, clicked: 0,
    getClientRects() { return this.rects ? [1] : []; },
    querySelector(selector) {
      for (const [key, value] of Object.entries(this.children)) {
        if (selector.includes(key)) return value;
      }
      return null;
    },
    querySelectorAll(selector) { return Object.entries(this.children).filter(([key]) => selector === "*" || selector.includes(key)).map(([, child]) => child).filter((child): child is Fake => !!child); },
    contains(other) { for (let current: Fake | null = other; current; current = current.parentElement) if (current === this) return true; return false; },
    getAttribute(name) { return name === "aria-selected" && this.selected ? "true" : null; },
    classList: { contains(name) { return (name === "active" || name === "selected") && n.selected; } },
    click() { this.clicked++; this.onClick?.(); },
  };
  return n;
}
function card(id: string, title: string, company: string, onClick?: () => void) {
  const box = node();
  const name = node(title, box);
  const link = node(title, name); link.href = url(id); link.rects = 0; link.display = "contents";
  box.children = { "a.job-name": link, ".job-name": name, ".boss-name": node(company, box),
    ".company-location": node("北京", box), ".job-salary": node("20-30K", box) };
  box.onClick = onClick;
  return { box, link, name };
}
function panel(title: string, description: string, company = "", id = "") {
  const box = node();
  box.children = { ".job-name": node(title, box), ".desc": node(description, box),
    ".boss-name": company ? node(company, box) : null,
    "a[href": id ? Object.assign(node("", box), { href: url(id) }) : null,
    ".job-salary": node("\uE1230-30K", box) };
  return box;
}
function install(cards: Fake[], detail: Fake | null) {
  const container = node();
  for (const c of cards) c.parentElement = container;
  Object.assign(globalThis, {
    location: { href: "https://www.zhipin.com/web/geek/jobs", pathname: "/web/geek/jobs" },
    getComputedStyle: (n: Fake) => ({ display: n.display, visibility: "visible" }),
    document: {
      readyState: "complete",
      querySelectorAll: (selector: string) => selector.includes(".job-card-box") ? cards : [],
      querySelector: (selector: string) => selector === ".job-detail-box" ? detail : null,
    },
  });
}
async function fast<T>(action: () => Promise<T>): Promise<T> {
  const originalTimeout = globalThis.setTimeout;
  const originalNow = Date.now;
  let clock = 0;
  Date.now = () => { clock += 200; return clock; };
  globalThis.setTimeout = ((fn: () => void) => { queueMicrotask(fn); return 1 as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout;
  try { return await action(); } finally { Date.now = originalNow; globalThis.setTimeout = originalTimeout; }
}
async function fails(expectedUrl: string, failureCode?: string) {
  const result = await fast(() => clickAndReadSplitDetail(expectedUrl)) as { ok: boolean; failureCode?: string };
  assert.equal(result.ok, false);
  if (failureCode) assert.equal(result.failureCode, failureCode);
}
async function metadata() {
  const result = await fast(() => clickAndReadSplitDetail(url("a"))) as {
    ok: boolean; job: { salaryText?: string; industry?: string };
  };
  assert.equal(result.ok, true);
  return result.job;
}

test("visible cards, display:contents links, nested wrappers and hidden links", () => {
  const first = card("a", "工程师", "甲公司");
  const wrapper = node(); wrapper.children = first.box.children;
  const hidden = card("b", "设计师", "乙公司"); hidden.link.display = "none";
  install([wrapper, first.box, hidden.box], null);
  const result = inspectSplitSearch();
  assert.deepEqual(result.links, [url("a")]);
  assert.equal(result.pageUrl, "https://www.zhipin.com/web/geek/jobs");
  assert.equal(result.hasNext, false);
});

test("display:contents job-name anchor is accepted through its visible child", () => {
  const target = card("a", "工程师", "甲公司");
  const visibleText = node("工程师", target.link);
  target.link.children = { span: visibleText };
  target.box.children[".job-name"] = target.link;
  install([target.box], null);
  assert.deepEqual(inspectSplitSearch().links, [url("a")]);
});

test("updated matching panel succeeds and never clicks chat or apply controls", async () => {
  const old = panel("工程师", "旧职位描述", "甲公司");
  const current = card("a", "工程师", "甲公司", () => { install([current.box], panel("工程师", "新的完整职位描述", "甲公司", "a")); });
  install([current.box], old);
  const result = await fast(() => clickAndReadSplitDetail(url("a"))) as { ok: boolean; job: { description: string; salaryText?: string } };
  assert.equal(result.ok, true);
  assert.equal(result.job.description, "新的完整职位描述");
  assert.equal(result.job.salaryText, "20-30K");
  assert.equal(current.box.clicked, 1);
});

test("nested wrapper is skipped in favor of the inner card click handler", async () => {
  const current = card("a", "工程师", "甲公司");
  const wrapper = node(); wrapper.children = current.box.children;
  const setup = (detail: Fake) => { install([wrapper, current.box], detail); current.box.parentElement = wrapper; };
  current.box.onClick = () => setup(panel("工程师", "目标岗位描述", "甲公司", "a"));
  setup(panel("旧岗位", "旧描述"));
  const result = await fast(() => clickAndReadSplitDetail(url("a"))) as { ok: boolean };
  assert.equal(result.ok, true);
  assert.equal(current.box.clicked, 1);
  assert.equal(wrapper.clicked, 0);
});

test("missing and unchanged detail panels have distinct fixed diagnostics", async () => {
  const current = card("a", "工程师", "甲公司");
  install([current.box], null);
  await fails(url("a"), "panel-missing");
  install([current.box], panel("工程师", ""));
  await fails(url("a"), "panel-incomplete");
  install([current.box], panel("工程师", "当前描述", "甲公司"));
  await fails(url("a"), "detail-unchanged");
});

test("same-title cross-company stale panel is rejected even when selected", async () => {
  const wrong = card("b", "工程师", "乙公司");
  const target = card("a", "工程师", "甲公司");
  target.box.selected = true;
  install([wrong.box, target.box], panel("工程师", "乙公司的职位描述", "乙公司", "b"));
  await fails(url("a"));
});

test("same-title panel without company or detail link is rejected", async () => {
  const other = card("b", "工程师", "乙公司");
  const target = card("a", "工程师", "甲公司", () => {
    install([other.box, target.box], panel("工程师", "变化后的描述"));
  });
  install([other.box, target.box], panel("工程师", "旧描述"));
  await fails(url("a"));
});

test("card link or title changing after click fails closed", async () => {
  const target = card("a", "工程师", "甲公司");
  target.box.onClick = () => { target.link.href = url("b"); };
  install([target.box], panel("工程师", "旧描述", "甲公司"));
  await fails(url("a"));
  target.link.href = url("a");
  target.box.onClick = () => { target.name.innerText = "设计师"; };
  await fails(url("a"));
});

test("rejects credential URLs and non-search pages before any click", async () => {
  const target = card("a", "工程师", "甲公司");
  target.link.href = "https://user:pass@www.zhipin.com/job_detail/a.html";
  install([target.box], panel("工程师", "描述", "甲公司"));
  assert.deepEqual(inspectSplitSearch().links, []);
  await fails(url("a"));
  target.link.href = url("a");
  (globalThis as { location: { pathname: string } }).location.pathname = "/web/geek/resume";
  assert.equal(inspectSplitSearch().recognized, false);
  await fails(url("a"));
  assert.equal(target.box.clicked, 0);
  (globalThis as { location: { pathname: string } }).location.pathname = "/web/geek/jobs/";
  assert.deepEqual(inspectSplitSearch().links, [url("a")]);
});

test("an anchor card cannot navigate through an unrelated href", async () => {
  const target = card("a", "工程师", "甲公司");
  target.box.tagName = "A";
  target.box.href = "https://example.com/other";
  install([target.box], panel("工程师", "描述", "甲公司"));
  await fails(url("a"));
  assert.equal(target.box.clicked, 0);
});

test("same title and company with another URL requires panel link evidence", async () => {
  const other = card("b", "工程师", "甲公司");
  const target = card("a", "工程师", "甲公司", () => {
    install([other.box, target.box], panel("工程师", "更新后的描述", "甲公司"));
  });
  install([other.box, target.box], panel("工程师", "旧描述", "甲公司", "b"));
  await fails(url("a"));
  target.box.onClick = () => { install([other.box, target.box], panel("工程师", "目标职位描述", "甲公司", "a")); };
  const result = await fast(() => clickAndReadSplitDetail(url("a"))) as { ok: boolean; job: { description: string } };
  assert.equal(result.ok, true);
  assert.equal(result.job.description, "目标职位描述");
});

test("hidden company rejects a card; hidden optional fields are omitted", async () => {
  const hiddenCompany = card("b", "设计师", "乙公司");
  hiddenCompany.box.children[".boss-name"]!.display = "none";
  const target = card("a", "工程师", "甲公司", () => {
    const detail = panel("工程师", "新描述", "甲公司");
    detail.children[".job-salary"]!.display = "none";
    install([target.box], detail);
  });
  target.box.children[".company-location"]!.display = "none";
  target.box.children[".job-salary"]!.display = "none";
  install([hiddenCompany.box, target.box], panel("工程师", "旧描述", "甲公司"));
  await fails(url("b"), "card-incomplete");
  const result = await fast(() => clickAndReadSplitDetail(url("a"))) as { ok: boolean; job: { location?: string; salaryText?: string } };
  assert.equal(result.ok, true);
  assert.equal(result.job.location, undefined);
  assert.equal(result.job.salaryText, undefined);
});

test("salary fallback skips hidden and encoded candidates but preserves negotiable", async () => {
  const target = card("a", "工程师", "甲公司");
  const detail = panel("工程师", "目标描述", "甲公司", "a");
  target.box.selected = true;
  const hiddenSalary = node("99-100K", detail); hiddenSalary.display = "none";
  for (const glyph of ["\uE001", "\uFFFD", "\u{F0001}", "\u{100001}"]) {
    detail.children[".job-salary"]!.innerText = `2${glyph}-40K`;
    detail.children[".salary"] = hiddenSalary;
    install([target.box], detail);
    let result = await metadata();
    assert.equal(result.salaryText, "20-30K");
    target.box.children[".job-salary"]!.innerText = `2${glyph}-40K`;
    result = await metadata();
    assert.equal(result.salaryText, undefined);
    target.box.children[".job-salary"]!.innerText = "20-30K";
  }
  detail.children[".salary"] = node("面议", detail);
  assert.equal((await metadata()).salaryText, "面议");
});

test("industry is read only from the matching company and conflicting values stay unknown", async () => {
  const target = card("a", "工程师", "甲公司");
  const detail = panel("工程师", "目标描述", "甲公司", "a");
  target.box.selected = true;
  detail.children[".company-info .industry"] = node("保险", detail);
  install([target.box], detail);
  assert.equal((await metadata()).industry, "保险");
  target.box.children[".company-info .industry"] = node("计算机软件", target.box);
  assert.equal((await metadata()).industry, undefined);
  detail.children[".company-info .industry"]!.display = "none";
  assert.equal((await metadata()).industry, "计算机软件");
  target.box.children[".company-info .industry"]!.display = "none";
  assert.equal((await metadata()).industry, undefined);
});

test("anonymous clients and visible headhunter labels cannot inherit an agency industry", async () => {
  for (const [company, label] of [["上海某大型公司", ""], ["甲公司", "猎头"], ["甲公司", "客户公司：甲公司"]]) {
    const target = card("a", "工程师", company);
    const detail = panel("工程师", "目标描述", company, "a");
    target.box.selected = true;
    target.box.innerText = label;
    target.box.children[".company-info .industry"] = node("人力资源服务", target.box);
    detail.children[".company-info .industry"] = node("人力资源服务", detail);
    install([target.box], detail);
    assert.equal((await metadata()).industry, undefined);
    target.box.innerText = "";
    detail.innerText = label;
    assert.equal((await metadata()).industry, undefined);
  }
});
