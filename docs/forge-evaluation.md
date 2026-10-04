# Generating the CLI with forge: an evaluation

Issue #77 asked whether `pds` (`apps/cli/pds.ts`) should be generated from
[`openapi.json`](../packages/client/openapi.json) with
[cloudflare/forge](https://github.com/cloudflare/forge) instead of written by
hand. Checked on 2026-10-04 by running forge against the spec and driving the
result against a stand-in server.

**Recommendation: skip.** Forge has no CLI generator of its own today. The
one that exists is the `cf` CLI's, and it emits commands bound to Cloudflare's
runtime. It took three workarounds to run it on this spec, and the output then
mishandled 5 of the 20 operations. Reconsider only if both of these happen:
forge publishes a CLI generator that works on any spec without Cloudflare's
runtime, and `pds` needs to expose most of the 17 REST operations, so that
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
     (patch below).
   - *`Root hand-written command "auth" collides with a generated product`*:
     `cf`'s own `auth` command took the name. We renamed our group to `oauth`.
   - *`17 command(s) failed to generate`*: all 17 are `cf`'s hand-written
     commands (`containers build`, `tunnels run`, …), whose operations are not
     in our spec. We let the transformer return instead of throwing (patch
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
   with `git checkout HEAD -- …`. After that it ran with
   `CLOUDFLARE_API_BASE_URL=http://127.0.0.1:18093`,
   `CLOUDFLARE_API_TOKEN=dummy-token`, `CF_SEND_TELEMETRY=false` and
   `DO_NOT_TRACK=1`, with `HOME` set to the scratch directory, against two
   servers:
   - The #75 stand-in (`standin.mjs`, port 18093) for sessions and artifacts.
   - A 15-line server on port 18094 that streams NDJSON for
     `POST /api/auth/login` and answers 500 to everything else.

The overlay, run with
`jq -f overlay.jq openapi.json > openapi.forge.json`:

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

The patch to `cf` at `1f0303ea`:

```diff
--- a/packages/cli/generate.ts
+++ b/packages/cli/generate.ts
-preserveWorkersSecretUpdatePositional(cliSource);
+// preserveWorkersSecretUpdatePositional(cliSource);
--- a/packages/cli/generator/index.ts
+++ b/packages/cli/generator/index.ts
 		console.error("");
+		if (process.env.FORGE_EVAL) return;
 		throw new Error(
```

## Generated commands compared with `pds`

| | Generated (forge + `cf`'s generator) | `pds` (hand-written) |
|---|---|---|
| Coverage | One command per operation, 20/20. `sessions list`, `sessions create`, `artifacts get` and the 500 error worked against the stand-ins. | 3 commands: `list`, `create` (2 of the 17 REST operations) and `prompt` |
| WebSocket upgrades (3) | Generated as plain GETs. `sessions socket s1` got an HTTP 404 from the stand-in, which only accepts upgrades; per the protocol doc the worker answers 426. They are unusable as commands. | `prompt` runs a turn over the Session socket. The other two sockets are not exposed. |
| NDJSON `startLogin` | Waits for the whole stream, then prints `{"ok":false,"error":{"reason":"non-json",…}}` and **exits 0**. The sign-in URL in the first line is shown only after the sign-in ends. | Not a command |
| Spec/flag collisions | `artifacts list` sends `q=false` on every call, so every listing becomes a search: the spec's `q` parameter collides with `cf`'s global `-q/--quiet`. `--q Plan` fails with `Unknown command: Plan`. | None; the flags are chosen by hand |
| Text output | None; always pretty-printed JSON, piped or not | One line per Session (`id⇥status⇥name`) or the new id |
| JSON output | The default (pretty-printed) | `--json`: one compact JSON value |
| API error | Boxed `APIError / InternalServerError / Status code: 500 / Body: {"error": …}` on stderr | `pds: <url>: Directory unavailable` |
| Unreachable server | `fetch failed / Envelope Error`, with no host or cause | `pds: <url>: fetch failed (connect ECONNREFUSED …)` |
| Exit codes | 0 OK. 1 for API errors *and* for usage errors (an unknown flag prints the help, then exits 1). 0 for the failed login above. | 0 OK, 1 failure, 2 usage |
| Help | Per-command text taken from the spec's summaries and descriptions (good). But every `--help` opens with `cf`'s "AGENT COMMAND DISCOVERY" banner, lists `cf`'s global flags (`--zone`, `--profile`, `--local`, `--persist-to`), and the root help includes `cf`'s own commands (`auth`, `build`, `deploy`, `dev`, `init`, `migrate`, …). | One screen listing the groups and three options |
| `--dry-run` | Prints `https://api.cloudflare.com/client/v4/api/sessions`, which is hard-coded and wrong for this API | None |
| Auth | Refuses to run without `CLOUDFLARE_API_TOKEN` or `cf auth login`, then sends that token as a bearer to our system | None yet; `system()` in the client is where auth will attach |
| What it needs | Docker and a 1.32 GB image. The `cf` workspace: 408 packages, with build scripts allowed for `esbuild` and `workerd`, on pnpm 12.6. The generated code imports `cf`'s `src/lib` (auth, telemetry, output, progress: about 9,600 lines) and yargs. | `node:util` and `@pi-durable-sessions/client` |
| Keeping it current | Re-run the pipeline (about a minute once the image is cached). Every new operation needs overlay names. The three workarounds above have to be carried against `cf` `main`, which changes daily and is not a published package. | `pnpm check` fails when `openapi.ts` lags the spec (`openapi-typescript --check`), and `tsc` then flags any `pds` call the change breaks. Exposing a new operation is one entry in the `groups` table (`list` and `create` are about 10 lines each). |

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
  modules there. The cost is that `pds` becomes a fork of `cf`'s CLI, with its
  auth, telemetry, global flags and help banner.
- **Write our own transformer on forge's core.** It would read
  `forge.commands` and emit a generated file of entries that `pds.ts` merges
  into its `groups` table as an extra group (say "API"), next to the
  hand-written `Sessions` and the future `System`. That works with today's
  structure. But the core then contributes only the command tree, which is 20
  operations that `pds` can read from `openapi.json` directly. The emitter,
  output, errors and exit codes would all be ours to write.

Either way, generated names must not take the hand-written ones. The run hit
this twice: our `auth` group collided with `cf`'s `auth` command, and the `q`
parameter with `cf`'s `-q` flag. With the second option, `pds` would need a
check that fails on a duplicate command name or flag.

## Kept, and not verified

The generated output is not committed here. It is reproducible with the steps
above, and the copy from this run was left in the evaluator's scratch
directory (`output/commands`, `output/sdk`).

Not verified:

- The three socket commands against the real worker. They were run only
  against the stand-in, which answers 404; the 426 is taken from the protocol
  doc.
- `updateSession`, `listPorts`, `listProviders`, `setApiKey`, `finishLogin`,
  `logout`, `authCallback`, `listRepos`, `listBranches` and both secrets
  operations, which were generated but not called because the stand-ins do not
  serve them. Nothing was pointed at the live system.
- Whether `cf`'s generated tree type-checks against our SDK. `cf`'s
  `check:type` was not run; the generated commands ran under tsx, which does
  not type-check.
- Any timeline for forge's own CLI target or its npm release, beyond the
  maintainers' comments linked above.
