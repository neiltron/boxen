#!/usr/bin/env node
/**
 * pids: private Linux installer/manager for pi-durable-sessions.
 *
 * Node standard library only. It runs directly on the checksum-pinned Node the
 * app already uses, through type stripping, so there is no build step. Keep to
 * erasable TypeScript: no enums, namespaces or constructor parameter properties.
 *
 * Every cross-function call goes through the `pids` object so tests can replace
 * any step, the way the host-facing steps (run, which, tailscale) need to be.
 */
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

// Mutable so tests can point every host path at a temporary directory.
export const paths = {
  ROOT: '/opt/pi-durable-sessions',
  CONFIG: '/etc/pi-durable-sessions',
  DATA: '/var/lib/pi-durable-sessions',
  UNITS: '/etc/systemd/system',
  LAUNCHER: '/usr/local/bin/pids',
  DOCKER_DAEMON_JSON: '/etc/docker/daemon.json',
  RESOLV_CONF: '/etc/resolv.conf',
  RESOLVED_UPLINK: '/run/systemd/resolve/resolv.conf',
};
export const USER = 'pids';
export const STORAGE = 'pi-durable-sessions-storage';
export const SERVICE = 'pi-durable-sessions';
export const BUCKET = 'pid-cells';
export const CELLD_URL = 'https://github.com/denoland/celld/releases/download/v0.6.1/celld-x86_64-unknown-linux-gnu.gz';
export const CELLD_SHA = '79a8253cff5d4e8a4a9f7a2611e393390f7fe9025f00e88467875b007c44866b';
// install.sh bootstraps the same Node to run this manager; a test keeps the two pins identical.
export const NODE_VERSION = 'v24.5.0';
export const NODE_URL = 'https://nodejs.org/dist/v24.5.0/node-v24.5.0-linux-x64.tar.gz';
export const NODE_SHA = '369f2a3668dde7e324697040fafdcf442fd198b8c102317145417b3c83a9794a';
export const RUSTFS_IMAGE = 'rustfs/rustfs@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff';
export const PROBE_IMAGE = 'busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662';
export const SANDBOX_NETWORK = 'celld'; // Created by celld; its nftables policy applies to this bridge.
export const SOURCE_FILES = ['package.json', 'package-lock.json', 'Dockerfile', 'wrangler.jsonc'];
export const SOURCE_DIRS = ['src', 'ui', 'ops'];
const SKIP = new Set(['node_modules', 'dist', '.git', '__pycache__', '.env', '.DS_Store']);
export const WARNINGS = [
  'No app accounts yet: every permitted tailnet client has full access. Restrict tailnet grants.',
  'Sandbox workspaces are ephemeral. Restarting celld can lose unpushed work.',
  'Remote previews still use localhost:8093. Use an SSH forward; custom-domain routing is deferred.',
  'Provider OAuth requires pasting the redirect URL; the Vite callback listeners are not installed.',
  'Local RustFS is not an off-machine backup. Back up the persistent data separately.',
];

function blockList(networks: string[]): net.BlockList {
  const list = new net.BlockList();
  for (const network of networks) {
    const [address, prefix] = network.split('/');
    list.addSubnet(address, Number(prefix), address.includes(':') ? 'ipv6' : 'ipv4');
  }
  return list;
}
// celld rejects sandbox traffic to these ranges, so a resolver here is unreachable from every session.
const SANDBOX_BLOCKED = blockList(['127.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16', '172.16.0.0/12',
  '192.168.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10']);
const LOOPBACK = blockList(['127.0.0.0/8', '::1/128']);

// Parsed JSON from files and external tools.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Obj = Record<string, any>;
export type Access = 'local' | 'tailscale';
export type Config = { access: Access; port: number; storage_port: number };
export type Host = { os: string; architecture: string; distribution: string; version: string; systemd: boolean;
  docker?: boolean; tailscale?: boolean };
export type Account = { uid: number; gid: number; home: string };
export type Keys = { access_key: string; secret_key: string };
export type RunResult = { returncode: number; stdout: string; stderr: string };
export type RunOptions = { capture?: boolean; check?: boolean; env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number };
export type Args = {
  command: string; json: boolean; help: boolean; domain?: string; source?: string; config?: string; access?: string;
  port?: number; storagePort?: number; dryRun: boolean; yes: boolean; noInput: boolean; lines: number;
};

export class Failure extends Error {
  code: number;
  action: string | null;

  constructor(message: string, code = 1, action: string | null = null) {
    super(message);
    this.code = code;
    this.action = action;
  }
}

const RECOVERY: Record<string, string> = {
  'docker\0info': 'Run sudo docker info and sudo systemctl status docker. Check daemon startup and /var/run/docker.sock permissions.',
  'docker\0context\0inspect': 'Run sudo docker context inspect. Select the local system Docker engine, not a remote context.',
};

/** Child diagnostics never contaminate the CLI's JSON stdout. Timeout is in seconds. */
function run(args: (string | number)[], { capture = false, check = true, env, cwd, timeout = 600 }: RunOptions = {}): RunResult {
  const argv = args.map(String);
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd, env, encoding: 'utf8', timeout: timeout * 1000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', capture ? 'pipe' : 2, capture ? 'pipe' : 2],
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Failure(`Command not installed: ${argv[0]}`, 1, 'Run setup with --yes to install prerequisites.');
    }
    if (code === 'ETIMEDOUT') {
      throw new Failure(`Timed out running ${argv[0]}`, 1, 'Inspect pids logs, then retry. Data has been preserved.');
    }
    throw result.error;
  }
  const returncode = result.status ?? 1;
  if (check && returncode) {
    // Do not echo arbitrary command output: external tools may print credentials.
    const action = RECOVERY[argv.join('\0')] ?? 'Check diagnostics on stderr, or run pids logs. Fix the cause and retry.';
    throw new Failure(`${argv[0]} failed (exit ${returncode})`, 1, action);
  }
  return { returncode, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function which(command: string): string | null {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here; keep searching PATH.
    }
  }
  return null;
}

function output(value: Obj, asJson: boolean, write: (text: string) => void): void {
  if (asJson) {
    write(JSON.stringify(value, null, 2) + '\n');
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    write(`${key}: ${item !== null && typeof item === 'object' ? JSON.stringify(item) : item}\n`);
  }
}

function readJson<T>(file: string, fallback: T): Obj | T {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Failure(`Cannot read JSON at ${file}: ${(error as Error).message}`);
  }
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'object' && Object.keys(value).length === 0);
}

