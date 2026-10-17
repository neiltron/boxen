#!/usr/bin/env node
// Release tooling only. The host installer stays standalone (ADR-0001).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

export const root = path.resolve(import.meta.dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const json = (name) => JSON.parse(read(name));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
export const critical = ['@earendil-works/pi-durable', '@earendil-works/pi-ai', '@earendil-works/chord', '@cloudflare/sandbox'];

export function lockGraph(text) {
  // pnpm 12 writes a package-manager document before the workspace document.
  const documents = parseAllDocuments(text);
  for (const document of documents) assert.equal(document.errors.length, 0, 'Invalid lockfile YAML');
  const graphs = documents.map((d) => d.toJS()).filter((d) => d?.importers?.['apps/worker']);
  assert.equal(graphs.length, 1, 'Expected one workspace lockfile document');
  return graphs[0];
}

export function dependencySnapshot(pkg, graph) {
  const result = {};
  for (const name of critical) {
    const declared = pkg.dependencies[name];
    assert.match(declared, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, `${name} must be exact`);
    const locked = graph.importers['apps/worker'].dependencies[name];
    assert.equal(locked.specifier, declared, `${name}: stale lockfile specifier`);
    assert.equal(locked.version.split('(')[0], declared, `${name}: stale lockfile version`);
    const integrity = graph.packages[`${name}@${declared}`]?.resolution?.integrity;
    assert.ok(integrity, `${name}: missing package integrity`);
    result[name] = { version: declared, integrity };
  }
  return result;
}

function generatedFiles() {
  const runtime = json('ops/runtime.json');
  const pkg = json('package.json');
  assert.match(pkg.version, /^0\.\d+\.\d+(?:-rc\.\d+)?$/, 'Use a documented pre-1.0 release version');
  assert.match(pkg.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
  assert.equal(runtime.schemaVersion, 1);
  for (const name of ['node', 'celld']) {
    const pin = runtime[name];
    assert.match(pin.version, /^\d+\.\d+\.\d+$/);
    assert.match(pin.sha256, /^[a-f0-9]{64}$/);
    assert.ok(pin.url.startsWith('https://') && pin.url.includes(`/v${pin.version}/`), `${name}: URL/version mismatch`);
  }
  for (const name of ['rustfsImage', 'probeImage', 'sandboxImage']) assert.match(runtime[name], /@sha256:[a-f0-9]{64}$/);
  const constants = {
    APPLICATION_VERSION: pkg.version,
    CELLD_VERSION: runtime.celld.version, CELLD_URL: runtime.celld.url, CELLD_SHA: runtime.celld.sha256,
    NODE_VERSION: `v${runtime.node.version}`, NODE_URL: runtime.node.url, NODE_SHA: runtime.node.sha256,
    RUSTFS_IMAGE: runtime.rustfsImage, PROBE_IMAGE: runtime.probeImage,
  };
  const replaceBlock = (text, regex, replacement) => {
    assert.ok(regex.test(text), 'Missing generated block');
    return text.replace(regex, () => replacement);
  };
  const files = new Map();
  files.set('package.json', JSON.stringify({ ...pkg, engines: {
    ...pkg.engines, node: `>=${runtime.node.version} <${Number(runtime.node.version.split('.')[0]) + 1}`,
  } }, null, 2) + '\n');
  files.set('ops/pids.ts', replaceBlock(read('ops/pids.ts'), /\/\/ BEGIN GENERATED RUNTIME PINS[^]*?\/\/ END GENERATED RUNTIME PINS/,
    '// BEGIN GENERATED RUNTIME PINS (node ops/release.mjs sync)\n' +
    Object.entries(constants).map(([key, value]) => `export const ${key} = '${value}';`).join('\n') +
    '\n// END GENERATED RUNTIME PINS'));
  let installer = replaceBlock(read('install.sh'), /# BEGIN GENERATED BOOTSTRAP PINS[^]*?# END GENERATED BOOTSTRAP PINS/,
    `# BEGIN GENERATED BOOTSTRAP PINS\nNODE_URL='${runtime.node.url}'\nNODE_SHA='${runtime.node.sha256}'\nNODE_VERSION='v${runtime.node.version}'\n# END GENERATED BOOTSTRAP PINS`);
  installer = replaceBlock(installer, /ref="\$\{PIDS_REF:-[^}]+\}"/, `ref="\${PIDS_REF:-pi-durable-sessions/v${pkg.version}}"`);
  files.set('install.sh', installer);
  files.set('apps/worker/Dockerfile', replaceBlock(read('apps/worker/Dockerfile'), /^FROM .+$/m, `FROM ${runtime.sandboxImage}`));
  for (const name of ['start.sh', 'stop.sh']) {
    files.set(name, read(name).replace(/celld-\d+\.\d+\.\d+/g, `celld-${runtime.celld.version}`));
  }
  for (const directory of ['apps', 'packages']) {
    for (const name of fs.readdirSync(path.join(root, directory))) {
      const file = `${directory}/${name}/package.json`;
      if (!fs.existsSync(path.join(root, file))) continue;
      files.set(file, JSON.stringify({ ...json(file), version: pkg.version }, null, 2) + '\n');
    }
  }
  return files;
}

export function check({ sync = false } = {}) {
  for (const [name, content] of generatedFiles()) {
    if (sync) fs.writeFileSync(path.join(root, name), content);
    else assert.equal(read(name), content, `${name} is stale; run node ops/release.mjs sync`);
  }
  const runtime = json('ops/runtime.json');
  const lock = read('pnpm-lock.yaml');
  const dependencies = dependencySnapshot(json('apps/worker/package.json'), lockGraph(lock));
  const manager = parseAllDocuments(lock).map((d) => d.toJS())
    .find((d) => d?.importers?.['.']?.packageManagerDependencies)?.importers['.'].packageManagerDependencies.pnpm;
  assert.equal(`pnpm@${manager?.version}`, json('package.json').packageManager, 'Package-manager lock pin is stale');
  assert.ok(runtime.sandboxImage.includes(`:${dependencies['@cloudflare/sandbox'].version}@`), 'Sandbox SDK/image versions must match');
  return dependencies;
}

export function manifest() {
  const dependencies = check();
  const pkg = json('package.json');
  return {
    schemaVersion: 1, application: pkg.name, version: pkg.version,
    tag: `pi-durable-sessions/v${pkg.version}`, gitCommit: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain', '--untracked-files=normal').length > 0,
    lockfileSha256: sha256(read('pnpm-lock.yaml')), packageManager: pkg.packageManager,
    runtime: json('ops/runtime.json'), dependencies,
    distribution: 'source',
    // Do not imply byte-reproducible builds: apt packages are resolved at image build time.
    reproducibleContainerBuild: false,
    compatibility: json('ops/compatibility.json'),
  };
}

export function pack() {
  const metadata = manifest();
  assert.equal(metadata.dirty, false, 'Release packaging requires a clean checkout');
  assert.equal(git('rev-parse', `${metadata.tag}^{commit}`), metadata.gitCommit, 'Release tag must point to HEAD');
  const out = path.join(root, 'dist/release');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const archive = `${metadata.application}-${metadata.version}.tar.gz`;
  // Archive a commit (not a subtree object), retaining commit timestamps and
  // the pi-durable-sessions/ directory. No working-tree files enter the archive.
  execFileSync('git', ['archive', '--format=tar.gz', `--output=${path.join(out, archive)}`,
    metadata.gitCommit, 'pi-durable-sessions'], { cwd: git('rev-parse', '--show-toplevel') });
  const artifacts = { [archive]: sha256(fs.readFileSync(path.join(out, archive))), 'install.sh': sha256(read('install.sh')) };
  fs.copyFileSync(path.join(root, 'install.sh'), path.join(out, 'install.sh'));
  fs.writeFileSync(path.join(out, 'release.json'), JSON.stringify({ ...metadata, artifacts }, null, 2) + '\n');
  artifacts['release.json'] = sha256(fs.readFileSync(path.join(out, 'release.json')));
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), Object.entries(artifacts).map(([name, digest]) => `${digest}  ${name}\n`).join(''));
  console.log(out);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === 'sync') check({ sync: true });
  else if (command === 'check') check();
  else if (command === 'manifest') console.log(JSON.stringify(manifest(), null, 2));
  else if (command === 'pack') pack();
  else throw new Error('Usage: node ops/release.mjs check|sync|manifest|pack');
}
