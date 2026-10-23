# Generating the CLI with forge: an evaluation

Issue #77 asked whether `boxen` (`apps/cli/boxen.ts`) should be generated from
[`openapi.json`](../packages/client/openapi.json) with
[cloudflare/forge](https://github.com/cloudflare/forge) instead of written by
hand. Checked on 2026-10-04 by running forge against the spec and driving the
result against a stand-in server.

**Recommendation: skip.** Forge has no CLI generator of its own today. The
one that exists is the `cf` CLI's, and it emits commands bound to Cloudflare's
runtime. It took three workarounds to run it on this spec, and the output then
mishandled 5 of the 20 operations. Reconsider only if both of these happen:
forge publishes a CLI generator that works on any spec without Cloudflare's
runtime, and `boxen` needs to expose most of the 17 REST operations, so that
writing one table entry per command costs more than running a generator.

## What forge is, as of 2026-10-04

Verified from the repository, its issues, GitHub and npm:

- An OpenAPI 3.x **core library** (`packages/forge`, about 7,800 lines of
  TypeScript, Apache-2.0). It resolves operations, applies overlays, and builds
  a command tree from the Fern extensions `x-fern-sdk-group-name` and
  `x-fern-sdk-method-name`. An operation without a group name produces no
  command. The core writes no code: a separate transformer function walks the
  tree and calls `forge.emit()`.
- One open-source transformer, `forge-transformer-sdk-ts`. It runs Fern's
  TypeScript SDK generator in Docker (`fernapi/fern-typescript-sdk:3.80.1`,
  1.32 GB once built), patched and re-tagged by forge's scripts. The other
  `cloudflare-forge-sdk-*` packages (Python, Go, Java, PHP, C#, Ruby, Rust,
  Swift) are private workspace packages for Cloudflare's own SDKs.
- **No CLI generator in the repo.** The maintainers say so in
  [forge#9](https://github.com/cloudflare/forge/issues/9) and
  [forge#10](https://github.com/cloudflare/forge/issues/10) (2026-09-29): the
  CLI code lives in [cloudflare/cf](https://github.com/cloudflare/cf)
  (`packages/cli/generator/`, about 3,300 lines) "while we develop the CLI
  bits", and is meant to move back into forge later. No date is given.
- **Young and unpublished.** The repo was created on 2026-09-21 and made public
  on 2026-09-28. `main` has 4 commits, the last on 2026-10-02 (`86cb1ef`).
  `@cloudflare/forge` and `@cloudflare/forge-transformer-sdk-ts` return 404 on
  npm. [forge#6](https://github.com/cloudflare/forge/issues/6) says they will
  be published "in the next few days/weeks". `cf` pulls them in as vendored
  tarballs. The repo's GitHub releases (`openapi@<sha>`, several a day) are
  Cloudflare's own OpenAPI bundle, not forge versions. Every package is version
  `0.1.0`. The README calls the project "still early-days" and focused on the
  `cf` CLI.
- To keep generated code current, `cf` re-runs `packages/cli/generate.ts` in
  its build. It pins a Cloudflare spec revision, regenerates the SDK when that
  pin changes, and rewrites the generated commands in
  `src/commands/_generated/`, which are committed to the repo.

This corrects the issue's starting point, which said forge "generates SDKs,
CLIs and docs". The forge repo generates a TypeScript SDK (by way of Fern) and
docs. The CLI is generated in `cf`, by `cf`'s code.

## What was run

The run used scratch directories outside this repo, on Node 26.2.0 and Docker
29.7.2, with forge `86cb1ef3047a` and cf `1f0303ea605b` (`cf` 1.0.0-beta.12;
the vendored `cloudflare-forge-0.1.0.tgz` matches forge `main`'s source). No
dependency was added to this workspace.

1. **Forge core, spec unchanged.** We loaded `openapi.json` into
   `initFromOpenApi()` and listed `forge.commands`. Result: **0 commands**. It
   accepts OpenAPI 3.1, but our spec has no `x-fern-sdk-group-name` fields.
2. **Forge core, spec with an overlay.** The overlay below adds group and
   method names. Result: 7 commands covering all 20 operations.
3. **`cf`'s generator on the overlaid spec.** We ran
   `pnpm install --frozen-lockfile --ignore-scripts` in `cf` (408 packages),
   then:

   ```sh
   cd cf/packages/cli
   FORGE_EVAL=1 FORGE_OPENAPI_BUNDLE=$W/openapi.forge.json \
     PATH=$PWD/node_modules/.bin:$PATH node --import tsx generate.ts
   ```

   `tsx generate.ts` failed first, because tsx's IPC socket path exceeds the
   Unix limit under a long `TMPDIR`, so we ran it through `node --import tsx`.
   SDK generation then succeeded: Fern generated all 20 operations, after
   pulling the image and patching `fern-api`'s `cli.cjs` inside
   `node_modules`. The CLI step failed three times. We got past each failure
   as follows:
   - *`Pinned Forge OpenAPI changed for PUT /accounts/{account_id}/workers/…`*:
     a check that is specific to Cloudflare's spec. We commented it out
     (recipe below).
   - *`Root hand-written command "auth" collides with a generated product`*:
     `cf`'s own `auth` command took the name. We renamed our group to `oauth`.
   - *`17 command(s) failed to generate`*: all 17 are `cf`'s hand-written
     commands (`containers build`, `tunnels run`, …), whose operations are not
     in our spec. We let the transformer return instead of throwing (recipe
     below).

   It then wrote 32 files: 29 command modules, about 2,000 lines, plus 3 JSON
   metadata files. One module is an injected `access` group from `cf`. The
   regenerated SDK is 140 files and about 5,400 lines.
4. **Running the generated commands.** We ran them with `cf`'s entry point,
   `node --import tsx src/dev.ts`. It failed twice before any request was
   sent. First, it could not find `src/sdk/sdk/environments.ts`, because Fern
   only emits that file when the spec names a server, so we added `servers` to
   the overlay. Second, it could not find `core/pagination/Page.js`, because
   `cf`'s runtime imports Fern helpers that are emitted only for Cloudflare's
   spec. We restored the 19 missing `core/` files from `cf`'s committed SDK
   (the last command in the recipe below). After that, the generated commands
   ran against the stand-in below, with a dummy Cloudflare token and telemetry
   off. A second copy of the stand-in with `FAIL=1` supplied the 500 case.

The comparison first ran against the #75 stand-in plus a separate NDJSON
server, which are not kept. The stand-in below combines the parts of both that
the comparison used. On 2026-10-04 the recipe was followed again from an empty
directory with this stand-in: it generated 20 SDK operations and wrote 32 CLI
files, the restore loop put back all 19 files, and every result in the table
below came out the same.

### Reproduce

Requirements: Node 22 or later (26.2.0 here), pnpm 12, Docker, `jq` and
`perl`. Work in an empty directory outside this repo. Save the overlay and the
stand-in below into it as `overlay.jq` and `standin.mjs`. The generate step
pulls `fernapi/fern-typescript-sdk:3.80.1` and re-tags it locally; remove it
afterwards with `docker rmi fernapi/fern-typescript-sdk:3.80.1`. If `TMPDIR`
is a long path, run it through `node --import tsx` as below, not the `tsx`
CLI, whose IPC socket path then exceeds the Unix limit.

```sh
W=$PWD
cp <this repo>/packages/client/openapi.json .
git clone https://github.com/cloudflare/cf.git
git -C cf checkout 1f0303ea605b458c800f0a9b0040f674a8096c3d
cd cf
pnpm install --frozen-lockfile --ignore-scripts
# 1. skip a check that only holds for Cloudflare's spec
sed -i 's|^preserveWorkersSecretUpdatePositional(cliSource);|// &|' packages/cli/generate.ts
# 2. do not fail on cf's own hand-written commands, whose operations are not in our spec
perl -0pi -e 's/(\t\tthrow new Error\(\n\t\t\t`\$\{generationErrors\.length\} command)/\t\tif (process.env.FORGE_EVAL) return;\n$1/' \
  packages/cli/generator/index.ts
jq -f "$W/overlay.jq" "$W/openapi.json" > "$W/openapi.forge.json"
cd packages/cli
FORGE_EVAL=1 FORGE_OPENAPI_BUNDLE="$W/openapi.forge.json" \
  PATH=$PWD/node_modules/.bin:$PATH node --import tsx generate.ts
# 3. put back the Fern core files cf's runtime imports but our SDK does not emit (19)
git ls-tree -r --name-only HEAD src/sdk/sdk/core | while read -r f; do [ -e "$f" ] || git checkout HEAD -- "$f"; done
```

Steps 1 and 2 (forge's core alone) can be run from `cf/packages/cli`. They
print `0 []` for `openapi.json` and `20` with the 7 groups for
`openapi.forge.json`:

```sh
cat > core-probe.ts <<'EOF'
import { readFileSync } from "node:fs";
import { initFromOpenApi } from "@cloudflare/forge";
const forge = initFromOpenApi(JSON.parse(readFileSync(process.argv[2], "utf8")));
console.log(forge.methodStats().total, JSON.stringify(forge.methodMap()));
EOF
node --import tsx core-probe.ts "$W/openapi.json"; node --import tsx core-probe.ts "$W/openapi.forge.json"
```

To run the commands, stay in `cf/packages/cli`:

```sh
node "$W/standin.mjs" &                  # port 18093
PORT=18094 FAIL=1 node "$W/standin.mjs" &  # the 500 case
mkdir -p "$W/home"
gen() { env HOME="$W/home" CF_SEND_TELEMETRY=false DO_NOT_TRACK=1 \
  CLOUDFLARE_API_BASE_URL="${BASE:-http://127.0.0.1:18093}" CLOUDFLARE_API_TOKEN=dummy-token \
  node --no-deprecation --import tsx src/dev.ts "$@"; }
gen sessions list; gen sessions create --name x; gen artifacts get a1; gen artifacts get nope
gen artifacts list --session s1        # the stand-in logs q=false
gen sessions socket s1; gen oauth login --provider anthropic; gen sessions create --nmae typo
BASE=http://127.0.0.1:18094 gen sessions list; BASE=http://127.0.0.1:18099 gen sessions list
# boxen, for the other column: node <this repo>/apps/cli/boxen.ts list --url http://127.0.0.1:18093
```

`overlay.jq`, which gives every operation a group and a method name, and the
server Fern needs before it emits `environments.ts`:

```jq
{
  listSessions: ["sessions","list"], createSession: ["sessions","create"],
  updateSession: ["sessions","update"], getDiff: ["sessions","diff"],
  listPorts: ["sessions","ports"], sessionSocket: ["sessions","socket"],
  terminalSocket: ["sessions","terminal"], directorySocket: ["directory","socket"],
  listProviders: ["providers","list"], setApiKey: ["providers","setKey"],
  startLogin: ["oauth","login"], finishLogin: ["oauth","finish"],
  logout: ["oauth","logout"], authCallback: ["oauth","callback"],
  listArtifacts: ["artifacts","list"], getArtifact: ["artifacts","get"],
  listRepos: ["github","repos"], listBranches: ["github","branches"],
  listSandboxTokens: ["secrets","list"], setSandboxTokens: ["secrets","set"]
} as $m
| .paths |= with_entries(.value |= with_entries(
    if (.value | type) == "object" and (.value.operationId? // null) != null and $m[.value.operationId]
    then .value += {"x-fern-sdk-group-name": $m[.value.operationId][0], "x-fern-sdk-method-name": $m[.value.operationId][1]}
    else . end))
| .servers = [{url: "http://localhost:8093", "x-fern-server-name": "Default"}]
```

`standin.mjs`, which serves only the routes the comparison called. Any server
that answers these routes according to `openapi.json` will do:

```js
// What the comparison ran against: the routes the two CLIs called, nothing more.
// FAIL=1 answers 500 {"error":"Directory unavailable"} to every route but login.
import http from "node:http";
const sessions = [{ id: "s1", name: "untitled", cwd: "/workspace", createdAt: 1, metadataRevision: 0, status: "idle", lastActivity: 2 }];
const art = { id: "a1", session: "s1", title: "Plan", kind: "markdown", language: null, version: 2, createdAt: 1, updatedAt: 2 };
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (code, body) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
  console.error(req.method, req.url);
  if (req.method === "POST" && u.pathname === "/api/auth/login") { // NDJSON: url, keepalive, done
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write(JSON.stringify({ url: "https://example.com/authorize" }) + "\n");
    setTimeout(() => res.write("{}\n"), 1000);
    return setTimeout(() => res.end(JSON.stringify({ done: true }) + "\n"), 2000);
  }
  if (process.env.FAIL) return json(500, { error: "Directory unavailable" });
  if (req.method === "GET" && u.pathname === "/api/sessions") return json(200, sessions);
  if (req.method === "POST" && u.pathname === "/api/sessions") {
    let body = "";
    req.on("data", (c) => { body += c; });
    return req.on("end", () => {
      const b = JSON.parse(body || "{}");
      const s = { ...sessions[0], id: crypto.randomUUID(), name: b.name ?? "untitled", repo: b.repo ?? null, branch: b.branch ?? null };
      sessions.push(s);
      json(200, s);
    });
  }
  if (req.method === "GET" && u.pathname === "/api/artifacts") { // q (any value) searches; else filter by session
    if (u.searchParams.has("q")) return json(200, [{ ...art, snippet: "[Step] one" }]);
    const s = u.searchParams.get("session");
    return json(200, !s || s === "s1" ? [art] : []);
  }
  if (req.method === "GET" && u.pathname === "/api/artifacts/a1") return json(200, { ...art, content: "# Plan v2\n\nStep one." });
  if (req.method === "GET" && u.pathname.startsWith("/api/artifacts/")) return json(404, { error: "No such artifact" });
  res.writeHead(404).end(); // includes a plain GET of the socket paths
}).listen(Number(process.env.PORT ?? 18093), "127.0.0.1");
```

## Generated commands compared with `boxen`

| | Generated (forge + `cf`'s generator) | `boxen` (hand-written) |
|---|---|---|
| Coverage | One command per operation, 20/20. `sessions list`, `sessions create`, `artifacts get` and the 500 error worked against the stand-ins. | 3 commands: `list`, `create` (2 of the 17 REST operations) and `prompt` |
| WebSocket upgrades (3) | Generated as plain GETs. `sessions socket s1` got an HTTP 404 from the stand-in, which does not serve the socket paths; per the protocol doc, the worker answers a plain GET with 426. They are unusable as commands. | `prompt` runs a turn over the Session socket. The other two sockets are not exposed. |
| NDJSON `startLogin` | Waits for the whole stream, then prints `{"ok":false,"error":{"reason":"non-json",…}}` and **exits 0**. The sign-in URL in the first line is shown only after the sign-in ends. | Not a command |
| Spec/flag collisions | `artifacts list` sends `q=false` on every call, so every listing becomes a search: the spec's `q` parameter collides with `cf`'s global `-q/--quiet`. `--q Plan` fails with `Unknown command: Plan`. | None; the flags are chosen by hand |
| Text output | None; always pretty-printed JSON, piped or not | One line per Session (`id⇥status⇥name`) or the new id |
| JSON output | The default (pretty-printed) | `--json`: one compact JSON value |
| API error | Boxed `APIError / InternalServerError / Status code: 500 / Body: {"error": …}` on stderr | `boxen: <url>: Directory unavailable` |
| Unreachable server | `fetch failed / Envelope Error`, with no host or cause | `boxen: <url>: fetch failed (connect ECONNREFUSED …)` |
| Exit codes | 0 OK. 1 for API errors *and* for usage errors (an unknown flag prints the help, then exits 1). 0 for the failed login above. | 0 OK, 1 failure, 2 usage |
| Help | Per-command text taken from the spec's summaries and descriptions (good). But every `--help` opens with `cf`'s "AGENT COMMAND DISCOVERY" banner, lists `cf`'s global flags (`--zone`, `--profile`, `--local`, `--persist-to`), and the root help includes `cf`'s own commands (`auth`, `build`, `deploy`, `dev`, `init`, `migrate`, …). | One screen listing the groups and three options |
| `--dry-run` | Prints `https://api.cloudflare.com/client/v4/api/sessions`, which is hard-coded and wrong for this API | None |
| Auth | Refuses to run without `CLOUDFLARE_API_TOKEN` or `cf auth login`, then sends that token as a bearer to our system | None yet; `system()` in the client is where auth will attach |
| What it needs | Docker and a 1.32 GB image. The `cf` workspace: 408 packages, with build scripts allowed for `esbuild` and `workerd`, on pnpm 12.6. The generated code imports `cf`'s `src/lib` (auth, telemetry, output, progress: about 9,600 lines) and yargs. | `node:util` and `@boxen/client` |
| Keeping it current | Re-run the pipeline (about a minute once the image is cached). Every new operation needs overlay names. The three workarounds above have to be carried against `cf` `main`, which changes daily and is not a published package. | `pnpm check` fails when `openapi.ts` lags the spec (`openapi-typescript --check`), and `tsc` then flags any `boxen` call the change breaks. Exposing a new operation is one entry in the `groups` table (`list` and `create` are about 10 lines each). |

## Where `prompt` and the #68 commands would go

No generator covers `prompt`. It runs a turn over the Session WebSocket
([session-protocol.md](session-protocol.md)), and OpenAPI describes only the
upgrade. The #68 operations commands (start, stop, deploy, status, logs) act
on processes and runtime settings, not on the API. Both stay hand-written
under any choice. Adopting forge would therefore mean running generated and
hand-written commands in one binary, in one of two ways:

- **Take `cf`'s runtime.** This is `cf`'s own model: one yargs app that
  registers the `_generated/` tree next to a hand-written registry
  (`hand-written.ts`), whose entries can add roots or subgroups or override a
  generated leaf. `prompt` and a `system` group would be hand-written yargs
  modules there. The cost is that `boxen` becomes a fork of `cf`'s CLI, with its
  auth, telemetry, global flags and help banner.
- **Write our own transformer on forge's core.** It would read
  `forge.commands` and emit a generated file of entries that `boxen.ts` merges
  into its `groups` table as an extra group (say "API"), next to the
  hand-written `Sessions` and the future `System`. That works with today's
  structure. But the core then contributes only the command tree, which is 20
  operations that `boxen` can read from `openapi.json` directly. The emitter,
  output, errors and exit codes would all be ours to write.

Either way, generated names must not take the hand-written ones. The run hit
this twice: our `auth` group collided with `cf`'s `auth` command, and the `q`
parameter with `cf`'s `-q` flag. With the second option, `boxen` would need a
check that fails on a duplicate command name or flag.

## Kept, and not verified

The generated output is not committed here. The recipe above regenerates it
from `cf` at `1f0303ea` and repeats the comparison against the inline
stand-in. It was rerun that way once, on 2026-10-04. The result also depends on the external inputs the recipe pins or
pulls: `cf`'s lockfile and the Fern Docker image `3.80.1`.

Not verified:

- The three socket commands against the real worker. They were run only
  against the stand-in, which answers 404; the 426 is taken from the protocol
  doc.
- `updateSession`, `listPorts`, `listProviders`, `setApiKey`, `finishLogin`,
  `logout`, `authCallback`, `listRepos`, `listBranches` and both secrets
  operations, which were generated but not called because the stand-in does not
  serve them. Nothing was pointed at the live system.
- Whether `cf`'s generated tree type-checks against our SDK. `cf`'s
  `check:type` was not run; the generated commands ran under tsx, which does
  not type-check.
- Any timeline for forge's own CLI target or its npm release, beyond the
  maintainers' comments linked above.