function atomicWrite(file: string, text: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}`);
  let fd = fs.openSync(temporary, 'wx', mode);
  try {
    fs.fchmodSync(fd, mode); // The open mode is filtered by umask; this is not.
    fs.writeFileSync(fd, text);
    fs.closeSync(fd);
    fd = -1;
    fs.renameSync(temporary, file);
  } finally {
    if (fd >= 0) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

function osRelease(file = '/etc/os-release'): Record<string, string> {
  const values: Record<string, string> = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const separator = line.indexOf('=');
    if (separator >= 0) values[line.slice(0, separator)] = line.slice(separator + 1).replace(/^["']+|["']+$/g, '');
  }
  return values;
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function hostInfo(): Host {
  const release = osRelease();
  return {
    os: os.type(), architecture: os.machine(), distribution: release.ID ?? '', version: release.VERSION_ID ?? '',
    systemd: isDirectory('/run/systemd/system'), docker: pids.which('docker') !== null,
    tailscale: pids.which('tailscale') !== null,
  };
}

function validateHost(host: Host): void {
  if (host.os !== 'Linux' || !['x86_64', 'amd64'].includes(host.architecture)) {
    throw new Failure('This test installer supports Linux x86-64 only (not macOS or Graviton/ARM).', 2);
  }
  const distro = host.distribution;
  const major = /^\d+/.test(host.version) ? parseInt(host.version, 10) : 0;
  if (!(['arch', 'omarchy'].includes(distro) || (distro === 'ubuntu' && major >= 22) || (distro === 'debian' && major >= 12))) {
    throw new Failure('Supported distributions: Omarchy/Arch, Ubuntu 22.04+, Debian 12+.', 2);
  }
  if (!host.systemd) throw new Failure('A running systemd host is required (not a regular Docker container).', 2);
}

async function prompt(question: string): Promise<string> {
  // Prompts go to stderr so stdout stays a single JSON document.
  const reader = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await reader.question(question);
  } finally {
    reader.close();
  }
}

const SETTING_KEYS = ['access', 'port', 'storage_port'] as const;

async function settings(args: Args, previous: Obj): Promise<Config> {
  if (args.config && !fs.existsSync(args.config)) throw new Failure(`Config file does not exist: ${args.config}`, 2);
  const incoming = args.config ? pids.readJson(args.config, {}) : {};
  if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming) ||
      Object.keys(incoming).some((key) => !(SETTING_KEYS as readonly string[]).includes(key))) {
    throw new Failure('Config accepts only access, port, storage_port.', 2);
  }
  const values: Obj = {};
  for (const key of SETTING_KEYS) if (key in previous) values[key] = previous[key];
  Object.assign(values, incoming);
  const fromArgs: Obj = { access: args.access, port: args.port, storage_port: args.storagePort };
  for (const key of SETTING_KEYS) if (fromArgs[key] !== undefined) values[key] = fromArgs[key];
  values.port ??= 8093;
  values.storage_port ??= 19000;
  if (!('access' in values)) {
    if (args.noInput || !process.stdin.isTTY) {
      throw new Failure('Choose --access local or --access tailscale for the first installation.', 2);
    }
    values.access = (await pids.prompt('Access [tailscale/local] (tailscale): ')).trim() || 'tailscale';
  }
  if (!['local', 'tailscale'].includes(values.access)) {
    throw new Failure('access must be local or tailscale. Public access is not supported before auth.', 2);
  }
  for (const key of ['port', 'storage_port']) {
    if (typeof values[key] !== 'number' || !Number.isInteger(values[key]) || values[key] < 1024 || values[key] > 65535) {
      throw new Failure(`${key} must be an integer between 1024 and 65535.`, 2);
    }
  }
  if (values.port === values.storage_port) throw new Failure('Application and storage ports must differ.', 2);
  for (const key of SETTING_KEYS) {
    if (key in previous && values[key] !== previous[key]) {
      throw new Failure(`${key} is already ${JSON.stringify(previous[key])}; this test installer does not change it in place.`, 2);
    }
  }
  return { access: values.access, port: values.port, storage_port: values.storage_port };
}

function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

function skipped(name: string): boolean {
  return SKIP.has(name) || name.startsWith('.env');
}

/** Top-down walk: each directory's files (sorted), then its subdirectories (sorted). */
function* walk(directory: string): Generator<string> {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const isDir = (entry: fs.Dirent) => entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(path.join(directory, entry.name)));
  const dirs = entries.filter((entry) => isDir(entry) && !skipped(entry.name));
  const files = entries.filter((entry) => !isDir(entry));
  for (const entry of [...dirs, ...files]) {
    if (entry.isSymbolicLink()) {
      throw new Failure(`Symlinks are not accepted in installation sources: ${path.join(directory, entry.name)}`, 2);
    }
  }
  for (const name of files.map((entry) => entry.name).filter((name) => !skipped(name)).sort()) {
    yield path.join(directory, name);
  }
  for (const name of dirs.map((entry) => entry.name).sort()) yield* walk(path.join(directory, name));
}

function* sourceFiles(source: string): Generator<string> {
  for (const name of SOURCE_FILES) {
    const file = path.join(source, name);
    if (!lstatOrNull(file)?.isFile()) throw new Failure(`Not an application checkout: missing regular file ${file}`, 2);
    yield file;
  }
  for (const name of SOURCE_DIRS) {
    const base = path.join(source, name);
    if (!lstatOrNull(base)?.isDirectory()) throw new Failure(`Missing source directory ${base}`, 2);
    yield* walk(base);
  }
}

function sourceRevision(source: string): string {
  const digest = createHash('sha256');
  for (const file of pids.sourceFiles(source)) {
    digest.update(path.relative(source, file) + '\0');
    digest.update(fs.readFileSync(file));
  }
  return digest.digest('hex').slice(0, 20);
}

function installPlan(config: Config, host: Host, revision: string): Obj {
  return {
    host, config, source_revision: revision,
    paths: { application: paths.ROOT, config: paths.CONFIG, data: paths.DATA },
    steps: [
      'Check that sandboxes will get a DNS resolver celld lets them reach',
      'Install/reuse distro Docker and required tools',
      `Install checksum-pinned celld 0.6.1 and Node ${NODE_VERSION.slice(1)}`,
      'Create dedicated pids service account and private random storage credentials',
      'Build UI and worker from lockfiles as the service account',
      'Start digest-pinned RustFS on loopback; create private bucket',
      'Deploy worker, sandbox image and static assets',
      'Enable systemd services; wait for UI and API health',
      ...(config.access === 'tailscale' ? ['Install/reuse Tailscale; require authorization; configure private Serve HTTPS'] : []),
    ],
    warnings: WARNINGS, public_ingress_required: false,
  };
}

function requireRoot(): void {
  if (process.geteuid?.() !== 0) {
    throw new Failure('This operation needs root.', 2, 'Rerun with sudo; inspect and setup --dry-run need no root.');
  }
}

async function consent(args: Args): Promise<void> {
  if (args.yes) return;
  if (args.noInput || !process.stdin.isTTY) throw new Failure('Approval required: pass --yes to allow the displayed host changes.', 2);
  if ((await pids.prompt('Apply these changes? [y/N] ')).trim().toLowerCase() !== 'y') {
    throw new Failure('Cancelled; no changes made.', 2);
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Serializes mutating operations. Node has no flock, so the lock file holds the
 * owner's PID; a lock whose owner has exited (or an empty one left by the old
 * Python manager) is stale and replaced.
 */
async function withInstallLock<T>(body: () => Promise<T> | T): Promise<T> {
  fs.mkdirSync(paths.CONFIG, { recursive: true });
  fs.chmodSync(paths.CONFIG, 0o755); // Public settings are readable; credential files remain 0600.
  const lock = path.join(paths.CONFIG, 'install.lock');
  const token = `${process.pid}\n`;
  const busy = () => new Failure('Another pids operation is in progress. Retry when it finishes.', 3);
  try {
    fs.writeFileSync(lock, token, { flag: 'wx', mode: 0o644 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (processAlive(parseInt(fs.readFileSync(lock, 'utf8'), 10))) throw busy();
    atomicWrite(lock, token, 0o644);
    if (fs.readFileSync(lock, 'utf8') !== token) throw busy(); // Lost a race to replace the stale lock.
  }
  try {
    return await body();
  } finally {
    try {
      if (fs.readFileSync(lock, 'utf8') === token) fs.rmSync(lock);
    } catch {
      // Already gone.
    }
  }
}

function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)));
  });
}

function isActive(service: string): boolean {
  return pids.which('systemctl') !== null &&
    pids.run(['systemctl', 'is-active', '--quiet', service], { capture: true, check: false, timeout: 15 }).returncode === 0;
}

async function preflightPorts(config: Config): Promise<void> {
  for (const [key, service] of [['port', SERVICE], ['storage_port', STORAGE]] as const) {
    if (!(await pids.portAvailable(config[key])) && !pids.isActive(service)) {
      throw new Failure(`127.0.0.1:${config[key]} is already occupied by another service.`, 2,
        `Choose --${key.replace('_', '-')} on the first installation, or resolve the conflict.`);
    }
  }
}

function resolvNameservers(file: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length > 1 && parts[0] === 'nameserver').map((parts) => parts[1]);
}

function ipFamily(address: string): 'ipv4' | 'ipv6' | null {
  const family = net.isIP(address.split('%')[0]);
  return family === 4 ? 'ipv4' : family === 6 ? 'ipv6' : null;
}

function sandboxBlocked(address: string): boolean {
  const family = ipFamily(address);
  return family === null || SANDBOX_BLOCKED.check(address.split('%')[0], family);
}

function isLoopback(address: string): boolean {
  const family = ipFamily(address);
  return family !== null && LOOPBACK.check(address.split('%')[0], family);
}

/**
 * Resolvers Docker hands to containers: daemon.json "dns", else the host's, and
 * for a loopback-only stub (systemd-resolved) the uplink servers behind it.
 */
function containerResolvers(): [string[], string] {
  const configured = (pids.readJson(paths.DOCKER_DAEMON_JSON, {}) as Obj).dns;
  if (Array.isArray(configured) && configured.length) {
    return [configured.map(String), `"dns" in ${paths.DOCKER_DAEMON_JSON}`];
  }
  const servers = resolvNameservers(paths.RESOLV_CONF);
  if (servers.length && servers.every(isLoopback)) {
    return [resolvNameservers(paths.RESOLVED_UPLINK), `the uplink resolvers in ${paths.RESOLVED_UPLINK}`];
  }
  return [servers, `the resolvers in ${paths.RESOLV_CONF}`];
}

/** Sessions clone repositories inside sandboxes; those need a resolver celld lets them reach. */
function preflightSandboxDns(): void {
  const [servers, source] = containerResolvers();
  if (servers.some((server) => !sandboxBlocked(server))) return;
  throw new Failure(`Sandboxes would have no reachable DNS resolver: ${source} lists ` +
    `${servers.length ? JSON.stringify(servers) : 'nothing'}, and celld blocks sandbox traffic to loopback, private and ` +
    'tailnet addresses. Sessions could not clone repositories or install packages. No changes made.', 2,
  `Give Docker a public resolver: set "dns": ["1.1.1.1", "8.8.8.8"] in ${paths.DOCKER_DAEMON_JSON} ` +
    '(or remove a "dns" entry that points at this host when its upstream resolvers are already public), ' +
    'then run sudo systemctl restart docker and rerun setup.');
}

/** Ground truth on the real sandbox network: null when celld has not created it yet. */
function sandboxDnsProbe(): boolean | null {
  const exists = pids.run(['docker', 'network', 'inspect', SANDBOX_NETWORK], { capture: true, check: false, timeout: 30 });
  if (exists.returncode) return null;
  const probe = pids.run(['docker', 'run', '--rm', '--network', SANDBOX_NETWORK, '--label', 'io.pids.managed=probe',
    PROBE_IMAGE, 'nslookup', '-timeout=5', 'github.com'], { capture: true, check: false, timeout: 180 });
  return probe.returncode === 0;
}

function installPackages(host: Host): void {
  // Reuse an existing engine; do not replace Docker CE or change its daemon configuration.
  if (['arch', 'omarchy'].includes(host.distribution)) {
    const packages = ['curl', 'ca-certificates', 'git', 'tar', 'gzip'];
    if (!pids.which('docker')) packages.push('docker', 'docker-buildx');
    pids.run(['pacman', '-S', '--needed', '--noconfirm', ...packages], { timeout: 1800 });
  } else {
    pids.run(['apt-get', 'update'], { timeout: 600 });
    const packages = ['curl', 'ca-certificates', 'git', 'tar', 'gzip'];
    if (!pids.which('docker')) packages.push('docker.io');
    pids.run(['apt-get', 'install', '-y', ...packages], { timeout: 1800, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
  }
  pids.run(['systemctl', 'enable', '--now', 'docker'], { timeout: 120 });
  pids.run(['docker', 'info'], { capture: true, timeout: 30 });
  // celld requires the host's Unix-socket engine, not an arbitrary Docker context.
  const context = pids.run(['docker', 'context', 'inspect'], { capture: true, timeout: 15 });
  if (JSON.parse(context.stdout)[0]?.Endpoints?.docker?.Host !== 'unix:///var/run/docker.sock') {
    throw new Failure('Use the local system Docker engine at /var/run/docker.sock, not a remote/rootless context.', 2);
  }
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function download(url: string, destination: string, checksum: string): void {
  pids.run(['curl', '--proto', '=https', '--tlsv1.2', '-fsSL', '--retry', '3', '--max-time', '300', url, '-o', destination],
    { timeout: 330 });
  if (sha256File(destination) !== checksum) throw new Failure(`Checksum mismatch for ${url}; refusing to install.`, 1);
}

function runtimeDirectories(): void {
  // mkdir's mode is still filtered by umask. Explicit chmod also repairs an
  // interrupted install performed under root's common restrictive umask.
  for (const directory of ['', 'bin', 'manager', 'releases']) {
    const full = path.join(paths.ROOT, directory);
    fs.mkdirSync(full, { recursive: true });
    fs.chmodSync(full, 0o755);
  }
}

function withTemporaryDirectory<T>(parent: string, body: (directory: string) => T): T {
  const directory = fs.mkdtempSync(path.join(parent, '.tmp-'));
  try {
    return body(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function toolchain(): void {
  pids.runtimeDirectories();
  const celld = path.join(paths.ROOT, 'bin/celld');
  if (!fs.existsSync(celld)) {
    withTemporaryDirectory(paths.ROOT, (temporary) => {
      const archive = path.join(temporary, 'celld.gz');
      pids.download(CELLD_URL, archive, CELLD_SHA);
      const binary = path.join(temporary, 'celld');
      fs.writeFileSync(binary, gunzipSync(fs.readFileSync(archive)), { mode: 0o755 });
      fs.chmodSync(binary, 0o755);
      fs.renameSync(binary, celld);
    });
  }
  const node = path.join(paths.ROOT, 'node');
  if (!fs.existsSync(path.join(node, 'bin/node'))) {
    withTemporaryDirectory(paths.ROOT, (temporary) => {
      const archive = path.join(temporary, 'node.tar.gz');
      pids.download(NODE_URL, archive, NODE_SHA);
      const stage = path.join(temporary, 'node');
      fs.mkdirSync(stage);
      pids.run(['tar', '-xzf', archive, '--no-same-owner', '--strip-components=1', '-C', stage]);
      fs.chmodSync(stage, 0o755);
      fs.rmSync(node, { recursive: true, force: true }); // A partial earlier extract without bin/node.
      fs.renameSync(stage, node);
    });
  }
  fs.chmodSync(node, 0o755);
}

function lookupUser(name: string): Account | null {
  const result = pids.run(['getent', 'passwd', name], { capture: true, check: false, timeout: 15 });
  if (result.returncode === 2) return null; // getent: key not found.
  if (result.returncode) throw new Failure(`Cannot look up user ${name} (getent exit ${result.returncode}).`);
  const fields = result.stdout.trim().split(':');
  return { uid: Number(fields[2]), gid: Number(fields[3]), home: fields[5] };
}

function serviceAccount(): Account {
  let account = lookupUser(USER);
  if (account && (account.home !== paths.DATA || account.uid === 0)) {
    throw new Failure('An unrelated pids user already exists; refusing to reuse it.', 2);
  }
  if (!account) {
    pids.run(['useradd', '--system', '--user-group', '--home-dir', paths.DATA, '--shell', '/usr/sbin/nologin', USER]);
    account = lookupUser(USER);
    if (!account) throw new Failure('Created the pids user but cannot look it up.');
  }
  pids.run(['usermod', '-aG', 'docker', USER]);
  for (const directory of ['', 'rustfs', 'rustfs-logs', 'cache', 'watch']) {
    const full = path.join(paths.DATA, directory);
    fs.mkdirSync(full, { recursive: true });
    fs.chownSync(full, account.uid, account.gid);
    fs.chmodSync(full, 0o700);
  }
  return account;
}

function credentials(_config: Config): Keys {
  const file = path.join(paths.CONFIG, 'credentials.json');
  let stored = pids.readJson(file, null) as Obj | null;
  if (stored === null) {
    if (fs.readdirSync(path.join(paths.DATA, 'rustfs')).length) {
      throw new Failure('Storage contains data but credentials.json is missing. Restore credentials; do not rotate blindly.');
    }
    stored = { access_key: randomBytes(12).toString('hex'), secret_key: randomBytes(32).toString('hex') };
    atomicWrite(file, JSON.stringify(stored));
  }
  const keys = Object.keys(stored).sort();
  if (keys.join() !== 'access_key,secret_key' ||
      Object.values(stored).some((value) => typeof value !== 'string' || !/^[0-9a-f]+$/.test(value))) {
    throw new Failure('Invalid storage credentials file. Restore the original generated credentials.');
  }
  const { access_key: access, secret_key: secret } = stored as Keys;
  atomicWrite(path.join(paths.CONFIG, 'storage.env'),
    `RUSTFS_ACCESS_KEY=${access}\nRUSTFS_SECRET_KEY=${secret}\n` +
    'RUSTFS_VOLUMES=/data\nRUSTFS_CONSOLE_ENABLE=false\nRUSTFS_OBS_LOG_DIRECTORY=/logs\n');
  atomicWrite(path.join(paths.CONFIG, 'celld.env'),
    `AWS_ACCESS_KEY_ID=${access}\nAWS_SECRET_ACCESS_KEY=${secret}\n` +
    'AWS_REGION=us-east-1\nCELLD_TTL_MS=30000\nCELLD_FETCH_TIMEOUT_S=3600\n' +
    `CELLD_WATCH=${paths.DATA}/watch\nCELLD_ASSET_CACHE_DIR=${paths.DATA}/cache\n` +
    'DOCKER_HOST=unix:///var/run/docker.sock\nCELLD_CONTAINER_PLATFORM=linux/amd64\n');
  return { access_key: access, secret_key: secret };
}

function units(config: Config, account: Pick<Account, 'uid' | 'gid'>): Record<string, string> {
  const { ROOT, CONFIG, DATA } = paths;
  const storage = `[Unit]
