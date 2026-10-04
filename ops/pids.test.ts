// Offline installer checks: node --test ops/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Failure, NODE_SHA, NODE_URL, PROBE_IMAGE, SANDBOX_NETWORK, SERVICE, SOURCE_DIRS, SOURCE_FILES, STORAGE, main, paths, pids }
  from './pids.ts';
import type { Args, Config, Host, Obj, RunOptions, RunResult } from './pids.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANAGER = path.join(HERE, 'pids.ts');
const ORIGINAL_PATHS = { ...paths };

let base: string;
const config: Config = { access: 'local', port: 18093, storage_port: 19000 };
const host: Host = { os: 'Linux', architecture: 'x86_64', distribution: 'arch', version: '', systemd: true };

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'pids-test-'));
  for (const key of ['ROOT', 'CONFIG', 'DATA', 'UNITS'] as const) paths[key] = path.join(base, key.toLowerCase());
  paths.LAUNCHER = path.join(base, 'bin/pids');
});

afterEach(() => {
  mock.restoreAll();
  Object.assign(paths, ORIGINAL_PATHS);
  fs.rmSync(base, { recursive: true, force: true });
});

function args(...extra: string[]): Args {
  return pids.parseCli(['setup', '--no-input', ...extra]);
}

function source(): string {
  const root = path.join(base, 'source');
  fs.mkdirSync(root, { recursive: true });
  for (const name of SOURCE_FILES) fs.writeFileSync(path.join(root, name), '{}');
  for (const name of SOURCE_DIRS) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'example.txt'), name);
  }
  return root;
}

const ok = (stdout = ''): RunResult => ({ returncode: 0, stdout, stderr: '' });

/** Replace pids.run, recording argv as strings. */
function fakeRun(impl: (argv: string[], options: RunOptions) => RunResult | void = () => ok()) {
  const calls: string[][] = [];
  const mocked = mock.method(pids, 'run', (argv: (string | number)[], options: RunOptions = {}) => {
    const strings = argv.map(String);
    calls.push(strings);
    return impl(strings, options) ?? ok();
  });
  return { calls, mocked };
}

function stub<K extends keyof typeof pids>(name: K, impl: (typeof pids)[K]) {
  return mock.method(pids, name, impl as never);
}

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

function write(file: string, text: string): void {
  pids.atomicWrite(file, text);
}

async function rejects(promise: Promise<unknown> | (() => unknown), pattern: RegExp): Promise<Failure> {
  let caught: unknown;
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Failure, `expected a Failure matching ${pattern}, got ${caught}`);
  assert.match(caught.message, pattern);
  return caught;
}

