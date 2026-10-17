import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getOrThrow, LineScanner } from "@earendil-works/pi-durable/env";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { sandboxEnv } from "./src/sandbox-env.js";
import { localSandbox } from "./local-sandbox.check.mjs";

const cwd = await mkdtemp(join(tmpdir(), "pds-env-"));
const sandbox = localSandbox(cwd);
const env = sandboxEnv(sandbox, "test", cwd);
const aborted = { ...ctx, abortSignal: AbortSignal.abort() };
const path = join(cwd, "a ' file.txt");
try {
  await writeFile(path, "original\nline two\n");
  const reader = getOrThrow(await env.openBinaryReader(path, undefined, ctx));
  assert.equal(getOrThrow(await reader.info(ctx)).size, 18);
  assert.equal(new TextDecoder().decode(getOrThrow(await reader.read(0, 8, ctx))), "original");
  assert.equal(getOrThrow(await reader.read(999, 5, ctx)).length, 0);
  assert.equal(getOrThrow(await reader.read(0, 0, ctx)).length, 0);
  assert.equal((await reader.read(-1, 1, ctx)).error.code, "invalid");
  assert.equal((await reader.read(0, 1.5, ctx)).error.code, "invalid");
  assert.equal((await reader.read(0, 1, aborted)).error.code, "aborted");
  await rename(path, `${path}.old`);
  await writeFile(path, "replacement");
  await writeFile(`${path}.old`, "edited original\n");
  assert.equal(new TextDecoder().decode(getOrThrow(await reader.read(0, 100, ctx))), "edited original\n", "holds the same file, not a snapshot or a reopened path");
  assert.equal(getOrThrow(await reader.info(ctx)).size, 16);
  await reader.close(ctx);
  await reader.close(ctx);
  assert.equal((await reader.info(ctx)).error.code, "invalid");
  assert.equal((await reader.read(0, 0, ctx)).error.code, "invalid");

  assert.equal((await env.openBinaryReader(cwd, undefined, ctx)).error.code, "is_directory");
  assert.equal((await env.openBinaryReader(`${path}.missing`, undefined, ctx)).error.code, "not_found");
  assert.equal((await env.openBinaryReader(path, undefined, aborted)).error.code, "aborted");
  await symlink(path, `${path}.link`);
  assert.equal((await env.openBinaryReader(`${path}.link`, { noFollow: true }, ctx)).error.code, "invalid");
  const linked = getOrThrow(await env.openBinaryReader(`${path}.link`, undefined, ctx));
  await linked.close(ctx);
  getOrThrow(await env.exec(["mkfifo", `${path}.fifo`], undefined, ctx));
  assert.equal((await env.openBinaryReader(`${path}.fifo`, undefined, ctx)).error.code, "invalid", "FIFO open must not block");

  // BOM, invalid UTF-8, trailing empty line, and a split multibyte character
  // across the transport chunk boundary. No reply contains the whole file.
  const bytes = Buffer.concat([Buffer.from([239, 187, 191]), Buffer.alloc(262140, 97), Buffer.from("€\n"), Buffer.from([226, 130, 10]), Buffer.from("\nlast\n")]);
  await writeFile(path, bytes);
  const scanned = getOrThrow(await env.openBinaryReader(path, undefined, ctx));
  for (const [startLine, endLine] of [[0, undefined], [0, 1], [1, 3], [3, 8], [99, undefined]]) {
    const expected = new LineScanner(startLine, endLine);
    expected.push(bytes);
    assert.deepEqual(getOrThrow(await scanned.scanLines({ startLine, endLine }, ctx)), expected.finish());
  }
  assert.equal((await scanned.scanLines({ startLine: 2, endLine: 2 }, ctx)).error.code, "invalid");
  await env.cleanup(ctx);
  assert.equal((await scanned.info(ctx)).error.code, "invalid");
  assert(sandbox.stats.maxReply < 360_000, "transport replies stay bounded");

  const read = createReadTool();
  await writeFile(path, "first\nsecond\nthird");
  const result = await read.execute({ path, offset: 2, limit: 1 }, { env }, ctx);
  assert.equal(result.output[0].text, "second");
  await writeFile(path, "x".repeat(100_000));
  const long = await read.execute({ path }, { env }, ctx);
  assert(long.output[0].text.length <= 50 * 1024);
  assert(long.diagnostics.some((d) => d.code === "truncated"));

  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/c9sAAAAASUVORK5CYII=", "base64"));
  getOrThrow(await env.writeFile(path, png, ctx));
  const image = await read.execute({ path }, { env, agent: async () => ({}) }, ctx);
  assert.equal(image.output[0].type, "image");
  assert.equal(image.output[0].mimeType, "image/png");
  assert.equal(image.output[0].data, Buffer.from(png).toString("base64"));

  let stdout = "", stderr = "";
  const literal = "$(touch SHOULD_NOT_EXIST) ' ; $HOME\nnext";
  const exec = getOrThrow(await env.exec(["node", "-e", "process.stdout.write(process.argv[1]);process.stderr.write('err')", literal], {
    onOutput: (text, _ctx, info) => { if (info.stream === "stdout") stdout += text; else stderr += text; },
  }, ctx));
  assert.equal(exec.exitCode, 0);
  assert.equal(stdout, literal);
  assert.equal(stderr, "err");
  assert.equal(getOrThrow(await env.exists(join(cwd, "SHOULD_NOT_EXIST"))).valueOf(), false);
  assert.equal((await env.exec([], undefined, ctx)).error.code, "spawn_error");
  assert.equal((await env.exec("true", undefined, aborted)).error.code, "aborted");
  assert.equal((await env.openDirReader(cwd, ctx)).error.code, "not_supported");
  assert.equal((await env.watch([], () => {}, ctx)).error.code, "not_supported");
  console.log("sandbox reader and 1.3 tools: ok");
} finally {
  await env.cleanup(ctx);
  await sandbox.close();
  await rm(cwd, { recursive: true, force: true });
}