Description=pi-durable-sessions private object storage
Requires=docker.service
PartOf=docker.service
After=docker.service network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
ExecStart=/usr/bin/docker run --rm --name ${STORAGE} --label io.pids.managed=storage --user ${account.uid}:${account.gid} --security-opt no-new-privileges --cap-drop ALL --publish 127.0.0.1:${config.storage_port}:9000 --env-file ${CONFIG}/storage.env --volume ${DATA}/rustfs:/data --volume ${DATA}/rustfs-logs:/logs ${RUSTFS_IMAGE}
ExecStop=/usr/bin/docker stop --time 30 ${STORAGE}
Restart=always
RestartSec=5
TimeoutStartSec=120
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target docker.service
`;
  const node = `[Unit]
Description=pi-durable-sessions application
Requires=docker.service
PartOf=docker.service
Wants=${STORAGE}.service network-online.target
After=docker.service ${STORAGE}.service network-online.target
StartLimitIntervalSec=0

[Service]
User=${USER}
Group=${USER}
SupplementaryGroups=docker
WorkingDirectory=${DATA}
EnvironmentFile=${CONFIG}/celld.env
Environment=PATH=${ROOT}/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=${ROOT}/bin/celld --bucket s3://${BUCKET} --endpoint http://127.0.0.1:${config.storage_port} --listen 127.0.0.1:${config.port}
Restart=always
RestartSec=3
TimeoutStopSec=90
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target docker.service
`;
  return { [STORAGE]: storage, [SERVICE]: node };
}

function saveConfig(saved: Obj): void {
  atomicWrite(path.join(paths.CONFIG, 'config.json'), JSON.stringify(saved, null, 2), 0o644);
}

function installUnits(config: Config, account: Pick<Account, 'uid' | 'gid'>, saved: Obj): void {
  for (const [name, content] of Object.entries(pids.units(config, account))) {
    const file = path.join(paths.UNITS, `${name}.service`);
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) {
      saved.pending_restarts = [...new Set([...(saved.pending_restarts ?? []), name])].sort();
      // Intent precedes replacement: retry must restart even if the unit
      // file already matches after a failed image pull or deployment.
      saveConfig(saved);
      atomicWrite(file, content, 0o644);
    }
  }
}

function restartCompleted(service: string, saved: Obj): void {
  saved.pending_restarts = (saved.pending_restarts ?? []).filter((name: string) => name !== service);
  saveConfig(saved);
}

function prepareSource(source: string, revision: string, account: Account): string {
  pids.runtimeDirectories();
  const release = path.join(paths.ROOT, 'releases', revision);
  if (!fs.existsSync(path.join(release, '.built'))) {
    fs.mkdirSync(release, { recursive: true });
    for (const file of pids.sourceFiles(source)) {
      const target = path.join(release, path.relative(source, file));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (path.resolve(file) !== path.resolve(target)) fs.copyFileSync(file, target);
    }
    const assets = { assets: { directory: './ui/dist', binding: 'ASSETS', run_worker_first: true,
      not_found_handling: 'single-page-application' } };
    const wrangler = fs.readFileSync(path.join(release, 'wrangler.jsonc'), 'utf8')
      .replace('{', () => '{' + JSON.stringify(assets).slice(1, -1) + ',');
    atomicWrite(path.join(release, 'wrangler.install.jsonc'), wrangler, 0o644);
    atomicWrite(path.join(release, '.dockerignore'), 'node_modules\nui\n.git\ndocs\n.env*\n', 0o644);
    pids.run(['chown', '-R', `${account.uid}:${account.gid}`, release]);
    // Persist the retained source BEFORE npm: curl's temporary checkout is
    // removed even when a build fails. A retry must not depend on it.
    saveConfig({ ...(pids.readJson(path.join(paths.CONFIG, 'config.json'), {}) as Obj), source: release });
    const environment = { PATH: `${paths.ROOT}/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: paths.DATA, LANG: 'C.UTF-8', npm_config_cache: `${paths.DATA}/npm-cache` };
    for (const command of [['npm', 'ci'], ['npm', '--prefix', 'ui', 'ci'], ['npm', '--prefix', 'ui', 'run', 'build']]) {
      pids.run(['runuser', '-u', USER, '--', ...command], { env: environment, cwd: release, timeout: 1800 });
    }
    atomicWrite(path.join(release, '.built'), 'ok\n', 0o644);
  }
  return release;
}

