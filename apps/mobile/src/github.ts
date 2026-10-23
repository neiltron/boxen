// Read-only GitHub for the phone's agent: GET on the REST API, straight from
// the phone (api.github.com allows cross-origin calls). One tool over the
// whole API rather than one per endpoint; the model knows its paths.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";

const API = "https://api.github.com";
const MAX_CHARS = 30_000;

// GitHub's JSON is mostly hypermedia links; html_url is the one a person follows.
const compact = (body: string) =>
  JSON.stringify(JSON.parse(body, (key, value) =>
    (key.endsWith("_url") && key !== "html_url") || key === "url" || key === "node_id" ? undefined : value));

export function githubExtension(token: () => Promise<string | undefined>, fetchImpl: typeof fetch = fetch) {
  return defineExtension({
    name: "github",
    sections: [section("github", () =>
      "You can read GitHub with the github tool (GET only): commits, pull requests, issues, compares, diffs. " +
      "Ask for small pages (per_page) and narrow by date or branch.")],
    tools: [defineTool({
      name: "github",
      description:
        "GET a GitHub REST API path, such as /repos/OWNER/REPO/commits?sha=main&per_page=10, " +
        "/repos/OWNER/REPO/pulls?state=closed&sort=updated&direction=desc&per_page=10, /repos/OWNER/REPO/pulls/123/files, " +
        "/repos/OWNER/REPO/compare/BASE...HEAD, or /search/issues?q=repo:OWNER/REPO+is:pr+is:open. " +
        "format diff returns a pull request's or commit's diff. Read-only. Link fields other than html_url are dropped.",
      parameters: Type.Object({
        path: Type.String({ description: "The API path and query, starting with /" }),
        format: Type.Optional(Type.Union([Type.Literal("json"), Type.Literal("diff")], { description: "json (default), or diff for a pull request or commit" })),
      }),
      replay: "safe",
      execute: async ({ path, format }) => {
        const url = new URL(path, API);
        // A path like //host/x leaves the API, and the token would go with it.
        if (!path.startsWith("/") || url.origin !== API) throw new Error("path must be a path on api.github.com, starting with /");
        const key = await token();
        const response = await fetchImpl(url, {
          headers: {
            accept: format === "diff" ? "application/vnd.github.diff" : "application/vnd.github+json",
            ...(key ? { authorization: `Bearer ${key}` } : {}),
          },
        });
        const body = await response.text();
        if (!response.ok) throw new Error(`GitHub ${response.status}: ${body.slice(0, 500)}`);
        const out = format === "diff" ? body : compact(body);
        const text = out.length > MAX_CHARS
          ? `${out.slice(0, MAX_CHARS)}\n… truncated at ${MAX_CHARS} of ${out.length} characters; ask for a smaller page or a narrower path.`
          : out;
        return { output: [{ type: "text", text }] };
      },
    })],
  });
}
