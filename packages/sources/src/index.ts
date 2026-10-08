import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { isIP } from "node:net";
import * as cheerio from "cheerio";
import type { Job, JobSource } from "../../contracts/src/index.ts";

export interface CrawlLimits {
  maxPages?: number;
  maxLinksPerPage?: number;
  maxFetches?: number;
  maxBytes?: number;
  timeoutMs?: number;
}
export interface PageFetcher {
  get(
    url: URL,
    allowedHosts: string[],
    limits: Required<CrawlLimits>,
  ): Promise<string>;
}
const DEFAULT_LIMITS: Required<CrawlLimits> = {
  maxPages: 8,
  maxLinksPerPage: 40,
  maxFetches: 60,
  maxBytes: 1_000_000,
  timeoutMs: 12_000,
};

function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  const mappedV4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedV4) return isPrivateAddress(mappedV4);
  if (ip.includes(":")) {
    const halves = ip.split("::");
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    if (
      halves.length <= 2 &&
      [...left, ...right].every((part) => /^[0-9a-f]{1,4}$/.test(part))
    ) {
      const groups = [
        ...left,
        ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"),
        ...right,
      ].map((part) => Number.parseInt(part, 16));
      if (
        groups.length === 8 &&
        groups.slice(0, 5).every((part) => part === 0) &&
        groups[5] === 0xffff
      )
        return isPrivateAddress(
          `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`,
        );
    }
  }
  if (isIP(ip) === 6) {
    // Public IPv6 unicast is confined to 2000::/3. Keep documentation and
    // transition ranges private even if a resolver happens to return them.
    const first = Number.parseInt(ip.split(":")[0] || "0", 16);
    return (
      first < 0x2000 ||
      first > 0x3fff ||
      ip.startsWith("2001:db8:") ||
      ip.startsWith("2001:0:")
    );
  }
  const parts = ip
    .match(/^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/)
    ?.slice(1)
    .map(Number);
  if (!parts || parts.some((n) => n > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 2 || b === 168)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && parts[2] === 100))) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  );
}

export function allowedUrl(value: string | URL, allowedHosts: string[]): URL {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("only HTTP(S) URLs are allowed");
  if (url.username || url.password)
    throw new Error("URLs with credentials are not allowed");
  const host = url.hostname.toLowerCase();
  const allowed = allowedHosts.some(
    (candidate) =>
      host === candidate.toLowerCase() ||
      host.endsWith(`.${candidate.toLowerCase()}`),
  );
  if (!allowed) throw new Error(`host is outside source allow-list: ${host}`);
  if (isIP(host.replace(/^\[|\]$/g, "")) && isPrivateAddress(host))
    throw new Error(`private address is not allowed: ${host}`);
  return url;
}

/** A small HTTP client that pins each request to a checked public DNS address. */
export const safeFetcher: PageFetcher = {
  async get(input, allowedHosts, limits) {
    let url = allowedUrl(input, allowedHosts);
    for (let redirects = 0; redirects <= 4; redirects += 1) {
      const records = await lookup(url.hostname, { all: true, verbatim: true });
      if (
        !records.length ||
        records.some((record) => isPrivateAddress(record.address))
      )
        throw new Error("DNS resolved to a non-public address");
      const address = records[0]!.address;
      const body = await new Promise<{
        status: number;
        headers: http.IncomingHttpHeaders;
        body: string;
      }>((resolve, reject) => {
        const transport = url.protocol === "https:" ? https : http;
        const request = transport.request(
          url,
          {
            method: "GET",
            headers: {
              accept: "text/html,application/xhtml+xml",
              "user-agent": "JobAssistant/0.1 (official-careers-indexer)",
            },
            timeout: limits.timeoutMs,
            servername: url.hostname,
            lookup: (_hostname, _options, callback) =>
              callback(null, address, address.includes(":") ? 6 : 4),
          },
          (response) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > limits.maxBytes)
                request.destroy(new Error("response exceeds byte limit"));
              else chunks.push(chunk);
            });
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        request.on("timeout", () =>
          request.destroy(new Error("request timed out")),
        );
        request.on("error", reject);
        request.end();
      });
      if ([301, 302, 303, 307, 308].includes(body.status)) {
        const location = body.headers.location;
        if (!location) throw new Error("redirect without location");
        url = allowedUrl(new URL(location, url), allowedHosts);
        continue;
      }
      if (body.status < 200 || body.status >= 300)
        throw new Error(`HTTP ${body.status}`);
      return body.body;
    }
    throw new Error("too many redirects");
  },
};