export type S3Request = { url: string; method: string; headers: Record<string, string>; body?: string };

/** Minimal SigV4 for bucket HEAD/PUT only; credentials never go to argv. */
function s3Request(config: Pick<Config, 'storage_port'>, keys: Keys, method: string, urlPath: string, now = new Date()): S3Request {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = stamp.slice(0, 8);
  const host = `127.0.0.1:${config.storage_port}`;
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const payload = sha('');
  const headers = `host:${host}\nx-amz-content-sha256:${payload}\nx-amz-date:${stamp}\n`;
  const signed = 'host;x-amz-content-sha256;x-amz-date';
  const canonical = `${method}\n${urlPath}\n\n${headers}\n${signed}\n${payload}`;
  const scope = `${day}/us-east-1/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${sha(canonical)}`;
  let key: Buffer = Buffer.from('AWS4' + keys.secret_key);
  for (const value of [day, 'us-east-1', 's3', 'aws4_request']) key = createHmac('sha256', key).update(value).digest();
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return {
    url: `http://${host}${urlPath}`, method, body: method === 'PUT' ? '' : undefined,
    headers: { 'x-amz-date': stamp, 'x-amz-content-sha256': payload,
      Authorization: `AWS4-HMAC-SHA256 Credential=${keys.access_key}/${scope}, SignedHeaders=${signed}, Signature=${signature}` },
  };
}

