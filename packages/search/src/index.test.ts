import test from "node:test";
import assert from "node:assert/strict";
import type { Job } from "../../contracts/src/index.ts";
import { cosine, searchJobs, VectorIndex } from "./index.ts";

const job = (id: string, title: string): Job => ({
  id,
  title,
  source: "official",
  sourceId: "source",
  sourceJobId: id,
  url: "https://example.test",
  company: "Example",
  companyAliases: [],
  industry: null,
  location: "上海",
  remote: false,
  salaryMin: null,
  salaryMax: null,
  salaryMonths: null,
  experienceMin: null,
  description: "TypeScript",
  skills: ["TypeScript"],
  education: null,
  firstSeen: "",
  lastSeen: "",
  contentHash: id,
  status: "active",
});
test("cosine ranks vectors and rejects dimension mismatch", () => {
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.throws(() => cosine([1], [1, 0]));
});
test("semantic search never mixes embedding models or dimensions", () => {
  const index = new VectorIndex();
  index.upsert(
    "a",
    {
      vectors: [[1, 0]],
      endpoint: "https://x/v1/embeddings",
      model: "m1",
      dimensions: 2,
      identity: JSON.stringify(["https://x/v1/embeddings", "m1", 2]),
    },
    [1, 0],
  );
  const hits = searchJobs(
    [job("a", "Engineer"), job("b", "Engineer")],
    {
      semanticVector: [1, 0],
      embeddingIdentity: JSON.stringify(["https://x/v1/embeddings", "m1", 2]),
    },
    index,
  );
  assert.equal(hits[0]?.job.id, "a");
  assert.equal(hits[1]?.semanticScore, null);
  assert.equal(
    searchJobs(
      [job("a", "Engineer")],
      {
        semanticVector: [1, 0],
        embeddingIdentity: JSON.stringify(["https://x/v1/embeddings", "m2", 2]),
      },
      index,
    )[0]?.semanticScore,
    null,
  );
});