describe('host and settings', () => {
  test('supported hosts', () => {
    for (const [distribution, version] of [['arch', ''], ['omarchy', '3.0.0'], ['ubuntu', '22.04'], ['ubuntu', '24.04'], ['debian', '12']]) {
      pids.validateHost({ ...host, distribution, version });
    }
  });

  test('unsupported hosts', () => {
    for (const changes of [{ os: 'Darwin' }, { architecture: 'aarch64' }, { systemd: false }, { distribution: 'amzn' },
      { distribution: 'ubuntu', version: '20.04' }]) {
      assert.throws(() => pids.validateHost({ ...host, ...changes }), Failure, JSON.stringify(changes));
    }
  });

  test('omarchy uses pacman, not apt, and never installs Python', () => {
    const { calls } = fakeRun(() => ok(JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }])));
    stub('which', () => null);
    pids.installPackages({ ...host, distribution: 'omarchy' });
    assert.deepEqual(calls[0].slice(0, 4), ['pacman', '-S', '--needed', '--noconfirm']);
    assert.ok(calls[0].includes('docker'));
    assert.ok(!calls[0].some((name) => name.startsWith('python')));
    assert.ok(!calls.some((argv) => argv[0] === 'apt-get'));
  });

  test('settings defaults and required access', async () => {
    await rejects(pids.settings(args(), {}), /Choose --access/);
    assert.deepEqual(await pids.settings(args('--access', 'tailscale'), {}), { access: 'tailscale', port: 8093, storage_port: 19000 });
  });

  test('explicit missing config fails even with access or previous settings', async () => {
    const missing = path.join(base, 'missing.json');
    for (const previous of [{}, config]) {
      const failure = await rejects(pids.settings(args('--config', missing, '--access', 'local'), previous), /does not exist/);
      assert.equal(failure.code, 2);
      assert.ok(failure.message.includes(missing));
    }
    assert.ok(!fs.existsSync(paths.CONFIG));
  });

  test('config validation precedes mutation', async () => {
    for (const value of [{ access: 'public' }, { port: true }, { port: 22 }, { port: 65536 }, { port: 19000 }, { unknown: 'flag' },
      ['local'], { port: 8093.5 }]) {
      const file = path.join(base, 'config.json');
      fs.writeFileSync(file, JSON.stringify(value));
      await rejects(pids.settings(args('--config', file), config), /./);
    }
    assert.ok(!fs.existsSync(paths.CONFIG));
  });

  test('existing settings are preserved and not silently changed', async () => {
    assert.deepEqual(await pids.settings(args(), config), config);
    await rejects(pids.settings(args('--port', '18094'), config), /already/);
  });

  test('dry run has no side effects on an unsupported host', async () => {
    stub('hostInfo', () => ({ ...host, os: 'Darwin' }));
    const plan = await pids.setup(args('--source', source(), '--access', 'tailscale', '--dry-run'));
    assert.equal(plan.supported_host, false);
    assert.equal(plan.public_ingress_required, false);
    assert.ok(!fs.existsSync(paths.CONFIG));
    assert.ok(!fs.existsSync(paths.ROOT));
  });

  test('noninteractive approval never reads input', async () => {
    stub('prompt', async () => assert.fail('must not prompt'));
    const approval = args('--access', 'local');
    await rejects(pids.consent(approval), /Approval required/);
    await pids.consent({ ...approval, yes: true });
  });
});

