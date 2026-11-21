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
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'boxen-release-'));
  try {
    const app = temporary;
    const files = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'install.sh', 'infra/start.sh', 'infra/stop.sh',
      'infra/release.mjs', 'infra/runtime.json', 'infra/compatibility.json', 'infra/boxenctl.ts', 'apps/worker/Dockerfile'];
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
    const run = (command) => spawnSync(process.execPath, ['infra/release.mjs', command], { cwd: app, encoding: 'utf8' });
    assert.notEqual(run('pack').status, 0, 'no tag');
    const version = JSON.parse(read('package.json')).version;
    git('tag', `v${version}`);
    const packed = run('pack');
    assert.equal(packed.status, 0, packed.stderr);
    const out = path.join(app, 'dist/release');
    const metadata = JSON.parse(fs.readFileSync(path.join(out, 'release.json'), 'utf8'));
    assert.equal(metadata.version, version);
    assert.equal(metadata.gitCommit, git('rev-parse', 'HEAD'));
    assert.equal(metadata.dirty, false);
    assert.equal(metadata.distribution, 'source');
    assert.deepEqual(metadata.runtime, JSON.parse(read('infra/runtime.json')));
    assert.deepEqual(metadata.dependencies, dependencySnapshot(worker(), graph()));
    for (const line of fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
      const [expected, file] = line.split('  ');
      const actual = createHash('sha256').update(fs.readFileSync(path.join(out, file))).digest('hex');
      assert.equal(actual, expected);
    }
    const archive = path.join(out, `boxen-${version}.tar.gz`);
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    assert.ok(entries.includes('boxen/infra/runtime.json'));
    assert.ok(!entries.includes('node_modules'));
    fs.appendFileSync(path.join(app, 'infra/boxenctl.ts'), '\n// dirty\n');
    assert.match(run('pack').stderr, /clean checkout/);
    git('add', '.');
    git('-c', 'user.name=Release Test', '-c', 'user.email=release@example.test', 'commit', '-m', 'new commit');
    assert.match(run('pack').stderr, /tag must point to HEAD/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('development celld wrapper enforces the pin and propagates the runtime exit code', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'boxen-celld-'));
  try {
    const binary = path.join(temporary, 'celld');
    const version = JSON.parse(read('infra/runtime.json')).celld.version;
    const run = () => spawnSync(process.execPath, [path.join(root, 'infra/celld.mjs'), 'deploy'], {
      env: { ...process.env, BOXEN_CELLD: binary }, encoding: 'utf8',
    });
    fs.writeFileSync(binary, `#!/bin/sh\nif [ "$1" = --version ]; then echo 'celld ${version}'; exit 0; fi\nexit 17\n`, { mode: 0o755 });
    assert.equal(run().status, 17);
    const deployed = path.join(temporary, 'deployed');
    fs.writeFileSync(binary, `#!/bin/sh\nif [ "$1" = --version ]; then echo 'celld 0.6.1'; exit 0; fi\ntouch '${deployed}'\n`);
    const oldRuntime = run();
    assert.equal(oldRuntime.status, 2);
    assert.ok(oldRuntime.stderr.includes(`Expected celld ${version}`));
    assert.equal(fs.existsSync(deployed), false, 'must not deploy with the baseline runtime');
    fs.writeFileSync(binary, `#!/bin/sh\nif [ "$1" = --version ]; then echo 'celld ${version}-rc.1'; exit 0; fi\n`);
    assert.equal(run().status, 2);
    // Run a copy of the wrapper so the checkout's .env and the caller's shell can't leak in.
    const infra = path.join(temporary, 'infra');
    fs.mkdirSync(infra);
    for (const name of ['celld.mjs', 'runtime.json']) fs.copyFileSync(path.join(root, 'infra', name), path.join(infra, name));
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AWS_|BOXEN_)/.test(k)));
    const argsFile = path.join(temporary, 'args');
    fs.writeFileSync(binary, `#!/bin/sh\nif [ "$1" = --version ]; then echo 'celld ${version}'; exit 0; fi\nprintf '%s|%s|%s\\n' "$*" "$AWS_ACCESS_KEY_ID" "$AWS_REGION" > '${argsFile}'\n`, { mode: 0o755 });
    const deploy = (env, dotenv) => {
      fs.rmSync(path.join(temporary, '.env'), { force: true });
      if (dotenv) fs.writeFileSync(path.join(temporary, '.env'), dotenv);
      assert.equal(spawnSync(process.execPath, [path.join(infra, 'celld.mjs'), 'deploy', '.'], {
        env: { ...clean, BOXEN_CELLD: binary, ...env }, encoding: 'utf8',
      }).status, 0);
      return fs.readFileSync(argsFile, 'utf8').trim();
    };
    const local = 'deploy . --bucket s3://pid-cells --endpoint http://127.0.0.1:9000|swarmadmin|us-east-1';
    assert.equal(deploy({}), local);
    assert.equal(deploy({ AWS_ACCESS_KEY_ID: 'AKIAREAL', AWS_REGION: 'eu-west-1' }), local, 'ambient AWS creds must not leave local mode');
    assert.equal(deploy({ BOXEN_S3_ENDPOINT: 'http://localhost:9000/' }), local);
    assert.equal(deploy({ AWS_ACCESS_KEY_ID: 'shell' }, 'BOXEN_S3_BUCKET=my-r2 # comment\nexport BOXEN_S3_ENDPOINT="https://acc.r2.cloudflarestorage.com"\nAWS_ACCESS_KEY_ID=file\nAWS_REGION=auto\n'),
      'deploy . --bucket s3://my-r2 --endpoint https://acc.r2.cloudflarestorage.com|shell|auto', 'shell overrides .env');
    assert.equal(deploy({ BOXEN_S3_BUCKET: 's3://aws-bucket' }), 'deploy . --bucket s3://aws-bucket||', 'external mode never injects dev credentials');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
