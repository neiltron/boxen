// Network check: the pinned Mermaid CDN bundle still matches its SRI hash.
// pnpm run check:mermaid
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("src/components/panel/ArtifactView.tsx", import.meta.url), "utf8");
const read = (name) => src.match(new RegExp(`const ${name} =\\s*"([^"]+)"`))?.[1];
const url = read("MERMAID_CDN_URL"), integrity = read("MERMAID_CDN_INTEGRITY");
assert.ok(url && integrity, "MERMAID_CDN_URL / MERMAID_CDN_INTEGRITY not found in ArtifactView.tsx");

const res = await fetch(url);
assert.ok(res.ok, `${url}: HTTP ${res.status}`);
const actual = "sha384-" + createHash("sha384").update(Buffer.from(await res.arrayBuffer())).digest("base64");
assert.equal(actual, integrity, `SRI mismatch for ${url}`);
console.log(`ok ${url} ${integrity}`);