export function parseSalary(
  raw: unknown,
): Pick<Job, "salaryMin" | "salaryMax" | "salaryMonths"> {
  const unknown = { salaryMin: null, salaryMax: null, salaryMonths: null };
  if (raw && typeof raw === "object") {
    const salary = raw as Record<string, unknown>;
    const value =
      salary.value && typeof salary.value === "object"
        ? (salary.value as Record<string, unknown>)
        : salary;
    const currency = text(salary.currency || value.currency).toUpperCase();
    const unit = text(value.unitText || salary.unitText).toLowerCase();
    const min = Number(value.minValue ?? value.value);
    const max = Number(value.maxValue ?? value.value);
    if (
      !["CNY", "RMB"].includes(currency) ||
      !Number.isFinite(min) ||
      !Number.isFinite(max) ||
      min <= 0 ||
      max < min ||
      !["month", "monthly", "月", "year", "yearly", "annual", "年"].includes(
        unit,
      )
    )
      return unknown;
    const divisor = ["year", "yearly", "annual", "年"].includes(unit) ? 12 : 1;
    return {
      salaryMin: Math.round(min / divisor),
      salaryMax: Math.round(max / divisor),
      salaryMonths: null,
    };
  }
  const salaryText = String(raw ?? "")
    .replace(/\s/g, "")
    .toLowerCase();
  if (
    !salaryText ||
    /面议|negotiable|\$|usd|eur|€|£|gbp|港币|hkd/.test(salaryText)
  )
    return unknown;
  if (!/(薪|\/月|每月|月薪|\/年|每年|年薪)/.test(salaryText)) return unknown;
  const months =
    Number(salaryText.match(/(?:·|x|\*)\s*(\d{1,2})薪/)?.[1] ?? 0) || null;
  const rangeUnit = salaryText.match(
    /^(?:rmb|cny|人民币|¥|￥)?(\d+(?:\.\d+)?)\s*(k|千|万)?[-~至](\d+(?:\.\d+)?)(k|千|万)(?:(?:·|x|\*)\d{1,2}薪)?(?:\/月|每月|月薪|\/年|每年|年薪)?$/,
  );
  const multiplier = (unit: string | undefined) =>
    unit === "万" ? 10000 : unit === "k" || unit === "千" ? 1000 : 1;
  if (!rangeUnit) return unknown;
  const nums = [
    Number(rangeUnit[1]) * multiplier(rangeUnit[2] || rangeUnit[4]),
    Number(rangeUnit[3]) * multiplier(rangeUnit[4]),
  ];
  if (nums[0]! <= 0 || nums[1]! < nums[0]!) return unknown;
  const yearly = /年薪|\/年|每年/.test(salaryText);
  const normalize = (n: number) =>
    yearly ? Math.round(n / 12) : Math.round(n);
  return {
    salaryMin: normalize(nums[0]!),
    salaryMax: normalize(nums[1] ?? nums[0]!),
    salaryMonths: months,
  };
}