describe('sources and files', () => {
  test('source hash excludes secrets, dependencies and builds', () => {
    const root = source();
    const before = pids.sourceRevision(root);
    for (const name of ['ui/node_modules/lib', 'ui/dist/app.js', 'ui/.env.local', 'ops/__pycache__/cache']) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), 'not a source file');
    }
    assert.equal(pids.sourceRevision(root), before);
    fs.writeFileSync(path.join(root, 'src/example.txt'), 'changed');
    assert.notEqual(pids.sourceRevision(root), before);
  });

  test('source symlink rejected', async () => {
    const root = source();
    fs.symlinkSync('/etc/passwd', path.join(root, 'src/link'));
    await rejects(() => pids.sourceRevision(root), /Symlinks/);
  });

  test('atomic write permissions and replace', () => {
    const file = path.join(base, 'secret');
    pids.atomicWrite(file, 'one');
    pids.atomicWrite(file, 'two');
    assert.equal(fs.readFileSync(file, 'utf8'), 'two');
    assert.equal(mode(file), 0o600);
    assert.deepEqual(fs.readdirSync(base), ['secret']);
  });

  test('credentials are random, private and stable on rerun', () => {
    fs.mkdirSync(path.join(paths.DATA, 'rustfs'), { recursive: true });
    const first = pids.credentials(config);
    assert.deepEqual(pids.credentials(config), first);
    assert.ok(first.secret_key.length >= 64);
    for (const name of ['credentials.json', 'celld.env', 'storage.env']) assert.equal(mode(path.join(paths.CONFIG, name)), 0o600);
    assert.ok(!JSON.stringify(pids.installPlan(config, host, 'revision')).includes(first.secret_key));
  });

  test('missing credentials never rotate existing storage', async () => {
    fs.mkdirSync(path.join(paths.DATA, 'rustfs'), { recursive: true });
    fs.writeFileSync(path.join(paths.DATA, 'rustfs/existing-object'), '');
    await rejects(() => pids.credentials(config), /Restore credentials/);
    assert.ok(!fs.existsSync(path.join(paths.CONFIG, 'credentials.json')));
  });

  test('install lock rejects concurrent mutations and recovers stale locks', async () => {
    await pids.withInstallLock(async () => {
      await rejects(pids.withInstallLock(() => undefined), /in progress/);
    });
    await pids.withInstallLock(() => undefined);
    assert.ok(!fs.existsSync(path.join(paths.CONFIG, 'install.lock')));
    // An empty lock (the old Python manager's flock file) or a dead owner is stale.
    for (const stale of ['', '999999999\n']) {
      fs.writeFileSync(path.join(paths.CONFIG, 'install.lock'), stale);
      assert.equal(await pids.withInstallLock(() => 'acquired'), 'acquired');
    }
  });

  test('units bind loopback and drop application privileges', () => {
    const units = pids.units(config, { uid: 123, gid: 123 });
    assert.ok(units[STORAGE].includes('127.0.0.1:19000:9000'));
    assert.ok(units[SERVICE].includes('User=pids'));
    assert.ok(units[SERVICE].includes('--listen 127.0.0.1:18093'));
    assert.ok(units[SERVICE].includes('TimeoutStopSec=90'));
    for (const unit of Object.values(units)) {
      assert.ok(unit.includes('PartOf=docker.service'));
      assert.ok(unit.includes('WantedBy=multi-user.target docker.service'));
    }
    assert.ok(!JSON.stringify(units).includes('swarmsecret'));
    assert.ok(!JSON.stringify(units).includes('--privileged'));
  });

  test('bound port detected', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      assert.equal(await pids.portAvailable(port), false);
      stub('isActive', () => false);
      await rejects(pids.preflightPorts({ ...config, port }), /occupied/);
    } finally {
      server.close();
    }
  });

  test('download checksum failure', async () => {
    const file = path.join(base, 'download');
    fs.writeFileSync(file, 'corrupted');
    fakeRun();
    await rejects(() => pids.download('https://example.test/file', file, '0'.repeat(64)), /Checksum mismatch/);
  });

  test('runtime directories are traversable under a restrictive umask', async () => {
    const previous = process.umask(0o077);
    try {
      pids.runtimeDirectories();
      for (const directory of ['', 'bin', 'manager', 'releases']) assert.equal(mode(path.join(paths.ROOT, directory)), 0o755);
      write(path.join(paths.CONFIG, 'secret'), 'private');
      await pids.withInstallLock(() => assert.equal(mode(paths.CONFIG), 0o755));
      assert.equal(mode(path.join(paths.CONFIG, 'secret')), 0o600);
    } finally {
      process.umask(previous);
    }
  });

  test('pending restarts survive identical unit files on retry', () => {
    const account = { uid: 123, gid: 123 };
    pids.installUnits(config, account, { ...config });
    const retried = pids.readJson(path.join(paths.CONFIG, 'config.json'), {}) as Obj;
    pids.installUnits(config, account, retried);
    assert.deepEqual(new Set(retried.pending_restarts), new Set([SERVICE, STORAGE]));
    pids.restartCompleted(STORAGE, retried);
    assert.deepEqual((pids.readJson(path.join(paths.CONFIG, 'config.json'), {}) as Obj).pending_restarts, [SERVICE]);
    pids.restartCompleted(SERVICE, retried);
    assert.deepEqual((pids.readJson(path.join(paths.CONFIG, 'config.json'), {}) as Obj).pending_restarts, []);
  });

  test('source copy survives a build failure', async () => {
    const root = source();
    const revision = pids.sourceRevision(root);
    write(path.join(paths.CONFIG, 'config.json'), JSON.stringify({ ...config, source: root }));
    fakeRun((argv) => {
      if (argv[0] === 'runuser') throw new Failure('simulated build failure');
    });
    await rejects(() => pids.prepareSource(root, revision, { uid: process.getuid!(), gid: process.getgid!(), home: base }),
      /build failure/);
    const retained = path.join(paths.ROOT, 'releases', revision);
    assert.equal((pids.readJson(path.join(paths.CONFIG, 'config.json'), {}) as Obj).source, retained);
    assert.ok(fs.existsSync(path.join(retained, 'src/example.txt')));
    assert.ok(!fs.existsSync(path.join(retained, '.built')));
    assert.match(fs.readFileSync(path.join(retained, 'wrangler.install.jsonc'), 'utf8'), /^\{"assets":\{"directory":"\.\/ui\/dist","binding":"ASSETS"/);
  });

  test('installed manager runs on the private Node and replaces the Python one', () => {
    fs.mkdirSync(path.join(paths.ROOT, 'manager'), { recursive: true });
    fs.writeFileSync(path.join(paths.ROOT, 'manager/pids.py'), 'old');
    pids.installManager();
    assert.equal(fs.readFileSync(path.join(paths.ROOT, 'manager/pids.ts'), 'utf8'), fs.readFileSync(MANAGER, 'utf8'));
    assert.ok(!fs.existsSync(path.join(paths.ROOT, 'manager/pids.py')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(paths.ROOT, 'manager/package.json'), 'utf8')).type, 'module');
    const launcher = fs.readFileSync(paths.LAUNCHER, 'utf8');
    assert.ok(launcher.includes(`exec ${paths.ROOT}/node/bin/node `));
    assert.ok(launcher.includes(`${paths.ROOT}/manager/pids.ts "$@"`));
    assert.equal(mode(paths.LAUNCHER), 0o755);
  });

  test('install.sh bootstraps exactly the Node the manager pins', () => {
    const script = fs.readFileSync(path.join(HERE, '../install.sh'), 'utf8');
    assert.equal(script.match(/^NODE_URL='([^']+)'$/m)?.[1], NODE_URL);
    assert.equal(script.match(/^NODE_SHA='([^']+)'$/m)?.[1], NODE_SHA);
    assert.ok(script.includes('ops/pids.ts'));
    assert.ok(!/python/i.test(script));
  });
});