async function s3Status(config: Pick<Config, 'storage_port'>, keys: Keys, method: string, urlPath: string): Promise<number> {
  const request = pids.s3Request(config, keys, method, urlPath);
  const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body,
    signal: AbortSignal.timeout(10_000) });
  await response.body?.cancel();
  return response.status;
}

const TRANSIENT = new Set([409, 429, 500, 502, 503, 504]);

async function ensureBucket(config: Pick<Config, 'storage_port'>, keys: Keys, seconds = 120): Promise<void> {
  // RustFS /health can return 200 before its S3 layer accepts requests.
  // Retry transient startup failures, but never disguise invalid credentials
  // as a missing bucket. Rechecking HEAD also resolves an ambiguous PUT.
  const deadline = pids.now() + seconds;
  while (pids.now() < deadline) {
    try {
      let status = await s3Status(config, keys, 'HEAD', `/${BUCKET}`);
      if (status < 400) return;
      if (status === 404) {
        status = await s3Status(config, keys, 'PUT', `/${BUCKET}`);
        if (status < 400) return;
      }
      if (!TRANSIENT.has(status)) throw new Failure(`Bucket check/create returned HTTP ${status}; not replacing storage.`);
    } catch (error) {
      if (error instanceof Failure) throw error;
      // Connection refused/reset or timeout while RustFS starts: retry.
    }
    await pids.sleep(2);
  }
  throw new Failure('S3 did not become ready in time.', 1, 'Run sudo pids logs, then retry setup; existing storage was not replaced.');
}

async function httpOk(url: string, expected?: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (response.status !== 200) {
      await response.body?.cancel();
      return false;
    }
    const body = Buffer.from(await response.arrayBuffer()).subarray(0, 2 * 1024 * 1024).toString('utf8');
    return expected === undefined || body.includes(expected);
  } catch {
    return false;
  }
}

async function waitHttp(url: string, expected?: string, seconds = 120): Promise<void> {
  const deadline = pids.now() + seconds;
  while (pids.now() < deadline) {
    if (await pids.httpOk(url, expected)) return;
    await pids.sleep(2);
  }
  throw new Failure(`Health check timed out: ${url}`, 1, 'Run sudo pids logs and sudo pids doctor --json, then retry setup.');
}

function tailscaleStatus(): Obj {
  if (!pids.which('tailscale')) return { BackendState: 'NotInstalled' };
  const result = pids.run(['tailscale', 'status', '--json'], { capture: true, check: false, timeout: 15 });
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { BackendState: 'Unavailable' };
  }
}

function serveConfig(): Obj {
  const result = pids.run(['tailscale', 'serve', 'status', '--json'], { capture: true, check: false, timeout: 15 });
  if (result.returncode) throw new Failure('Cannot inspect Tailscale Serve; refusing to change it.', 3, 'Run sudo tailscale serve status.');
  try {
    return JSON.parse(result.stdout || '{}');
  } catch {
    throw new Failure('Unrecognized Tailscale Serve status; no configuration changed.', 3);
  }
}

function selfHostname(status: Obj): string {
  return String(status.Self?.DNSName ?? '').replace(/\.$/, '');
}

function funnelEnabled(current: Obj): boolean {
  return Object.values(current.AllowFunnel ?? {}).some(Boolean);
}

/** Require exactly our root proxy on 443; never claim unrelated paths or Funnel. */
function serveOwned(current: Obj, hostname: string, port: number): boolean {
  if (funnelEnabled(current)) return false;
  const expected = { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } };
  return isDeepStrictEqual(current.Web?.[`${hostname}:443`], expected) &&
    isDeepStrictEqual(current.TCP?.['443'], { HTTPS: true });
}

function recordedServe(hostname: string, port: number): boolean {
  const record = pids.readJson(path.join(paths.CONFIG, 'serve.json'), {}) as Obj;
  return record.hostname === hostname && record.port === port && ['pending', 'active'].includes(record.state);
}

function port443Occupied(current: Obj, hostname: string): boolean {
  return '443' in (current.TCP ?? {}) || `${hostname}:443` in (current.Web ?? {});
}

function preflightExposure(config: Config): void {
  if (!pids.which('tailscale')) return;
  const current = pids.serveConfig(); // Fail closed if an existing daemon cannot be inspected.
  if (funnelEnabled(current)) {
    throw new Failure('Existing Tailscale Funnel detected. No app services were started.', 3,
      'Inspect sudo tailscale serve status and disable public exposure before installing this unauthenticated app.');
  }
  const hostname = selfHostname(pids.tailscaleStatus());
  const owned = () => recordedServe(hostname, config.port) && serveOwned(current, hostname, config.port);
  const ours = new RegExp(`^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):${config.port}(?:/|$)`);
  for (const [site, settings] of Object.entries(current.Web ?? {}) as [string, Obj][]) {
    for (const handler of Object.values(settings.Handlers ?? {}) as Obj[]) {
      // Refuse any unowned proxy aimed at this listener, including a
      // pre-existing exact match; matching config isn't proof we made it.
      if (ours.test(handler.Proxy ?? '') && !(site === `${hostname}:443` && owned())) {
        throw new Failure('An unowned Tailscale route targets the application port. No app services were started.', 3,
          'Choose another application port on first install, or remove the conflicting route yourself.');
      }
    }
  }
  if (config.access === 'tailscale' && port443Occupied(current, hostname) && !owned()) {
    throw new Failure('Tailscale port 443 is already owned by another service. No app services were started.', 3);
  }
}

