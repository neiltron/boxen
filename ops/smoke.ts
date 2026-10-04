#!/usr/bin/env node
/**
 * Isolated live storage + deployment + HTTP smoke. Never installs host services.
 * Requires local Docker, celld 0.6.1, pnpm install, and pnpm build.
 * Usage: node ops/smoke.ts --celld /path/to/celld-0.6.1
 * Does not start a model turn or test a sandbox PTY/systemd/Tailscale.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { BUCKET, RUSTFS_IMAGE, pids, wranglerWithAssets } from './pids.ts';

const hex = () => randomUUID().replaceAll('-', '');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function exited(child: ChildProcess, seconds: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), seconds * 1000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function smoke(binary: string): Promise<void> {
  const source = path.resolve(import.meta.dirname, '..');
  if (!fs.existsSync(path.join(source, 'apps/ui/dist/index.html')) || !fs.existsSync(path.join(source, 'apps/worker/node_modules'))) {
    throw new Error('First run pnpm install && pnpm build.');
  }
  const name = `pids-smoke-${hex().slice(0, 12)}`;
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'pids-smoke-'));
  let node: ChildProcess | null = null;
  try {
    for (const file of pids.sourceFiles(source)) {
      const target = path.join(project, path.relative(source, file));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file, target);
    }
    fs.cpSync(path.join(source, 'apps/ui/dist'), path.join(project, 'apps/worker/ui-dist'), { recursive: true });
    fs.symlinkSync(path.join(source, 'apps/worker/node_modules'), path.join(project, 'apps/worker/node_modules'));
    const wrangler = path.join(project, 'apps/worker/wrangler.jsonc');
    fs.writeFileSync(wrangler, wranglerWithAssets(fs.readFileSync(wrangler, 'utf8')));
    fs.writeFileSync(path.join(project, 'apps/worker/.dockerignore'), 'node_modules\nui-dist\n');
    const keys = { access_key: hex(), secret_key: hex() + hex() };
    const envFile = path.join(project, 'storage.env');
    pids.atomicWrite(envFile, `RUSTFS_ACCESS_KEY=${keys.access_key}\nRUSTFS_SECRET_KEY=${keys.secret_key}\nRUSTFS_CONSOLE_ENABLE=false\n`);
    pids.run(['docker', 'run', '-d', '--name', name, '--publish', '127.0.0.1::9000', '--env-file', envFile, RUSTFS_IMAGE],
      { timeout: 300 });
    const address = pids.run(['docker', 'port', name, '9000'], { capture: true }).stdout.trim().split('\n')[0];
    const settings = { storage_port: Number(address.slice(address.lastIndexOf(':') + 1)) };
    const endpoint = `http://127.0.0.1:${settings.storage_port}`;
    await pids.waitHttp(endpoint + '/health');
    await pids.ensureBucket(settings, keys);
    await pids.ensureBucket(settings, keys);
    const env: NodeJS.ProcessEnv = {
      ...process.env, AWS_ACCESS_KEY_ID: keys.access_key, AWS_SECRET_ACCESS_KEY: keys.secret_key, AWS_REGION: 'us-east-1',
      CELLD_WATCH: path.join(project, 'watch'), CELLD_ASSET_CACHE_DIR: path.join(project, 'cache'), CELLD_TTL_MS: '30000',
      CELLD_FETCH_TIMEOUT_S: '3600', PATH: `${path.join(source, 'apps/worker/node_modules/.bin')}:${process.env.PATH}`,
    };
    delete env.AWS_SESSION_TOKEN;
    pids.run([binary, 'deploy', path.join(project, 'apps/worker'), '--bucket', `s3://${BUCKET}`, '--endpoint', endpoint], { env, timeout: 1800 });
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const logFile = path.join(project, 'node.log');
    const log = fs.openSync(logFile, 'w+');
    node = spawn(binary, ['--bucket', `s3://${BUCKET}`, '--endpoint', endpoint, '--listen', `127.0.0.1:${port}`],
      { env, stdio: ['ignore', log, log] });
    try {
      await pids.waitHttp(base + '/', '<html');
      await pids.waitHttp(base + '/api/sessions', '[');
      const html = await (await fetch(base, { signal: AbortSignal.timeout(10_000) })).text();
      const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
      if (!asset) throw new Error('UI HTML does not reference a hashed JavaScript asset');
      const script = await fetch(base + asset, { signal: AbortSignal.timeout(10_000) });
      if ((await script.arrayBuffer()).byteLength <= 100_000) throw new Error('JavaScript asset is unexpectedly small');
      if (!script.headers.get('content-type')?.includes('javascript')) throw new Error('JavaScript asset has the wrong type');
      const miss = await fetch(base + '/api/not-a-route', { signal: AbortSignal.timeout(10_000) });
      if (miss.status !== 404 || ((await miss.json()) as { error?: string }).error !== 'unknown route') throw new Error('API misses must not serve the SPA');
      console.log(JSON.stringify({ ok: true, checks: ['signed bucket create/rerun', 'deploy worker + sandbox image + assets',
        'UI HTML', 'hashed JavaScript asset', 'API', 'API 404'] }));
    } catch (error) {
      process.stderr.write(fs.readFileSync(logFile, 'utf8').slice(-12_000));
      throw error;
    } finally {
      fs.closeSync(log);
    }
  } finally {
    if (node) {
      node.kill('SIGTERM');
      if (!(await exited(node, 90))) {
        node.kill('SIGKILL');
        await exited(node, 10);
      }
    }
    pids.run(['docker', 'rm', '-f', '-v', name], { check: false, capture: true, timeout: 60 });
    fs.rmSync(project, { recursive: true, force: true });
  }
}

const { values } = parseArgs({ options: { celld: { type: 'string' } } });
const binary = values.celld ?? pids.which('celld-0.6.1') ?? pids.which('celld');
if (!binary) {
  console.error('Supply --celld /path/to/celld-0.6.1');
  process.exit(2);
}
await smoke(binary);
