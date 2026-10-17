import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { check, critical, dependencySnapshot, lockGraph, root } from './release.mjs';

const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const graph = () => lockGraph(read('pnpm-lock.yaml'));
const worker = () => JSON.parse(read('apps/worker/package.json'));

test('generated pins, SDK/image pairing, and exact locked dependencies agree', () => {
  assert.deepEqual(Object.keys(check()), critical);
});

test('lock parser selects the workspace from multi-document pnpm 12 YAML', () => {
  assert.ok(graph().importers['apps/worker']);
  assert.throws(() => lockGraph('importers: {}'), /one workspace/);
  assert.throws(() => lockGraph('a: [invalid'), /Invalid lockfile/);
});

test('release rejects ranges, stale resolutions and missing integrity', () => {
  const pkg = worker();
  pkg.dependencies[critical[0]] = '^1.0.0';
  assert.throws(() => dependencySnapshot(pkg, graph()), /must be exact/);
  const locked = graph();
  locked.importers['apps/worker'].dependencies[critical[0]].version = '9.0.0';
  assert.throws(() => dependencySnapshot(worker(), locked), /stale lockfile version/);
  const noIntegrity = graph();
  delete noIntegrity.packages[`${critical[0]}@${worker().dependencies[critical[0]]}`].resolution.integrity;
  assert.throws(() => dependencySnapshot(worker(), noIntegrity), /missing package integrity/);
});

test('pack requires a clean version-tagged commit and produces verifiable source artifacts', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pds-release-'));
  try {
    const app = path.join(temporary, 'pi-durable-sessions');
    const files = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'install.sh', 'start.sh', 'stop.sh',
      'ops/release.mjs', 'ops/runtime.json', 'ops/compatibility.json', 'ops/pids.ts', 'apps/worker/Dockerfile'];
    for (const directory of ['apps', 'packages']) {
      for (const name of fs.readdirSync(path.join(root, directory))) {
        if (fs.existsSync(path.join(root, directory, name, 'package.json'))) files.push(`${directory}/${name}/package.json`);
      }
    }
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(app, file));
    }
    fs.writeFileSync(path.join(temporary, '.gitignore'), 'node_modules\ndist/\n');
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(app, 'node_modules'));
    const git = (...args) => execFileSync('git', args, { cwd: temporary, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init');
    git('add', '.');
    git('-c', 'user.name=Release Test', '-c', 'user.email=release@example.test', 'commit', '-m', 'fixture');
    const run = (command) => spawnSync(process.execPath, ['ops/release.mjs', command], { cwd: app, encoding: 'utf8' });
    assert.notEqual(run('pack').status, 0, 'no tag');
    const version = JSON.parse(read('package.json')).version;
    git('tag', `pi-durable-sessions/v${version}`);
    const packed = run('pack');
    assert.equal(packed.status, 0, packed.stderr);
    const out = path.join(app, 'dist/release');
    const metadata = JSON.parse(fs.readFileSync(path.join(out, 'release.json'), 'utf8'));
    assert.equal(metadata.version, version);
    assert.equal(metadata.gitCommit, git('rev-parse', 'HEAD'));
    assert.equal(metadata.dirty, false);
    assert.equal(metadata.distribution, 'source');
    assert.deepEqual(metadata.runtime, JSON.parse(read('ops/runtime.json')));
    assert.deepEqual(metadata.dependencies, dependencySnapshot(worker(), graph()));
    for (const line of fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
      const [expected, file] = line.split('  ');
      const actual = createHash('sha256').update(fs.readFileSync(path.join(out, file))).digest('hex');
      assert.equal(actual, expected);
    }
    const archive = path.join(out, `pi-durable-sessions-${version}.tar.gz`);
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    assert.ok(entries.includes('pi-durable-sessions/ops/runtime.json'));
    assert.ok(!entries.includes('node_modules'));
    fs.appendFileSync(path.join(app, 'ops/pids.ts'), '\n// dirty\n');
    assert.match(run('pack').stderr, /clean checkout/);
    git('add', '.');
    git('-c', 'user.name=Release Test', '-c', 'user.email=release@example.test', 'commit', '-m', 'new commit');
    assert.match(run('pack').stderr, /tag must point to HEAD/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('deploy propagates failures instead of printing a success message', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pds-deploy-'));
  try {
    const bin = path.join(temporary, '.local/bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\nexit 23\n', { mode: 0o755 });
    const result = spawnSync('bash', [path.join(root, 'deploy.sh')], {
      env: { ...process.env, HOME: temporary }, encoding: 'utf8',
    });
    assert.equal(result.status, 23);
    assert.ok(!result.stdout.includes('submitted'));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('development celld wrapper enforces the pin and propagates the runtime exit code', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pds-celld-'));
  try {
    const binary = path.join(temporary, 'celld');
    const version = JSON.parse(read('ops/runtime.json')).celld.version;
    const run = () => spawnSync(process.execPath, [path.join(root, 'ops/celld.mjs'), 'deploy'], {
      env: { ...process.env, PIDS_CELLD: binary }, encoding: 'utf8',
    });
    fs.writeFileSync(binary, `#!/bin/sh\nif [ "$1" = --version ]; then echo 'celld ${version}'; exit 0; fi\nexit 17\n`, { mode: 0o755 });
    assert.equal(run().status, 17);
    const deployed = path.join(temporary, 'deployed');
    fs.writeFileSync(binary, `#!/bin/sh\nif [ "$1" = --version ]; then echo 'celld 0.6.1'; exit 0; fi\ntouch '${deployed}'\n`);
    const oldRuntime = run();
    assert.equal(oldRuntime.status, 2);
    assert.ok(oldRuntime.stderr.includes(`Expected celld ${version}`));
    assert.equal(fs.existsSync(deployed), false, 'must not deploy with the baseline runtime');
    fs.writeFileSync(binary, `#!/bin/sh\necho 'celld ${version}-rc.1'\n`);
    assert.equal(run().status, 2);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