function ensureTailscale(): void {
  if (!pids.which('tailscale')) {
    // Official installer chooses the supported distro repository; only after setup approval.
    withTemporaryDirectory(os.tmpdir(), (temporary) => {
      const script = path.join(temporary, 'tailscale-install.sh');
      pids.run(['curl', '--proto', '=https', '-fsSL', '--max-time', '60', 'https://tailscale.com/install.sh', '-o', script],
        { timeout: 90 });
      pids.run(['sh', script], { timeout: 1800 });
    });
  }
  pids.run(['systemctl', 'enable', '--now', 'tailscaled'], { timeout: 120 });
}

function configureTailscale(config: Config): string {
  const status = pids.tailscaleStatus();
  if (status.BackendState !== 'Running') {
    throw new Failure('Application installed locally; Tailscale needs authorization.', 3,
      'Run sudo tailscale up, approve this machine, then rerun sudo pids setup --yes --no-input --access tailscale.');
  }
  const hostname = selfHostname(status);
  if (!/^[a-zA-Z0-9.-]+\.ts\.net$/.test(hostname)) {
    throw new Failure('Tailscale has no usable MagicDNS hostname.', 3, 'Enable MagicDNS/HTTPS in your tailnet, then retry setup.');
  }
  const current = pids.serveConfig();
  // Other ports can coexist. Never overwrite 443 or any enabled public Funnel.
  if (funnelEnabled(current) || (port443Occupied(current, hostname) &&
      !(recordedServe(hostname, config.port) && serveOwned(current, hostname, config.port)))) {
    throw new Failure('Existing Tailscale Serve/Funnel configuration conflicts; it was not changed.', 3,
      'Inspect sudo tailscale serve status and choose how to resolve the existing route.');
  }
  const record = { hostname, port: config.port, state: 'pending' };
  const serveFile = path.join(paths.CONFIG, 'serve.json');
  // Persist ownership intent before mutation so an interrupted apply can be
  // retried without accidentally adopting some pre-existing matching route.
  atomicWrite(serveFile, JSON.stringify(record));
  try {
    // Setup approval has already been granted; do not prompt on child stdin.
    pids.run(['tailscale', 'serve', '--yes', '--bg', '--https=443', `http://127.0.0.1:${config.port}`], { timeout: 45 });
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    throw new Failure('Local installation is ready, but private HTTPS setup did not complete.', 3,
      'Check stderr for Tailscale approval URLs/errors. Enable HTTPS certificates in your tailnet, then rerun sudo pids setup --yes --no-input.');
  }
  if (!serveOwned(pids.serveConfig(), hostname, config.port)) {
    throw new Failure('Tailscale Serve did not reach the expected private configuration.', 3);
  }
  atomicWrite(serveFile, JSON.stringify({ ...record, state: 'active' }));
  return `https://${hostname}`;
}

