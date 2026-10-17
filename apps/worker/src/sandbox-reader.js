// A short-lived Node helper keeps the descriptor open in the container. Reopening
// the source path for each range is not safe: an editor can replace that path.
// The SDK has no positional file API. Requests use a private Unix socket, not a
// public port. Each reply is bounded; line scanning uses the upstream decoder.
import { FileError, LineScanner } from "@earendil-works/pi-durable/env";

const CHUNK = 256 * 1024;
const ok = (value) => ({ ok: true, value });
const fail = (code, message, path) => ({ ok: false, error: new FileError(code, message, path) });
const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
const command = (script, args) => `node -e ${quote(script)} ${quote(JSON.stringify(args))}`;

// These strings run only in the container. Do not import Node modules into the worker.
const SERVER = String.raw`
const fs = require('node:fs'), net = require('node:net');
const { path, noFollow } = JSON.parse(process.argv[1]);
let fd, dir, server, timer;
const error = (e) => ({ ok: false, code: ({ ENOENT:'not_found', EACCES:'permission_denied', EPERM:'permission_denied', ENOTDIR:'not_directory', EISDIR:'is_directory', ELOOP:'invalid', EINVAL:'invalid' })[e.code] || 'unknown', message: e.message });
const stop = () => { clearTimeout(timer); if (fd !== undefined) fs.closeSync(fd); if (dir) fs.rmSync(dir, { recursive:true, force:true }); process.exit(0); };
const renew = () => { clearTimeout(timer); timer = setTimeout(stop, 120000); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
try {
  fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (noFollow ? fs.constants.O_NOFOLLOW : 0));
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) throw Object.assign(new Error('Not a regular file'), { code: stat.isDirectory() ? 'EISDIR' : 'EINVAL' });
  dir = fs.mkdtempSync('/tmp/pds-reader-');
  const socket = dir + '/socket';
  server = net.createServer((client) => {
    let text = '';
    client.setEncoding('utf8');
    client.on('error', () => {});
    client.on('data', (chunk) => {
      text += chunk;
      if (text.length > 4096) return client.destroy();
      if (!text.endsWith('\n')) return;
      renew();
      try {
        const req = JSON.parse(text);
        if (req.op === 'close') return client.end(JSON.stringify({ ok:true }) + '\n', stop);
        let value;
        if (req.op === 'info') {
          const s = fs.fstatSync(fd);
          value = { name: require('node:path').basename(path), path, kind:'file', size:s.size, mtimeMs:s.mtimeMs };
        } else if (req.op === 'read' && Number.isSafeInteger(req.offset) && req.offset >= 0 && Number.isSafeInteger(req.length) && req.length >= 0 && req.length <= 262144) {
          const bytes = Buffer.alloc(req.length);
          let n = 0;
          while (n < bytes.length) { const count = fs.readSync(fd, bytes, n, bytes.length - n, req.offset + n); if (!count) break; n += count; }
          value = bytes.subarray(0, n).toString('base64');
        } else throw Object.assign(new Error('Invalid reader request'), { code:'EINVAL' });
        client.end(JSON.stringify({ ok:true, value }) + '\n');
      } catch (e) { client.end(JSON.stringify(error(e)) + '\n'); }
    });
  });
  server.on('error', (e) => { console.log(JSON.stringify(error(e))); stop(); });
  server.listen(socket, () => { renew(); console.log(JSON.stringify({ ok:true, socket })); });
} catch (e) { console.log(JSON.stringify(error(e))); renew(); }
`;

const CLIENT = String.raw`
const net = require('node:net');
const { socket, request } = JSON.parse(process.argv[1]);
const client = net.createConnection(socket);
client.setTimeout(10000, () => client.destroy(new Error('Reader request timed out')));
client.on('connect', () => client.end(JSON.stringify(request) + '\n'));
client.on('data', (bytes) => process.stdout.write(bytes));
client.on('error', (e) => { console.error(e.message); process.exitCode = 1; });
`;

export async function openSandboxReader(sandbox, path, options, context) {
  let process;
  const aborted = (ctx) => ctx?.abortSignal?.aborted;
  const abort = () => fail("aborted", "File operation aborted", path);
  if (aborted(context)) return abort();
  try {
    process = await sandbox.startProcess(command(SERVER, { path, noFollow: !!options?.noFollow }));
    // A failed open can exit before waitForLog sees it. Its final log still
    // contains the typed error; a transport/start failure must not hide it.
    let waitError;
    try { await process.waitForLog("\n", 10_000); } catch (e) { waitError = e; }
    const { stdout } = await process.getLogs();
    if (!stdout.trim()) throw waitError ?? new Error("Reader did not start");
    const ready = JSON.parse(stdout.trim());
    if (!ready.ok) { await process.kill().catch(() => {}); return fail(ready.code, ready.message, path); }
    let closed = false;
    const call = async (request, ctx) => {
      if (aborted(ctx)) return abort();
      if (closed) return fail("invalid", "Reader is closed", path);
      try {
        const reply = await sandbox.exec(command(CLIENT, { socket: ready.socket, request }), { signal: ctx?.abortSignal, timeout: 15_000 });
        if (aborted(ctx)) return abort();
        if (reply.exitCode !== 0) return fail("invalid", `Reader unavailable: ${reply.stderr}`, path);
        const result = JSON.parse(reply.stdout);
        return result.ok ? ok(result.value) : fail(result.code, result.message, path);
      } catch (e) { return aborted(ctx) ? abort() : fail("unknown", String(e?.message ?? e), path); }
    };
    const close = async () => {
      if (closed) return;
      await call({ op: "close" });
      closed = true;
      await process.kill().catch(() => {});
    };
    if (aborted(context)) { await close(); return abort(); }
    const chunk = async (offset, length, ctx) => {
      const result = await call({ op: "read", offset, length }, ctx);
      return result.ok ? ok(Uint8Array.from(atob(result.value), (c) => c.charCodeAt(0))) : result;
    };
    return ok({
      info: (ctx) => call({ op: "info" }, ctx),
      async read(offset, length, ctx) {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(offset + length)) return fail("invalid", "Invalid byte range", path);
        const parts = [];
        let size = 0;
        do {
          const count = Math.min(CHUNK, length - size);
          const r = await chunk(offset + size, count, ctx);
          if (!r.ok) return r;
          parts.push(r.value);
          size += r.value.length;
          if (r.value.length < count) break;
        } while (size < length);
        const bytes = new Uint8Array(size);
        let at = 0;
        for (const part of parts) { bytes.set(part, at); at += part.length; }
        return ok(bytes);
      },
      async scanLines({ startLine, endLine }, ctx) {
        let scan;
        try { scan = new LineScanner(startLine, endLine); } catch (e) { return fail("invalid", e.message, path); }
        for (let offset = 0; ; offset += CHUNK) {
          const r = await chunk(offset, CHUNK, ctx);
          if (!r.ok) return r;
          scan.push(r.value);
          if (r.value.length < CHUNK) return ok(scan.finish());
        }
      },
      close,
    });
  } catch (e) {
    await process?.kill().catch(() => {});
    return aborted(context) ? abort() : fail("unknown", String(e?.message ?? e), path);
  }
}