describe('storage', () => {
  const keys = { access_key: 'test', secret_key: 'test' };

  function fakeFetch(statuses: number[]) {
    const methods: string[] = [];
    const mocked = mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      methods.push(init.method ?? 'GET');
      const status = statuses.shift();
      if (status === undefined) throw new Error('unexpected request');
      return new Response(null, { status });
    });
    return { methods, mocked };
  }

  test('bucket forbidden is not treated as missing', async () => {
    const { mocked } = fakeFetch([403]);
    await rejects(pids.ensureBucket(config, keys), /403/);
    assert.equal(mocked.mock.callCount(), 1);
  });

  test('bucket retries transient startup, then creates', async () => {
    const { methods } = fakeFetch([503, 404, 200]);
    stub('sleep', async () => undefined);
    await pids.ensureBucket(config, keys);
    assert.deepEqual(methods, ['HEAD', 'HEAD', 'PUT']);
  });

  test('bucket retry has a deadline', async () => {
    fakeFetch([503, 503, 503]);
    const clock = [0, 0, 121];
    stub('now', () => clock.shift() ?? 999);
    stub('sleep', async () => undefined);
    await rejects(pids.ensureBucket(config, keys), /did not become ready/);
  });

  test('S3 credentials are only in the Authorization header', () => {
    const request = pids.s3Request(config, { access_key: 'access', secret_key: 'secret' }, 'PUT', '/pid-cells');
    assert.equal(request.url, 'http://127.0.0.1:19000/pid-cells');
    assert.ok(request.headers.Authorization.includes('Credential=access/'));
    assert.ok(!JSON.stringify(request.headers).includes('secret'));
    assert.equal(request.body, '');
  });

  test('S3 signature matches the SigV4 reference computation', () => {
    // Same inputs signed by the earlier Python implementation.
    const request = pids.s3Request({ storage_port: 19000 }, { access_key: 'AKID', secret_key: 'abc123' }, 'HEAD', '/pid-cells',
      new Date('2026-10-04T01:02:03Z'));
    assert.equal(request.headers['x-amz-date'], '20261004T010203Z');
    assert.equal(request.headers.Authorization, 'AWS4-HMAC-SHA256 Credential=AKID/20261004/us-east-1/s3/aws4_request, ' +
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=8c9ea61fbdd8e4ca3edbd90984a004929e2f005a26ec19811902f933d97a413b');
  });
});

