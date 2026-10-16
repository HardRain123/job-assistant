import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error The injected module is deliberately plain JavaScript.
import { inspectSplitSearch, inspectSearchContinuation, advanceSearchList, clickAndReadSplitDetail } from "./split-page.mjs";

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

type DiagnosticNode = Fake & {
  clientHeight: number; scrollHeight: number; scrollTop: number; overflowY: string; disabled?: boolean;
  closest(selector: string): DiagnosticNode | null;
};
const searchUrl = "https://www.zhipin.com/web/geek/jobs?query=Java&city=101020100";
function diagnosticNode(text = "", parent: Fake | null = null): DiagnosticNode {
  return Object.assign(node(text, parent), {
    clientHeight: 500, scrollHeight: 500, scrollTop: 0, overflowY: "visible",
    closest: () => null as DiagnosticNode | null,
  });
}
// Deliberately synthetic DOM fixtures: these assert the read-only contract,
// not that BOSS currently uses a particular scrolling/pagination layout.
function diagnosticDom() {
  const root = diagnosticNode(); root.scrollHeight = 2000;
  const list = diagnosticNode("", root); list.overflowY = "auto"; list.scrollHeight = 1500; list.scrollTop = 100;
  const target = card("a", "工程师", "甲公司");
  target.box.parentElement = list;
  target.link.display = "block"; target.link.rects = 1;
  target.box.querySelectorAll = (selector) => selector === "a[href*='/job_detail/']" ? [target.link] : [];
  list.querySelectorAll = (selector) => selector === ".job-card-box, .job-card-wrap" ? [target.box] : [];
  const nodes: Record<string, Fake[]> = {
    "a[href*='/job_detail/']": [target.link],
    ".job-list-container, .job-list-box": [list],
  };
  Object.assign(globalThis, {
    location: { href: searchUrl, pathname: "/web/geek/jobs" },
    getComputedStyle: (n: DiagnosticNode) => ({ display: n.display, visibility: "visible", overflowY: n.overflowY }),
    document: { scrollingElement: root, querySelectorAll: (selector: string) => nodes[selector] ?? [] },
  });
  return { root, list, target, nodes };
}

