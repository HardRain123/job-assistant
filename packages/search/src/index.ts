import type { Job } from "../../contracts/src/index.ts";
import {
  embeddingIdentity,
  type EmbeddingResult,
} from "../../providers/src/index.ts";

export interface SearchQuery {
  text?: string;
  city?: string;
  company?: string;
  source?: Job["source"];
  activeOnly?: boolean;
  limit?: number;
  semanticVector?: number[];
  embeddingIdentity?: string;
}
export interface SearchHit {
  job: Job;
  keywordScore: number;
  semanticScore: number | null;
  score: number;
}
export interface StoredVector {
  jobId: string;
  vector: number[];
  identity: string;
}
export function cosine(a: number[], b: number[]): number {
  if (
    a.length !== b.length ||
    !a.length ||
    a.some((x) => !Number.isFinite(x)) ||
    b.some((x) => !Number.isFinite(x))
  )
    throw new Error("Incompatible embedding vectors");
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    aa += a[i]! * a[i]!;
    bb += b[i]! * b[i]!;
  }
  if (!aa || !bb) return 0;
  return dot / Math.sqrt(aa * bb);
}
export class VectorIndex {
  private readonly entries = new Map<string, StoredVector>();
  upsert(jobId: string, result: EmbeddingResult, vector: number[]): void {
    if (
      vector.length !== result.dimensions ||
      vector.some((x) => !Number.isFinite(x))
    )
      throw new Error("Invalid vector for embedding model");
    const identity = embeddingIdentity(
      result.endpoint,
      result.model,
      result.dimensions,
    );
    if (identity !== result.identity)
      throw new Error("Embedding identity mismatch");
    this.entries.set(jobId, { jobId, vector: [...vector], identity });
  }
  remove(jobId: string): void {
    this.entries.delete(jobId);
  }
  get(jobId: string, identity: string): number[] | null {
    const found = this.entries.get(jobId);
    return found?.identity === identity ? [...found.vector] : null;
  }
  records(): StoredVector[] {
    return [...this.entries.values()].map((x) => ({
      jobId: x.jobId,
      identity: x.identity,
      vector: [...x.vector],
    }));
  }
  load(records: StoredVector[]): void {
    this.entries.clear();
    for (const item of records) {
      if (
        !item.jobId ||
        !item.identity ||
        !item.vector.length ||
        item.vector.some((x) => !Number.isFinite(x))
      )
        throw new Error("Invalid stored embedding record");
      this.entries.set(item.jobId, { ...item, vector: [...item.vector] });
    }
  }
}
function keywordScore(job: Job, text: string): number {
  const terms = [
    ...new Set(text.toLocaleLowerCase().split(/\s+/).filter(Boolean)),
  ];
  if (!terms.length) return 0;
  const title = job.title.toLocaleLowerCase();
  const skills = job.skills.join(" ").toLocaleLowerCase();
  const description = job.description.toLocaleLowerCase();
  const company = job.company.toLocaleLowerCase();
  return (
    terms.reduce(
      (sum, term) =>
        sum +
        (title.includes(term) ? 4 : 0) +
        (skills.includes(term) ? 3 : 0) +
        (description.includes(term) ? 1 : 0) +
        (company.includes(term) ? 2 : 0),
      0,
    ) /
    (terms.length * 10)
  );
}
export function searchJobs(
  jobs: Job[],
  query: SearchQuery,
  index?: VectorIndex,
): SearchHit[] {
  if (query.semanticVector && !query.embeddingIdentity)
    throw new Error("Embedding identity is required for semantic search");
  if (
    query.limit != null &&
    (!Number.isInteger(query.limit) || query.limit < 0)
  )
    throw new Error("Search limit must be a nonnegative integer");
  return jobs
    .filter(
      (job) =>
        (!query.activeOnly || job.status === "active") &&
        (!query.city ||
          job.location
            ?.toLocaleLowerCase()
            .includes(query.city.toLocaleLowerCase()) ||
          job.remote === true) &&
        (!query.company ||
          job.company
            .toLocaleLowerCase()
            .includes(query.company.toLocaleLowerCase())) &&
        (!query.source || job.source === query.source),
    )
    .map((job) => {
      const kw = keywordScore(job, query.text ?? "");
      const vector =
        query.semanticVector && query.embeddingIdentity
          ? index?.get(job.id, query.embeddingIdentity)
          : null;
      const semantic =
        vector && query.semanticVector
          ? cosine(query.semanticVector, vector)
          : null;
      return {
        job,
        keywordScore: kw,
        semanticScore: semantic,
        score: query.semanticVector
          ? semantic == null
            ? kw * 0.3
            : kw * 0.3 + Math.max(0, semantic) * 0.7
          : kw,
      };
    })
    .sort((a, b) => b.score - a.score || a.job.id.localeCompare(b.job.id))
    .slice(0, query.limit ?? 50);
}