describe('tailscale', () => {
  const running = { BackendState: 'Running', Self: { DNSName: 'host.tail.ts.net.' } };
  const owned = (port = 18093): Obj => ({ TCP: { 443: { HTTPS: true } },
    Web: { 'host.tail.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } } });

  test('serve ownership requires the exact root private proxy', () => {
    const hostname = 'machine.example.ts.net';
    const current: Obj = { TCP: { 443: { HTTPS: true } }, Web: { [`${hostname}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:18093' } } } } };
    assert.ok(pids.serveOwned(current, hostname, 18093));
    assert.ok(!pids.serveOwned(current, hostname, 8093));
    assert.ok(!pids.serveOwned({ ...current, AllowFunnel: { [`${hostname}:443`]: true } }, hostname, 18093));
    current.Web[`${hostname}:443`].Handlers['/other'] = { Proxy: 'http://localhost:3000' };
    assert.ok(!pids.serveOwned(current, hostname, 18093));
  });

  test('a conflict does not mutate Serve', async () => {
    stub('which', () => '/usr/bin/tailscale');
    const { calls } = fakeRun();
    stub('tailscaleStatus', () => running);
    stub('serveConfig', () => ({ TCP: { 443: { HTTPS: true } } }));
    await rejects(() => pids.configureTailscale(config), /conflicts/);
    assert.deepEqual(calls, []);
  });

  test('a TCP forward on 443 (another app on this host) blocks setup before any change', async () => {
    stub('which', () => '/usr/bin/tailscale');
    stub('tailscaleStatus', () => running);
    stub('serveConfig', () => ({ TCP: { 443: { TCPForward: '127.0.0.1:8443' } } }));
    await rejects(() => pids.preflightExposure({ ...config, access: 'tailscale' }), /443 is already owned/);
    pids.preflightExposure(config); // Local access never claims 443.
  });

  test('serve is noninteractive after approval', () => {
    stub('which', () => '/usr/bin/tailscale');
    const { calls } = fakeRun();
    stub('tailscaleStatus', () => running);
    const states = [{}, owned()];
    stub('serveConfig', () => states.shift()!);
    assert.equal(pids.configureTailscale(config), 'https://host.tail.ts.net');
    assert.deepEqual(calls.at(-1), ['tailscale', 'serve', '--yes', '--bg', '--https=443', 'http://127.0.0.1:18093']);
  });

  test('HTTPS approval failure returns an external action', async () => {
    stub('which', () => '/usr/bin/tailscale');
    fakeRun((argv) => {
      if (argv[0] === 'tailscale') throw new Failure('approval needed');
    });
    stub('tailscaleStatus', () => running);
    stub('serveConfig', () => ({}));
    const failure = await rejects(() => pids.configureTailscale(config), /private HTTPS setup did not complete/);
    assert.equal(failure.code, 3);
    assert.ok(failure.action?.includes('HTTPS certificates'));
  });

  test('login returns an action, not a hanging prompt', async () => {
    stub('which', () => '/usr/bin/tailscale');
    fakeRun();
    stub('tailscaleStatus', () => ({ BackendState: 'NeedsLogin' }));
    const failure = await rejects(() => pids.configureTailscale(config), /needs authorization/);
    assert.equal(failure.code, 3);
    assert.ok(failure.action?.includes('tailscale up'));
  });

  test('funnel preflight blocks local and tailscale access', async () => {
    for (const access of ['local', 'tailscale'] as const) {
      stub('which', () => '/usr/bin/tailscale');
      stub('serveConfig', () => ({ AllowFunnel: { 'host.tail.ts.net:443': true } }));
      await rejects(() => pids.preflightExposure({ ...config, access }), /Funnel detected/);
      mock.restoreAll();
    }
  });

  test('exposure preflight runs before package or service changes', async () => {
    stub('hostInfo', () => host);
    stub('requireRoot', () => undefined);
    stub('preflightPorts', async () => undefined);
    stub('preflightExposure', () => {
      throw new Failure('unsafe exposure');
    });
    const packages = stub('installPackages', () => undefined);
    mock.method(process.stderr, 'write', () => true);
    await rejects(pids.setup(args('--source', source(), '--access', 'local', '--yes')), /unsafe exposure/);
    assert.equal(packages.mock.callCount(), 0);
    assert.ok(!fs.existsSync(paths.ROOT));
  });

  test('a matching serve route cannot be silently adopted', async () => {
    stub('which', () => '/usr/bin/tailscale');
    stub('tailscaleStatus', () => running);
    stub('serveConfig', () => owned());
    await rejects(() => pids.preflightExposure(config), /unowned/);
    await rejects(() => pids.configureTailscale(config), /conflicts/);
    write(path.join(paths.CONFIG, 'serve.json'), JSON.stringify({ hostname: 'host.tail.ts.net', port: 18093, state: 'pending' }));
    pids.preflightExposure(config); // Retrying an interrupted owned apply is safe.
  });

  test('DNS plan uses actual Self addresses and never applies', () => {
    stub('tailscaleStatus', () => ({ BackendState: 'Running', Self: { DNSName: 'host.tail.ts.net.',
      TailscaleIPs: ['100.64.0.10', 'fd7a:115c:a1e0::10'] } }));
    stub('hostInfo', () => host);
    const result = pids.inspect(pids.parseCli(['inspect', '--domain', 'sessions.example.com']));
    assert.deepEqual(result.dns_plan.records.map((record: Obj) => record.type), ['A', 'AAAA']);
    assert.equal(result.dns_plan.records[0].content, '100.64.0.10');
    assert.equal(result.dns_plan.applied, false);
    assert.equal(result.dns_plan.proxied, false);
  });
});

describe('uninstall', () => {
  const uninstallArgs = () => pids.parseCli(['uninstall', '--yes', '--no-input']);

  function managedInstall(access: 'local' | 'tailscale' = 'local'): void {
    write(path.join(paths.CONFIG, 'config.json'), JSON.stringify({ ...config, access }));
    write(path.join(paths.CONFIG, 'credentials.json'), 'credentials');
    write(path.join(paths.DATA, 'rustfs/object'), 'durable state');
    for (const name of [SERVICE, STORAGE]) write(path.join(paths.UNITS, `${name}.service`), 'managed');
    stub('requireRoot', () => undefined);
  }

  function assertUnitsUntouched(): void {
    for (const name of [SERVICE, STORAGE]) assert.equal(fs.readFileSync(path.join(paths.UNITS, `${name}.service`), 'utf8'), 'managed');
  }

  test('local uninstall preserves data and credentials without tailscale calls', async () => {
    managedInstall();
    const { calls } = fakeRun();
    const result = await pids.uninstall(uninstallArgs());
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(paths.DATA, 'rustfs/object'), 'utf8'), 'durable state');
    assert.equal(fs.readFileSync(path.join(paths.CONFIG, 'credentials.json'), 'utf8'), 'credentials');
    assert.ok(!fs.existsSync(path.join(paths.UNITS, `${SERVICE}.service`)));
    assert.ok(!calls.some((argv) => argv[0] === 'tailscale'));
  });

  test('a partial install tolerates confirmed-absent units', async () => {
    write(path.join(paths.CONFIG, 'config.json'), JSON.stringify({ ...config, state: 'installing' }));
    stub('requireRoot', () => undefined);
    const { calls } = fakeRun(() => ok('not-found\n'));
    assert.equal((await pids.uninstall(uninstallArgs())).ok, true);
    assert.ok(!calls.some((argv) => argv[1] === 'disable'));
  });

  test('rerun is a no-op', async () => {
    write(path.join(paths.CONFIG, 'config.json'), JSON.stringify({ ...config, state: 'uninstalled-data-preserved' }));
    stub('requireRoot', () => undefined);
    const { calls } = fakeRun();
    assert.equal((await pids.uninstall(uninstallArgs())).ok, true);
    assert.deepEqual(calls, []);
  });

  function tailscaleFixture(): Obj {
    managedInstall('tailscale');
    stub('which', () => '/usr/bin/tailscale');
    write(path.join(paths.CONFIG, 'serve.json'), JSON.stringify({ hostname: 'host.tail.ts.net', port: 18093, state: 'active' }));
    return { TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true } }, Web: {
      'host.tail.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:18093' } } },
      'host.tail.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } };
  }
  const running = { BackendState: 'Running', Self: { DNSName: 'host.tail.ts.net.' } };

  test('tailscale uninstall removes only the owned 443 route', async () => {
    const current = tailscaleFixture();
    const unrelated = structuredClone(current.Web['host.tail.ts.net:8443']);
    stub('tailscaleStatus', () => running);
    stub('serveConfig', () => current);
    const { calls } = fakeRun();
    assert.equal((await pids.uninstall(uninstallArgs())).ok, true);
    // Only the port-scoped removal is allowed, never a global Serve reset.
    assert.deepEqual(calls, [
      ['tailscale', 'serve', '--yes', '--https=443', 'off'],
      ['systemctl', 'disable', '--now', SERVICE],
      ['systemctl', 'disable', '--now', STORAGE],
      ['systemctl', 'daemon-reload'],
    ]);
    assert.deepEqual(current.Web['host.tail.ts.net:8443'], unrelated);
    assert.equal(fs.readFileSync(path.join(paths.DATA, 'rustfs/object'), 'utf8'), 'durable state');
    for (const name of [SERVICE, STORAGE]) assert.ok(!fs.existsSync(path.join(paths.UNITS, `${name}.service`)));
  });

  test('tailscale uninstall conflict leaves routes and services untouched', async () => {
    const current = tailscaleFixture();
    current.Web['host.tail.ts.net:443'].Handlers['/other'] = { Proxy: 'http://127.0.0.1:3001' };
    const before = JSON.stringify(current);
    const configBefore = fs.readFileSync(path.join(paths.CONFIG, 'config.json'), 'utf8');
    stub('tailscaleStatus', () => running);
    stub('serveConfig', () => current);
    const { calls } = fakeRun();
    const failure = await rejects(pids.uninstall(uninstallArgs()), /refusing to remove/);
    assert.equal(failure.code, 3);
    assert.deepEqual(calls, []);
    assert.equal(JSON.stringify(current), before);
    assert.equal(fs.readFileSync(path.join(paths.CONFIG, 'config.json'), 'utf8'), configBefore);
    assertUnitsUntouched();
  });

  test('tailscale uninstall with unavailable status makes no destructive calls', async () => {
    const current = tailscaleFixture();
    const configBefore = fs.readFileSync(path.join(paths.CONFIG, 'config.json'), 'utf8');
    const cases: [Obj, RunResult][] = [
      [running, { returncode: 1, stdout: '', stderr: '' }],
      [running, ok('invalid json')],
      [{ BackendState: 'Unavailable' }, ok(JSON.stringify(current))],
    ];
    for (const [state, result] of cases) {
      const status = stub('tailscaleStatus', () => state);
      const options: RunOptions[] = [];
      const { calls, mocked } = fakeRun((_argv, given) => {
        options.push(given);
        return result;
      });
      const failure = await rejects(pids.uninstall(uninstallArgs()), /./);
      assert.equal(failure.code, 3);
      assert.deepEqual(calls, [['tailscale', 'serve', 'status', '--json']]);
      assert.deepEqual(options, [{ capture: true, check: false, timeout: 15 }]);
      assert.equal(fs.readFileSync(path.join(paths.CONFIG, 'config.json'), 'utf8'), configBefore);
      assertUnitsUntouched();
      status.mock.restore();
      mocked.mock.restore();
    }
  });
});

describe('sandbox DNS', () => {
  function resolvers(daemon: Obj | null, hostServers: string[], uplink: string[]): void {
    paths.DOCKER_DAEMON_JSON = path.join(base, 'daemon.json');
    paths.RESOLV_CONF = path.join(base, 'resolv.conf');
    paths.RESOLVED_UPLINK = path.join(base, 'uplink.conf');
    fs.rmSync(paths.DOCKER_DAEMON_JSON, { force: true });
    if (daemon !== null) fs.writeFileSync(paths.DOCKER_DAEMON_JSON, JSON.stringify(daemon));
    fs.writeFileSync(paths.RESOLV_CONF, hostServers.map((server) => `nameserver ${server}\n`).join(''));
    fs.writeFileSync(paths.RESOLVED_UPLINK, uplink.map((server) => `nameserver ${server}\n`).join(''));
  }

  test('preflight rejects resolvers celld blocks', async () => {
    const cases: [Obj | null, string[], string[], boolean][] = [ // daemon.json, host resolv.conf, resolved uplinks, passes?
      [{ dns: ['172.17.0.1'] }, ['127.0.0.53'], ['68.105.28.11'], false], // Docker bridge gateway (this host).
      [{ dns: ['172.17.0.1', '1.1.1.1'] }, [], [], true],
      [null, ['127.0.0.53'], ['68.105.28.11'], true], // systemd-resolved stub with public uplinks.
      [null, ['127.0.0.53'], ['192.168.1.1'], false], // Home router behind the stub.
      [null, ['192.168.1.1'], [], false],
      [null, ['100.100.100.100'], [], false], // Tailscale MagicDNS only.
      [null, [], [], false],
      [null, ['2606:4700:4700::1111'], [], true],
      [null, ['fe80::1%enp4s0'], [], false],
    ];
    for (const [daemon, hostServers, uplink, passes] of cases) {
      resolvers(daemon, hostServers, uplink);
      if (passes) {
        pids.preflightSandboxDns();
        continue;
      }
      const failure = await rejects(() => pids.preflightSandboxDns(), /no reachable DNS resolver/);
      assert.equal(failure.code, 2);
      assert.ok(failure.action?.includes('daemon.json'));
      if (daemon) assert.ok(failure.message.includes('172.17.0.1'));
    }
  });

  test('preflight runs before package or service changes', async () => {
    stub('hostInfo', () => host);
    stub('requireRoot', () => undefined);
    stub('preflightPorts', async () => undefined);
    stub('preflightExposure', () => undefined);
    stub('preflightSandboxDns', () => {
      throw new Failure('no reachable DNS resolver', 2);
    });
    const packages = stub('installPackages', () => undefined);
    mock.method(process.stderr, 'write', () => true);
    await rejects(pids.setup(args('--source', source(), '--access', 'local', '--yes')), /no reachable DNS resolver/);
    assert.equal(packages.mock.callCount(), 0);
    assert.ok(!fs.existsSync(paths.ROOT));
  });

  test('probe only runs on the real sandbox network', () => {
    let networkCode = 1;
    let probeCode = 0;
    const { calls } = fakeRun((argv) => ({ returncode: argv[1] === 'network' ? networkCode : probeCode, stdout: '', stderr: '' }));
    assert.equal(pids.sandboxDnsProbe(), null);
    assert.equal(calls.length, 1); // No container started without the network.
    [networkCode, probeCode] = [0, 1];
    assert.equal(pids.sandboxDnsProbe(), false);
    [networkCode, probeCode] = [0, 0];
    assert.equal(pids.sandboxDnsProbe(), true);
    const probe = calls.at(-1)!;
    assert.deepEqual(probe.slice(0, 6), ['docker', 'run', '--rm', '--network', SANDBOX_NETWORK, '--label']);
    assert.ok(probe.includes(PROBE_IMAGE));
    assert.ok(probe.includes('github.com'));
  });
});

describe('command line', () => {
  test('missing input returns JSON instead of prompting', async () => {
    let stdout = '';
    const code = await main(['setup', '--no-input', '--dry-run', '--json'], (text) => {
      stdout += text;
    });
    assert.equal(code, 2);
    assert.match(JSON.parse(stdout).error, /Choose --access/);
  });

  test('parser errors use JSON without stdin, from the real entry point', () => {
    for (const argv of [['setup', '--access', 'public'], ['missing-command'], ['setup', '--port', 'not-a-number'], ['setup', '--bogus']]) {
      const result = spawnSync(process.execPath, [MANAGER, ...argv, '--json'], { input: '', encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.status, 2, `${argv.join(' ')}: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.ok(parsed.action.includes('--help'));
    }
  });

  test('help exits 0 for the root and every command', () => {
    for (const argv of [['--help'], ['setup', '--help'], ['logs', '-h']]) {
      const result = spawnSync(process.execPath, [MANAGER, ...argv], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.status, 0);
      assert.match(result.stdout, /^usage: pids/);
    }
  });
});