function realpathOrResolve(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

const MANAGER_FILE = fileURLToPath(import.meta.url);

/** Copy this manager and a launcher into place, so a partial install can be inspected/retried. */
function installManager(): void {
  const manager = path.join(paths.ROOT, 'manager');
  atomicWrite(path.join(manager, 'pids.ts'), fs.readFileSync(MANAGER_FILE, 'utf8'), 0o755);
  atomicWrite(path.join(manager, 'package.json'), '{ "type": "module" }\n', 0o644);
  fs.rmSync(path.join(manager, 'pids.py'), { force: true }); // Left by the earlier Python manager.
  atomicWrite(paths.LAUNCHER, `#!/bin/sh\nexec ${paths.ROOT}/node/bin/node --disable-warning=ExperimentalWarning ` +
    `${manager}/pids.ts "$@"\n`, 0o755);
}

async function setup(args: Args): Promise<Obj> {
  const host = pids.hostInfo();
  const previousConfig = pids.readJson(path.join(paths.CONFIG, 'config.json'), {}) as Obj;
  const planned = await pids.settings(args, previousConfig);
  const source = realpathOrResolve(args.source ?? previousConfig.source ?? path.join(path.dirname(MANAGER_FILE), '..'));
  const revision = pids.sourceRevision(source);
  const plan = installPlan(planned, host, revision);
  if (args.dryRun) {
    // Inspect/dry-run are useful on unsupported development hosts too; apply is strict.
    try {
      validateHost(host);
      plan.supported_host = true;
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      plan.supported_host = false;
      plan.host_error = error.message;
    }
    return plan;
  }
  validateHost(host);
  pids.requireRoot();
  process.stderr.write(JSON.stringify(plan, null, 2) + '\n');
  await pids.consent(args);
  return withInstallLock(async () => {
    // Re-read after acquiring lock; prevent parallel first-install credential/config replacement.
    // Reuse the answered access mode so an interactive run is not prompted twice.
    const previous = pids.readJson(path.join(paths.CONFIG, 'config.json'), {}) as Obj;
    const config = await pids.settings({ ...args, access: args.access ?? planned.access }, previous);
    const configFile = path.join(paths.CONFIG, 'config.json');
    await pids.preflightPorts(config);
    pids.preflightExposure(config);
    pids.preflightSandboxDns();
    for (const service of [SERVICE, STORAGE]) {
      const unit = path.join(paths.UNITS, `${service}.service`);
      if (fs.existsSync(unit) && !fs.existsSync(configFile)) {
        throw new Failure(`Unmanaged unit ${unit} exists; refusing to replace it.`, 2);
      }
    }
    if (pids.which('docker')) {
      const container = pids.run(['docker', 'inspect', STORAGE], { capture: true, check: false, timeout: 15 });
      if (container.returncode === 0 && !fs.existsSync(configFile)) {
        throw new Failure(`Unmanaged Docker container ${STORAGE} exists; refusing to reuse it.`, 2);
      }
    }
    pids.installPackages(host);
    if (config.access === 'tailscale') {
      pids.ensureTailscale();
      // Installing/starting Tailscale can load old persisted routes.
      pids.preflightExposure(config);
    }
    const account = pids.serviceAccount();
    pids.toolchain();
    const keys = pids.credentials(config);
    pids.installManager();
    const saved: Obj = { ...config, source, revision, state: 'installing', pending_restarts: previous.pending_restarts ?? [] };
    saveConfig(saved);
    const release = pids.prepareSource(source, revision, account);
    // The bootstrap checkout is temporary. Recovery always uses the retained release copy.
    saved.source = release;
    saveConfig(saved);
    pids.installUnits(config, account, saved);
    pids.run(['docker', 'pull', RUSTFS_IMAGE], { timeout: 900 });
    pids.run(['systemctl', 'daemon-reload']);
    pids.run(['systemctl', 'enable', STORAGE, SERVICE]);
    pids.run(['systemctl', saved.pending_restarts.includes(STORAGE) ? 'restart' : 'start', STORAGE]);
    await pids.waitHttp(`http://127.0.0.1:${config.storage_port}/health`);
    await pids.ensureBucket(config, keys);
    restartCompleted(STORAGE, saved);
    const environment = {
      PATH: `${paths.ROOT}/bin:${paths.ROOT}/node/bin:${release}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: paths.DATA, LANG: 'C.UTF-8', AWS_ACCESS_KEY_ID: keys.access_key, AWS_SECRET_ACCESS_KEY: keys.secret_key,
      AWS_REGION: 'us-east-1', DOCKER_HOST: 'unix:///var/run/docker.sock', CELLD_CONTAINER_PLATFORM: 'linux/amd64',
      DOCKER_BUILDKIT: '0',
    };
    pids.run(['runuser', '-u', USER, '--', path.join(paths.ROOT, 'bin/celld'), 'deploy', path.join(release, 'wrangler.install.jsonc'),
      '--bucket', `s3://${BUCKET}`, '--endpoint', `http://127.0.0.1:${config.storage_port}`, '--json'],
    { cwd: release, env: environment, timeout: 3600 });
    pids.run(['systemctl', saved.pending_restarts.includes(SERVICE) ? 'restart' : 'start', SERVICE]);
    let url = `http://127.0.0.1:${config.port}`;
    await pids.waitHttp(url + '/', '<html');
    await pids.waitHttp(url + '/api/sessions', '[');
    restartCompleted(SERVICE, saved);
    Object.assign(saved, { state: 'ready-local', url });
    saveConfig(saved);
    if (pids.sandboxDnsProbe() === false) {
      throw new Failure('Application installed locally, but a sandbox on the celld network cannot resolve github.com.', 3,
        'Sessions cannot clone repositories until Docker gives containers a public resolver. ' +
        `Check "dns" in ${paths.DOCKER_DAEMON_JSON}, run sudo systemctl restart docker, then sudo pids doctor --json.`);
    }
    if (config.access === 'tailscale') url = pids.configureTailscale(config);
    Object.assign(saved, { state: 'ready', url });
    saveConfig(saved);
    return { ok: true, url, revision, warnings: WARNINGS,
      next: 'Open the URL and configure a model provider. Restrict access with tailnet grants.' };
  });
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

function inspect(args: Args): Obj {
  const status = pids.tailscaleStatus();
  // Current clients may also include a top-level alias. Use the node's own
  // addresses, falling back for older status schemas.
  const ips: string[] = status.Self?.TailscaleIPs ?? status.TailscaleIPs ?? [];
  const result: Obj = {
    host: pids.hostInfo(), installation: pids.readJson(path.join(paths.CONFIG, 'config.json'), {}),
    tailscale: { state: status.BackendState ?? null, hostname: selfHostname(status), ips }, warnings: WARNINGS,
  };
  if (args.domain !== undefined) {
    if (!DOMAIN.test(args.domain)) throw new Failure('Supply a DNS hostname, without a scheme, port, path, or wildcard.', 2);
    result.dns_plan = {
      domain: args.domain, access: 'tailnet-only', proxied: false,
      records: ips.map((ip) => ({ type: ip.includes(':') ? 'AAAA' : 'A', name: args.domain, content: ip })),
      applied: false, custom_domain_serving_supported: false,
      next: 'DNS alone is insufficient. Custom-domain TLS and preview routing are a follow-up; use the ts.net URL now.',
    };
  }
  return result;
}

async function doctor(): Promise<Obj> {
  const config = pids.readJson(path.join(paths.CONFIG, 'config.json'), null) as Obj | null;
  if (isEmpty(config)) throw new Failure('Not installed.', 3, 'Run install.sh or pids setup from a checkout.');
  const installed = config as Obj;
  const url = `http://127.0.0.1:${installed.port}`;
  const checks: Record<string, boolean> = {
    [SERVICE]: pids.isActive(SERVICE), [STORAGE]: pids.isActive(STORAGE),
    ui: await pids.httpOk(url + '/', '<html'), api: await pids.httpOk(url + '/api/sessions', '['),
    storage: await pids.httpOk(`http://127.0.0.1:${installed.storage_port}/health`),
  };
  let probe: boolean | null;
  try {
    probe = pids.sandboxDnsProbe();
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    probe = false;
  }
  if (probe !== null) checks.sandbox_dns = probe;
  if (installed.access === 'tailscale') {
    const status = pids.tailscaleStatus();
    checks.tailscale = status.BackendState === 'Running';
    try {
      const hostname = selfHostname(status);
      checks.private_https_route = checks.tailscale && recordedServe(hostname, installed.port) &&
        serveOwned(pids.serveConfig(), hostname, installed.port);
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      checks.private_https_route = false;
    }
  }
  return { ok: Object.values(checks).every(Boolean), checks, url: installed.url ?? url, install_state: installed.state ?? null,
    warnings: WARNINGS, remote_verification: 'From another tailnet client, open the URL and test chat and Terminal.' };
}

async function uninstall(args: Args): Promise<Obj> {
  pids.requireRoot();
  await pids.consent(args);
  const preserved = [paths.DATA, paths.CONFIG, paths.ROOT];
  return withInstallLock(() => {
    const config = pids.readJson(path.join(paths.CONFIG, 'config.json'), null) as Obj | null;
    if (config === null || isEmpty(config)) throw new Failure('No managed installation found; nothing removed.', 2);
    if (config.state === 'uninstalled-data-preserved') {
      return { ok: true, preserved, note: 'Already uninstalled. Data and credentials remain preserved.' };
    }
    if (config.access === 'tailscale' && pids.which('tailscale')) {
      const hostname = selfHostname(pids.tailscaleStatus());
      const current = pids.serveConfig();
      if (recordedServe(hostname, config.port) && serveOwned(current, hostname, config.port)) {
        pids.run(['tailscale', 'serve', '--yes', '--https=443', 'off'], { timeout: 30 });
      } else if ('443' in (current.TCP ?? {})) {
        throw new Failure("Serve configuration has changed; refusing to remove someone else's route.", 3);
      }
    }
    for (const service of [SERVICE, STORAGE]) {
      const unit = path.join(paths.UNITS, `${service}.service`);
      if (fs.existsSync(unit)) {
        pids.run(['systemctl', 'disable', '--now', service]);
        fs.rmSync(unit);
      } else {
        const state = pids.run(['systemctl', 'show', '--property=LoadState', '--value', service], { capture: true, check: false });
        if (state.stdout.trim() !== 'not-found') {
          throw new Failure(`Cannot establish that missing managed unit ${service} is absent; no further removal performed.`, 3);
        }
      }
    }
    fs.rmSync(path.join(paths.CONFIG, 'serve.json'), { force: true });
    pids.run(['systemctl', 'daemon-reload']);
    config.state = 'uninstalled-data-preserved';
    saveConfig(config);
    return { ok: true, preserved,
      note: 'Services removed. Data, credentials, manager and dependencies retained for reinstall. No data purge was performed.' };
  });
}

async function startStop(command: 'start' | 'stop'): Promise<Obj> {
  pids.requireRoot();
  return withInstallLock(() => {
    if (isEmpty(pids.readJson(path.join(paths.CONFIG, 'config.json'), null))) throw new Failure('No managed installation found.', 2);
    for (const service of command === 'start' ? [STORAGE, SERVICE] : [SERVICE, STORAGE]) pids.run(['systemctl', command, service]);
    return { ok: true, action: command, warnings: command === 'stop' ? WARNINGS : [] };
  });
}

function logs(lines: number): Obj {
  if (!Number.isInteger(lines) || lines < 1 || lines > 1000) throw new Failure('--lines must be between 1 and 1000.', 2);
  const result = pids.run(['journalctl', '-u', SERVICE, '-u', STORAGE, '--no-pager', '-n', String(lines), '-o', 'cat'], { capture: true });
  return { lines: result.stdout.split('\n').filter((line, index, all) => line !== '' || index < all.length - 1) };
}

// ---- Command line ----------------------------------------------------------

type OptionSpec = { type: 'string' | 'boolean'; help: string; choices?: string[]; integer?: boolean; metavar?: string };
type CommandSpec = { help: string; options: Record<string, OptionSpec> };

const APPROVAL: Record<string, OptionSpec> = {
  yes: { type: 'boolean', help: 'Approve host changes' },
  'no-input': { type: 'boolean', help: 'Never prompt; fail with actionable missing-input errors' },
};
const COMMANDS: Record<string, CommandSpec> = {
  inspect: { help: 'Read host, installation and Tailscale facts without mutations', options: {
    domain: { type: 'string', metavar: 'HOST', help: 'Report DNS records for a custom domain; does not configure DNS/TLS' } } },
  setup: { help: 'Install, repair or deploy an explicit source checkout', options: {
    source: { type: 'string', metavar: 'DIR', help: 'Path to pi-durable-sessions (defaults to this checkout or installed release)' },
    config: { type: 'string', metavar: 'FILE', help: 'JSON file: access, port, storage_port' },
    access: { type: 'string', choices: ['local', 'tailscale'], help: 'local (127.0.0.1 only) or tailscale (private tailnet HTTPS)' },
    port: { type: 'string', integer: true, metavar: 'PORT', help: 'Application port on 127.0.0.1 (default 8093)' },
    'storage-port': { type: 'string', integer: true, metavar: 'PORT', help: 'Object storage port on 127.0.0.1 (default 19000)' },
    'dry-run': { type: 'boolean', help: 'Plan only: no packages, files, services or downloads changed' },
    ...APPROVAL } },
  uninstall: { help: 'Remove services and own Serve route; preserve ALL data', options: { ...APPROVAL } },
  doctor: { help: 'Bounded health checks; exit 3 if unhealthy', options: {} },
  start: { help: 'Start installed services', options: {} },
  stop: { help: 'Stop services (sandbox workspaces may be lost)', options: {} },
  logs: { help: 'Read bounded journal logs', options: {
    lines: { type: 'string', integer: true, metavar: 'N', help: 'Number of lines, 1..1000 (default 100)' } } },
};
const COMMON: Record<string, OptionSpec> = {
  json: { type: 'boolean', help: 'Stable JSON stdout (default when stdout is not a TTY)' },
  help: { type: 'boolean', help: 'Show this help' },
};
const USAGE_ACTION = 'Run pids --help for arguments and examples.';

function helpText(command?: string): string {
  if (!command) {
    const names = Object.entries(COMMANDS).map(([name, spec]) => `  ${name.padEnd(10)} ${spec.help}`).join('\n');
    return `usage: pids <command> [options]\n\nPrivate Linux installer/manager for pi-durable-sessions.\n\ncommands:\n${names}\n\n` +
      'Run pids <command> --help for its options.\n' +
      'Examples: pids inspect --json; pids setup --access tailscale --dry-run --json; sudo pids doctor --json\n';
  }
  const options = Object.entries({ ...COMMANDS[command].options, ...COMMON }).map(([name, spec]) => {
    const flag = `--${name}${spec.type === 'string' ? ` ${spec.choices ? `{${spec.choices.join(',')}}` : spec.metavar ?? 'VALUE'}` : ''}`;
    return `  ${flag.padEnd(28)} ${spec.help}`;
  }).join('\n');
  return `usage: pids ${command} [options]\n\n${COMMANDS[command].help}\n\noptions:\n${options}\n`;
}

function parseCli(argv: string[]): Args {
  const command = argv[0];
  if (command === undefined || command.startsWith('-')) {
    if (argv.includes('--help') || argv.includes('-h')) return blankArgs('', true);
    throw new Failure('the following arguments are required: command', 2, USAGE_ACTION);
  }
  const spec = COMMANDS[command];
  if (!spec) {
    throw new Failure(`invalid command '${command}' (choose from ${Object.keys(COMMANDS).join(', ')})`, 2, USAGE_ACTION);
  }
  const options = { ...spec.options, ...COMMON };
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({ args: argv.slice(1), strict: true, allowPositionals: false,
      options: Object.fromEntries(Object.entries(options).map(([name, option]) =>
        [name, { type: option.type, ...(name === 'help' ? { short: 'h' } : {}) }])) }).values;
  } catch (error) {
    throw new Failure((error as Error).message, 2, USAGE_ACTION);
  }
  const integer = (name: string): number | undefined => {
    const value = values[name];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
      throw new Failure(`argument --${name}: invalid integer value: '${value}'`, 2, USAGE_ACTION);
    }
    return Number(value);
  };
  for (const [name, option] of Object.entries(options)) {
    if (option.choices && values[name] !== undefined && !option.choices.includes(values[name] as string)) {
      throw new Failure(`argument --${name}: invalid choice: '${values[name]}' (choose from ${option.choices.join(', ')})`, 2,
        USAGE_ACTION);
    }
  }
  const text = (name: string) => values[name] as string | undefined;
  return {
    command, json: values.json === true, help: values.help === true, domain: text('domain'), source: text('source'),
    config: text('config'), access: text('access'), port: integer('port'), storagePort: integer('storage-port'),
    dryRun: values['dry-run'] === true, yes: values.yes === true, noInput: values['no-input'] === true,
    lines: integer('lines') ?? 100,
  };
}

