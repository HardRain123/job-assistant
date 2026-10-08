import test from "node:test";
import assert from "node:assert/strict";
import type { JobSource } from "../../contracts/src/index.ts";
import {
  allowedUrl,
  crawlOfficial,
  parseSalary,
  type PageFetcher,
} from "./index.ts";

const source: JobSource = {
  id: "acme",
  name: "Acme",
  kind: "official",
  url: "https://careers.example.com/jobs",
  allowedHosts: ["example.com"],
  enabled: true,
  lastSuccess: null,
  lastError: null,
};
test("official crawler parses JSON-LD and bounded job links using injected fixture pages", async () => {
  const pages = new Map([
    [
      "https://careers.example.com/jobs",
      '<a href="/jobs/1">Engineering job</a>',
    ],
    [
      "https://careers.example.com/jobs/1",
      '<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"AI Engineer","description":"Build agent systems","hiringOrganization":{"name":"Acme"},"jobLocation":{"address":{"addressLocality":"上海"}},"baseSalary":"20k-30k·14薪"}</script>',
    ],
  ]);
  const fetcher: PageFetcher = {
    get: async (url) =>
      pages.get(url.toString()) ??
      (() => {
        throw new Error(`unexpected ${url}`);
      })(),
  };
  const jobs = await crawlOfficial(source, { maxPages: 1 }, fetcher);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.title, "AI Engineer");
  assert.equal(jobs[0]!.salaryMin, 20000);
  assert.equal(jobs[0]!.salaryMonths, 14);
  assert.equal(jobs[0]!.location, "上海");
});
test("source URLs reject local and off-allowlist targets", () => {
  assert.throws(() => allowedUrl("http://127.0.0.1/private", ["example.com"]));
  assert.throws(() =>
    allowedUrl("http://[::ffff:127.0.0.1]/private", ["::ffff:127.0.0.1"]),
  );
  assert.throws(() =>
    allowedUrl("https://evil.example.net/jobs", ["example.com"]),
  );
  assert.equal(
    allowedUrl("https://jobs.example.com/openings", ["example.com"]).hostname,
    "jobs.example.com",
  );
});
test("salary normalization handles yearly, monthly and negotiable text", () => {
  assert.deepEqual(parseSalary("24万-36万/年"), {
    salaryMin: 20000,
    salaryMax: 30000,
    salaryMonths: null,
  });
  assert.deepEqual(parseSalary("面议"), {
    salaryMin: null,
    salaryMax: null,
    salaryMonths: null,
  });
  assert.deepEqual(parseSalary("5年以上经验"), {
    salaryMin: null,
    salaryMax: null,
    salaryMonths: null,
  });
  assert.deepEqual(parseSalary("$20k-$30k"), {
    salaryMin: null,
    salaryMax: null,
    salaryMonths: null,
  });
  assert.deepEqual(
    parseSalary({
      currency: "USD",
      value: { minValue: 1000, maxValue: 2000, unitText: "MONTH" },
    }),
    { salaryMin: null, salaryMax: null, salaryMonths: null },
  );
  assert.deepEqual(
    parseSalary({
      currency: "CNY",
      value: { minValue: 120000, maxValue: 240000, unitText: "YEAR" },
    }),
    { salaryMin: 10000, salaryMax: 20000, salaryMonths: null },
  );
});
test("crawl observes the total fetch budget across pagination and repeated links", async () => {
  const fetched: string[] = [];
  const pages = new Map([
    [
      source.url,
      '<a href="/page/2">Next page</a><a href="/jobs/1">Job</a><a href="/jobs/1">Job</a>',
    ],
    ["https://careers.example.com/page/2", '<a href="/jobs/2">Job</a>'],
    ["https://careers.example.com/jobs/1", "<h1>Engineer</h1>"],
  ]);
  const fetcher: PageFetcher = {
    get: async (url) => {
      fetched.push(url.toString());
      return pages.get(url.toString()) ?? "<h1>Other job</h1>";
    },
  };
  await crawlOfficial(source, { maxFetches: 2, maxPages: 3 }, fetcher);
  assert.equal(fetched.length, 2);
  assert.equal(new Set(fetched).size, 2);
});
test("JSON-LD graph arrays preserve canonical URL, identifier and structured CNY salary", async () => {
  const posting = {
    "@graph": [
      {
        "@type": ["Thing", "https://schema.org/JobPosting"],
        title: "Platform Engineer",
        description: "Build APIs",
        url: [{ "@id": "/jobs/platform-42" }],
        identifier: [{ value: "platform-42" }],
        hiringOrganization: [{ name: "Acme" }],
        baseSalary: [
          {
            currency: "CNY",
            value: { minValue: 240000, maxValue: 360000, unitText: "YEAR" },
          },
        ],
      },
    ],
  };
  const fetcher: PageFetcher = {
    get: async () =>
      `<script type="application/ld+json">${JSON.stringify(posting)}</script>`,
  };
  const jobs = await crawlOfficial(source, { maxPages: 1 }, fetcher);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.url, "https://careers.example.com/jobs/platform-42");
  assert.equal(jobs[0]?.sourceJobId, "platform-42");
  assert.equal(jobs[0]?.salaryMin, 20000);
});