function advanceDom(count = 15) {
  const root = diagnosticNode(); root.clientHeight = 825; root.scrollHeight = 2434;
  const list = diagnosticNode("", root); list.clientHeight = list.scrollHeight = 2234;
  const cards: ReturnType<typeof card>[] = [];
  const nodes: Record<string, Fake[]> = { ".job-list-container, .job-list-box": [list] };
  const append = (amount: number) => {
    for (let i = 0; i < amount; i++) {
      const item = card("job" + String(cards.length).padStart(3, "0"), "工程师", "甲公司");
      item.box.parentElement = list;
      cards.push(item);
    }
  };
  append(count);
  list.querySelectorAll = (selector) => selector === ".job-card-box, .job-card-wrap" ? cards.map((item) => item.box) : [];
  const state = { onScroll: (_position: number) => {}, positions: [] as number[], moves: true };
  let position = 0;
  Object.defineProperty(root, "scrollTop", { configurable: true, get: () => position, set: (value: number) => {
    if (state.moves) position = Math.min(root.scrollHeight - root.clientHeight, Math.max(0, value));
    state.positions.push(position);
    state.onScroll(position);
  } });
  Object.assign(globalThis, {
    location: { href: searchUrl, pathname: "/web/geek/jobs" },
    getComputedStyle: (n: DiagnosticNode) => ({ display: n.display, visibility: "visible", overflowY: n.overflowY }),
    document: { scrollingElement: root, querySelectorAll: (selector: string) => nodes[selector] ?? [] },
  });
  return { root, list, cards, nodes, state, append, signature: () => cards.map((item) => item.link.href!).sort().join("|") };
}
type AdvanceResult = { outcome: string; reason: string; links: string[]; signature: string; hasNext: boolean; canContinue: boolean; steps: number; pageUrl: string };
async function advanceClock(action: () => Promise<AdvanceResult>, onWait: (waits: number) => void = () => {}, elapsedPerWait?: number): Promise<AdvanceResult> {
  const originalTimeout = globalThis.setTimeout, originalNow = Date.now;
  let clock = 0, waits = 0;
  Date.now = () => clock;
  globalThis.setTimeout = ((fn: () => void, delay: number) => {
    clock += elapsedPerWait ?? delay;
    onWait(++waits);
    queueMicrotask(fn);
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try { return await action(); } finally { Date.now = originalNow; globalThis.setTimeout = originalTimeout; }
}

test("search continuation scrolls only the bound document with the observed 825/2434 dimensions and stops at a stable bottom", async () => {
  const { root, list, cards, state, signature } = advanceDom();
  const before = signature();
  // Re-evaluation catches accidental closure dependencies in executeScript code.
  const injected = (0, eval)("(" + advanceSearchList.toString() + ")") as typeof advanceSearchList;
  const result = await advanceClock(() => injected(searchUrl, before));
  assert.equal(result.outcome, "end");
  assert.equal(result.reason, "stable-bottom");
  assert.deepEqual(state.positions, [660, 1320, 1609]);
  assert.equal(root.scrollTop, 1609);
  assert.equal(list.scrollTop, 0);
  assert.equal(result.signature, before);
  assert.equal(result.canContinue, false);
  assert.equal(result.hasNext, false);
  assert.equal(result.steps, 3);
  assert.equal(cards.reduce((sum, item) => sum + item.box.clicked + item.link.clicked, 0), 0);
});

test("search continuation recognizes incremental jobs and allows another bounded check without inventing pagination", async () => {
  const { root, cards, append, state, signature } = advanceDom();
  const before = signature();
  state.onScroll = (position) => {
    if (position === 1320 && cards.length === 15) { append(15); root.scrollHeight += 1700; }
  };
  const result = await advanceClock(() => advanceSearchList(searchUrl, before));
  assert.equal(result.outcome, "changed");
  assert.equal(result.reason, "new-jobs");
  assert.equal(result.links.length, 30);
  assert.equal(result.signature, signature());
  assert.equal(result.hasNext, true);
  assert.equal(result.canContinue, true);
  assert.deepEqual(state.positions, [660, 1320]);
  assert.equal(cards.reduce((sum, item) => sum + item.box.clicked + item.link.clicked, 0), 0);
});

test("a next control exposed at the bottom is returned without clicking, including after more than 250 links", async () => {
  const { root, nodes, state, signature } = advanceDom();
  const next = diagnosticNode("下一页", root);
  nodes["button, a"] = Array.from({ length: 300 }, () => diagnosticNode("普通链接", root));
  state.onScroll = (position) => { if (position === 1609) nodes["button, a"].push(next); };
  const result = await advanceClock(() => advanceSearchList(searchUrl, signature()));
  assert.equal(result.outcome, "next-control");
  assert.equal(result.hasNext, true);
  assert.equal(next.clicked, 0);
  assert.deepEqual(state.positions, [660, 1320, 1609]);
});

test("continuation binds one list viewport, accepts equivalent nested wrappers, and rejects distinct lists or nested scroll ambiguity", async () => {
  let fixture = advanceDom();
  const inner = fixture.list;
  const wrapper = diagnosticNode("", fixture.root);
  inner.parentElement = wrapper;
  wrapper.querySelectorAll = inner.querySelectorAll;
  fixture.nodes[".job-list-container, .job-list-box"] = [wrapper, inner];
  inner.overflowY = "auto"; inner.clientHeight = 500; inner.scrollHeight = 900;
  let result = await advanceClock(() => advanceSearchList(searchUrl, fixture.signature()));
  assert.equal(result.outcome, "end");
  assert.equal(inner.scrollTop, 400);
  assert.deepEqual(fixture.state.positions, []);
  fixture = advanceDom();
  const other = diagnosticNode("", fixture.root);
  other.querySelectorAll = fixture.list.querySelectorAll;
  fixture.nodes[".job-list-container, .job-list-box"].push(other);
  result = await advanceClock(() => advanceSearchList(searchUrl, fixture.signature()));
  assert.equal(result.reason, "ambiguous-list");
  assert.deepEqual(fixture.state.positions, []);
  fixture = advanceDom();
  fixture.list.overflowY = "auto"; fixture.list.clientHeight = 500;
  const outer = diagnosticNode("", fixture.root); outer.overflowY = "auto"; outer.scrollHeight = 1000;
  fixture.list.parentElement = outer;
  result = await advanceClock(() => advanceSearchList(searchUrl, fixture.signature()));
  assert.equal(result.reason, "ambiguous-scroll-container");
  assert.deepEqual(fixture.state.positions, []);
  assert.equal(fixture.list.scrollTop, 0);
});

test("continuation stops before scrolling for wrong search, missing bindings, hidden links, login or verification", async () => {
  for (const expected of [searchUrl.replace("Java", "AI"), searchUrl.replace("101020100", "101010100"), searchUrl.replace("www.zhipin.com", "example.com"), searchUrl.replace("https://", "https://user:pass@")]) {
    const fixture = advanceDom();
    const result = await advanceClock(() => advanceSearchList(expected, fixture.signature()));
    assert.equal(result.outcome, "stale");
    assert.deepEqual(fixture.state.positions, []);
  }
  for (const selector of [".login-dialog form", ".verify-dialog", "iframe[src*='captcha']"]) {
    const fixture = advanceDom(); fixture.nodes[selector] = [diagnosticNode()];
    const result = await advanceClock(() => advanceSearchList(searchUrl, fixture.signature()));
    assert.equal(result.outcome, "blocked");
    assert.equal(result.reason, selector === ".login-dialog form" ? "login-required" : "verification-required");
    assert.deepEqual(fixture.state.positions, []);
  }
  let fixture = advanceDom();
  fixture.nodes[".job-list-container, .job-list-box"] = [];
  assert.equal((await advanceClock(() => advanceSearchList(searchUrl, fixture.signature()))).reason, "list-missing");
  assert.deepEqual(fixture.state.positions, []);
  fixture = advanceDom();
  for (const item of fixture.cards) item.link.display = "none";
  assert.equal((await advanceClock(() => advanceSearchList(searchUrl, fixture.signature()))).reason, "list-missing");
  assert.deepEqual(fixture.state.positions, []);
});

test("continuation revalidates navigation, verification and prior jobs after each wait", async () => {
  for (const change of ["url", "verification", "replace"] as const) {
    const fixture = advanceDom();
    const before = fixture.signature();
    const result = await advanceClock(() => advanceSearchList(searchUrl, before), () => {
      if (change === "url") (globalThis.location as unknown as { href: string }).href = searchUrl.replace("Java", "AI");
      if (change === "verification") fixture.nodes[".verify-dialog"] = [diagnosticNode()];
      if (change === "replace") fixture.cards[0].link.href = url("different");
    });
    assert.equal(result.outcome, change === "verification" ? "blocked" : "stale");
    assert.equal(fixture.state.positions.length, 1);
  }
});

test("continuation waits at least two stable seconds at the bottom and observes delayed added jobs", async () => {
  const fixture = advanceDom(), before = fixture.signature();
  let firstBottomWait = 0;
  const result = await advanceClock(() => advanceSearchList(searchUrl, before), (waits) => {
    if (fixture.root.scrollTop === 1609 && !firstBottomWait) firstBottomWait = waits;
    // A delayed response arrives 1.6 seconds after reaching the bottom.
    if (firstBottomWait && waits - firstBottomWait === 4) fixture.append(1);
  });
  assert.equal(result.outcome, "changed");
  assert.equal(result.links.length, 16);
  assert.equal(result.hasNext, true);
});

test("continuation distinguishes step/time/stalled limits from a real end and never scrolls unrelated containers", async () => {
  let fixture = advanceDom(); fixture.root.scrollHeight = 100_000;
  let result = await advanceClock(() => advanceSearchList(searchUrl, fixture.signature()));
  assert.equal(result.outcome, "limit"); assert.equal(result.reason, "step-limit"); assert.equal(result.canContinue, true);
  assert.equal(result.steps, 8);
  fixture = advanceDom(); fixture.root.scrollHeight = 100_000;
  result = await advanceClock(() => advanceSearchList(searchUrl, fixture.signature()), () => {}, 1500);
  assert.equal(result.outcome, "limit"); assert.equal(result.reason, "time-limit"); assert.equal(result.canContinue, true);
  assert.ok(result.steps <= 4);
  fixture = advanceDom(); fixture.state.moves = false;
  result = await advanceClock(() => advanceSearchList(searchUrl, fixture.signature()));
  assert.equal(result.reason, "scroll-not-moving"); assert.equal(result.outcome, "limit");
  assert.equal(fixture.state.positions.length, 2);
  fixture = advanceDom(); fixture.list.parentElement = diagnosticNode();
  result = await advanceClock(() => advanceSearchList(searchUrl, fixture.signature()));
  assert.equal(result.reason, "unbound-scroll-container"); assert.deepEqual(fixture.state.positions, []);
});

test("continuation preserves naturally arrived jobs, supports more than 30 links and caps the collected set at 300", async () => {
  const fixture = advanceDom(290), before = fixture.signature();
  fixture.append(10);
  const result = await advanceClock(() => advanceSearchList(searchUrl, before));
  assert.equal(result.outcome, "changed");
  assert.equal(result.links.length, 300);
  assert.equal(result.signature, fixture.signature());
  assert.equal(result.reason, "link-limit");
  assert.equal(result.canContinue, false);
  assert.deepEqual(fixture.state.positions, []);
  install(fixture.cards.map((item) => item.box), null);
  assert.equal(inspectSplitSearch().links.length, 300);
  const overflow = advanceDom(290), original = overflow.signature();
  overflow.append(20);
  for (const item of overflow.cards.slice(290)) item.link.href = url("aaa" + item.link.href!.split("/").pop()!.replace(".html", ""));
  const capped = await advanceClock(() => advanceSearchList(searchUrl, original));
  assert.equal(capped.outcome, "changed");
  assert.equal(capped.links.length, 300);
  assert.equal(capped.canContinue, false);
  assert.deepEqual(overflow.state.positions, []);
});

test("continuation fails closed on ambiguous next controls, clipped lists, excessive controls and invalid signatures", async () => {
  let fixture = advanceDom();
  fixture.nodes["button, a"] = [diagnosticNode("下一页"), diagnosticNode("Next")];
  let result = await advanceClock(() => advanceSearchList(searchUrl, fixture.signature()));
  assert.equal(result.reason, "ambiguous-next-control"); assert.deepEqual(fixture.state.positions, []);
  fixture = advanceDom(); fixture.list.overflowY = "hidden"; fixture.list.clientHeight = 500;
  result = await advanceClock(() => advanceSearchList(searchUrl, fixture.signature()));
  assert.equal(result.reason, "clipped-list"); assert.deepEqual(fixture.state.positions, []);
  fixture = advanceDom(); fixture.nodes["button, a"] = Array.from({ length: 2001 }, () => diagnosticNode("链接"));
  result = await advanceClock(() => advanceSearchList(searchUrl, fixture.signature()));
  assert.equal(result.reason, "control-limit"); assert.deepEqual(fixture.state.positions, []);
  for (const signature of ["", "javascript:alert(1)", url("x") + "|" + url("x"), "x".repeat(100001)]) {
    result = await advanceClock(() => advanceSearchList(searchUrl, signature));
    assert.equal(result.reason, "invalid-signature"); assert.deepEqual(fixture.state.positions, []);
  }
});

test("search continuation evidence reports bounded list dimensions without scrolling, clicking or reading text", () => {
  const { root, list, target } = diagnosticDom();
  let clicks = 0;
  target.box.onClick = () => clicks++;
  root.onClick = list.onClick = () => clicks++;
  // Private page text must not be copied into fixed structural evidence.
  root.innerText = "私密聊天 账户信息";
  const result = inspectSearchContinuation(searchUrl);
  assert.equal(result.version, 1);
  assert.equal(result.linkCount, 1);
  assert.deepEqual(result.pagination, { matched: 0, visible: 0, enabled: 0, disabled: 0, ambiguous: false, truncated: false });
  assert.deepEqual(result.lists, { matched: 1, visible: 1, truncated: false });
  assert.deepEqual(result.scrollContainers, [
    { kind: "list", depth: 0, clientHeight: 500, scrollHeight: 1500, scrollTop: 100, remaining: 900, canScroll: true, atEnd: false },
    { kind: "document", depth: 0, clientHeight: 500, scrollHeight: 2000, scrollTop: 0, remaining: 1500, canScroll: true, atEnd: false },
  ]);
  assert.equal(list.scrollTop, 100);
  assert.equal(root.scrollTop, 0);
  assert.equal(clicks, 0);
  assert.equal(JSON.stringify(result).includes("私密"), false);
  assert.equal(JSON.stringify(result).includes("甲公司"), false);
});

test("continuation diagnostics deduplicate official next controls and distinguish hidden, disabled and ambiguous controls", () => {
  const { nodes } = diagnosticDom();
  const enabled = diagnosticNode("下一页");
  const icon = diagnosticNode("", enabled); icon.closest = () => enabled;
  const disabledParent = diagnosticNode(); disabledParent.disabled = true;
  const disabled = diagnosticNode("Next", disabledParent);
  const hiddenParent = diagnosticNode(); hiddenParent.display = "none";
  const hidden = diagnosticNode("下页", hiddenParent);
  nodes["button, a"] = [enabled, disabled, hidden];
  nodes[".ui-icon-arrow-right"] = [icon];
  assert.deepEqual(inspectSearchContinuation(searchUrl).pagination,
    { matched: 3, visible: 2, enabled: 1, disabled: 1, ambiguous: false, truncated: false });
  nodes["button, a"].push(diagnosticNode("下一页"));
  assert.equal(inspectSearchContinuation(searchUrl).pagination.ambiguous, true);
  assert.equal(enabled.clicked, 0);
});

test("continuation diagnostics require the exact search query/city and stop at login or verification", () => {
  const { nodes } = diagnosticDom();
  for (const value of [searchUrl.replace("Java", "AI"), searchUrl.replace("101020100", "101010100"),
    "https://www.zhipin.com/web/geek/jobs", searchUrl.replace("www.zhipin.com", "example.com"),
    searchUrl.replace("https://", "https://user:pass@"), searchUrl.replace("/web/geek/jobs", "/web/geek/chat")]) {
    assert.equal(inspectSearchContinuation(value), null, value);
  }
  nodes[".login-dialog form"] = [diagnosticNode()];
  assert.equal(inspectSearchContinuation(searchUrl), null);
  nodes[".login-dialog form"] = [];
  nodes[".verify-dialog"] = [diagnosticNode()];
  assert.equal(inspectSearchContinuation(searchUrl), null);
  nodes[".verify-dialog"][0].display = "none";
  assert.equal(inspectSearchContinuation(searchUrl).version, 1);
});

test("scroll evidence requires a visible known job list and excludes unrelated scrollable sections", () => {
  const { nodes, list, target } = diagnosticDom();
  const ancestor = diagnosticNode("", list.parentElement); ancestor.overflowY = "auto"; ancestor.scrollHeight = 1000;
  list.parentElement = ancestor;
  list.scrollTop = 1000;
  const evidence = inspectSearchContinuation(searchUrl);
  assert.equal(evidence.scrollContainers[0].atEnd, true);
  assert.equal(evidence.scrollContainers[0].remaining, 0);
  assert.equal(evidence.scrollContainers[1].kind, "ancestor");
  target.link.href = "https://example.com/job_detail/a.html";
  assert.deepEqual(inspectSearchContinuation(searchUrl).scrollContainers, []);
  target.link.href = url("a");
  list.display = "none";
  assert.deepEqual(inspectSearchContinuation(searchUrl).scrollContainers, []);
  list.display = "block";
  target.link.display = "contents"; target.link.rects = 0;
  target.link.children.span = node("工程师", target.link);
  assert.equal(inspectSearchContinuation(searchUrl).linkCount, 1);
  assert.equal(inspectSearchContinuation(searchUrl).scrollContainers.length, 3);
  nodes[".job-list-container, .job-list-box"] = [];
  assert.deepEqual(inspectSearchContinuation(searchUrl).scrollContainers, []);
});

test("continuation evidence caps counts, depths, dimensions and container count", () => {
  const { list, nodes } = diagnosticDom();
  list.scrollHeight = 50_000_000;
  list.scrollTop = -50;
  nodes["button, a"] = Array.from({ length: 300 }, () => diagnosticNode("下一页"));
  let parent: DiagnosticNode = list;
  for (let depth = 0; depth < 20; depth++) {
    const next = diagnosticNode("", parent.parentElement); next.overflowY = "auto"; next.scrollHeight = 2000;
    parent.parentElement = next;
    parent = next;
  }
  const result = inspectSearchContinuation(searchUrl);
  assert.equal(result.pagination.matched, 100);
  assert.equal(result.pagination.enabled, 100);
  assert.equal(result.pagination.truncated, true);
  assert.equal(result.truncated, true);
  assert.equal(result.scrollContainers.length, 6);
  assert.equal(result.scrollContainers[0].scrollHeight, 10_000_000);
  assert.equal(result.scrollContainers[0].scrollTop, 0);
  for (const item of result.scrollContainers) {
    assert.ok(item.depth >= 0 && item.depth <= 12);
    for (const key of ["clientHeight", "scrollHeight", "scrollTop", "remaining"]) {
      assert.ok(Number.isInteger(item[key]) && item[key] >= 0 && item[key] <= 10_000_000);
    }
  }
});

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