function blankArgs(command: string, help = false): Args {
  return { command, json: false, help, dryRun: false, yes: false, noInput: false, lines: 100 };
}

export async function main(argv: string[] = process.argv.slice(2),
  write: (text: string) => void = (text) => process.stdout.write(text)): Promise<number> {
  const asJson = argv.includes('--json') || !process.stdout.isTTY;
  try {
    const args = pids.parseCli(argv);
    if (args.help) {
      write(helpText(args.command || undefined));
      return 0;
    }
    let result: Obj;
    switch (args.command) {
      case 'setup': result = await pids.setup(args); break;
      case 'inspect': result = pids.inspect(args); break;
      case 'doctor': result = await pids.doctor(); break;
      case 'uninstall': result = await pids.uninstall(args); break;
      case 'start': case 'stop': result = await startStop(args.command); break;
      default: result = logs(args.lines);
    }
    output(result, asJson, write);
    return result.ok === false ? 3 : 0;
  } catch (error) {
    const failure = error instanceof Failure ? error : null;
    output({ ok: false, error: error instanceof Error ? error.message : String(error), action: failure?.action ?? null }, asJson, write);
    const code = failure?.code ?? 1;
    return Number.isInteger(code) && code > 0 && code < 126 ? code : 1;
  }
}

export const pids = {
  run, which, readJson, atomicWrite, hostInfo, validateHost, settings, prompt, sourceFiles, sourceRevision, installPlan,
  requireRoot, consent, withInstallLock, portAvailable, isActive, preflightPorts, containerResolvers, sandboxBlocked,
  preflightSandboxDns, sandboxDnsProbe, installPackages, download, runtimeDirectories, toolchain, serviceAccount,
  credentials, units, installUnits, restartCompleted, prepareSource, s3Request, ensureBucket, httpOk, waitHttp,
  tailscaleStatus, serveConfig, serveOwned, recordedServe, preflightExposure, ensureTailscale, configureTailscale,
  installManager, setup, inspect, doctor, uninstall, parseCli, helpText,
  now: (): number => performance.now() / 1000,
  sleep: (seconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
};

if (process.argv[1] && realpathOrResolve(process.argv[1]) === MANAGER_FILE) {
  // stdout/stderr writes are synchronous on Linux, so exiting cannot truncate the JSON result.
  process.exit(await main());
}