function text(value: unknown): string {
  return typeof value === "string"
    ? value
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}
function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value ? [value] : [];
}
function locationOf(value: unknown): string | null {
  const locations = values(value).flatMap((item) =>
    values((item as Record<string, unknown>)?.address),
  );
  const address = locations[0] as Record<string, unknown> | undefined;
  return (
    text(address?.addressLocality) ||
    text(address?.addressRegion) ||
    text(address?.streetAddress) ||
    null
  );
}
function companyOf(value: unknown): string {
  const v = values(value)[0] as Record<string, unknown> | undefined;
  return text(v?.name) || "Unknown company";
}
function flattenJson(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(flattenJson);
  if (!value || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  return [obj, ...values(obj["@graph"]).flatMap(flattenJson)];
}
function jobFromPosting(
  posting: Record<string, unknown>,
  source: JobSource,
  listingUrl: URL,
  now: string,
): Job | null {
  const title = text(posting.title);
  if (!title) return null;
  const description = text(posting.description);
  const salary = parseSalary(values(posting.baseSalary)[0]);
  let url = listingUrl;
  const rawUrl = values(posting.url)[0];
  const urlValue =
    typeof rawUrl === "string"
      ? rawUrl
      : text((rawUrl as Record<string, unknown> | undefined)?.["@id"]);
  try {
    if (urlValue)
      url = allowedUrl(new URL(urlValue, listingUrl), source.allowedHosts);
  } catch {
    return null;
  }
  const identifier = values(posting.identifier)[0];
  const sourceJobId =
    (typeof identifier === "string"
      ? text(identifier)
      : text((identifier as Record<string, unknown> | undefined)?.value)) ||
    url.pathname + url.search;
  const company = companyOf(posting.hiringOrganization);
  const location = locationOf(posting.jobLocation);
  const remote = /telecommute|remote/i.test(
    JSON.stringify(posting.jobLocationType ?? ""),
  );
  return {
    id: `official:${createHash("sha256").update(`${source.id}:${sourceJobId}`).digest("hex").slice(0, 24)}`,
    source: "official",
    sourceId: source.id,
    sourceJobId,
    url: url.toString(),
    company,
    companyAliases: [],
    industry: null,
    title,
    location,
    remote,
    ...salary,
    experienceMin: null,
    description,
    skills: [],
    education: null,
    firstSeen: now,
    lastSeen: now,
    contentHash: createHash("sha256")
      .update(
        JSON.stringify({
          company,
          title,
          location,
          remote,
          salary,
          description,
        }),
      )
      .digest("hex"),
    status: "active",
  };
}
function linksFromHtml(
  html: string,
  page: URL,
  allowedHosts: string[],
  pagination: boolean,
): URL[] {
  const $ = cheerio.load(html);
  const result = new Map<string, URL>();
  $("a[href]").each((_, anchor) => {
    const label = $(anchor).text().trim();
    const href = $(anchor).attr("href");
    if (!href) return;
    try {
      const url = allowedUrl(new URL(href, page), allowedHosts);
      if (
        (pagination
          ? /next|下一页|更多|page|分页/i
          : /job|career|position|opening|职位|岗位|招聘/i
        ).test(`${label} ${url.pathname} ${url.search}`)
      )
        result.set(url.toString(), url);
    } catch {
      /* external and malformed links are intentionally ignored */
    }
  });
  return [...result.values()];
}
function genericJob(
  html: string,
  source: JobSource,
  url: URL,
  now: string,
): Job | null {
  const $ = cheerio.load(html);
  const title =
    $('meta[property="og:title"]').attr("content") ||
    $("h1").first().text().trim();
  if (!title) return null;
  const description =
    $('main, article, [class*="job"], [class*="description"]')
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim() || $("body").text().replace(/\s+/g, " ").trim();
  const company =
    $('meta[property="og:site_name"]').attr("content") || source.name;
  // Generic pages do not reliably distinguish compensation from years of experience.
  const salary = { salaryMin: null, salaryMax: null, salaryMonths: null };
  const sourceJobId = url.pathname + url.search;
  const remote = /remote|远程/i.test(description);
  return {
    id: `official:${createHash("sha256").update(`${source.id}:${sourceJobId}`).digest("hex").slice(0, 24)}`,
    source: "official",
    sourceId: source.id,
    sourceJobId,
    url: url.toString(),
    company,
    companyAliases: [],
    industry: null,
    title,
    location: null,
    remote,
    ...salary,
    experienceMin: null,
    description,
    skills: [],
    education: null,
    firstSeen: now,
    lastSeen: now,
    contentHash: createHash("sha256")
      .update(
        JSON.stringify({
          company,
          title,
          location: null,
          remote,
          salary,
          description,
        }),
      )
      .digest("hex"),
    status: "active",
  };
}

export async function crawlOfficial(
  source: JobSource,
  options: CrawlLimits = {},
  fetcher: PageFetcher = safeFetcher,
): Promise<Job[]> {
  if (source.kind !== "official")
    throw new Error("official crawler only accepts official sources");
  const limits = { ...DEFAULT_LIMITS, ...options };
  if (
    Object.values(limits).some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    )
  )
    throw new Error("crawl limits must be positive integers");
  const entry = allowedUrl(source.url, source.allowedHosts);
  const now = new Date().toISOString();
  const visited = new Set<string>();
  const fetchPage = async (url: URL): Promise<string | null> => {
    if (visited.has(url.toString()) || visited.size >= limits.maxFetches)
      return null;
    visited.add(url.toString());
    return fetcher.get(url, source.allowedHosts, limits);
  };
  const listingHtml = await fetchPage(entry);
  if (listingHtml === null) return [];
  const results = new Map<string, Job>();
  const addPostings = (html: string, url: URL) => {
    const $ = cheerio.load(html);
    $('script[type="application/ld+json"]').each((_, script) => {
      try {
        for (const item of flattenJson(JSON.parse($(script).text())))
          if (
            values(item["@type"]).some(
              (type) =>
                typeof type === "string" && /(?:^|[\/#])JobPosting$/.test(type),
            )
          ) {
            const job = jobFromPosting(item, source, url, now);
            if (job) results.set(job.id, job);
          }
      } catch {
        /* invalid JSON-LD is untrusted input */
      }
    });
  };
  addPostings(listingHtml, entry);
  const pages: Array<{ url: URL; html: string }> = [
    { url: entry, html: listingHtml },
  ];
  const seenPages = new Set([entry.toString()]);
  for (
    let index = 0;
    index < pages.length && pages.length < limits.maxPages;
    index += 1
  ) {
    for (const pageUrl of linksFromHtml(
      pages[index]!.html,
      pages[index]!.url,
      source.allowedHosts,
      true,
    ).slice(0, limits.maxLinksPerPage)) {
      if (seenPages.has(pageUrl.toString()) || pages.length >= limits.maxPages)
        continue;
      seenPages.add(pageUrl.toString());
      const html = await fetchPage(pageUrl);
      if (html !== null) {
        pages.push({ url: pageUrl, html });
        addPostings(html, pageUrl);
      }
    }
  }
  for (const page of pages)
    for (const jobUrl of linksFromHtml(
      page.html,
      page.url,
      source.allowedHosts,
      false,
    ).slice(0, limits.maxLinksPerPage)) {
      const html = await fetchPage(jobUrl);
      if (html === null) continue;
      addPostings(html, jobUrl);
      if (![...results.values()].some((job) => job.url === jobUrl.toString())) {
        const job = genericJob(html, source, jobUrl, now);
        if (job) results.set(job.id, job);
      }
    }
  return [...results.values()];
}
