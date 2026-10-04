#!/usr/bin/env python3
"""Private Linux installer/manager. Standard library only; no host Node required."""
import argparse
import contextlib
import datetime
import fcntl
import gzip
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import platform
import pwd
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path('/opt/pi-durable-sessions')
CONFIG = Path('/etc/pi-durable-sessions')
DATA = Path('/var/lib/pi-durable-sessions')
UNITS = Path('/etc/systemd/system')
LAUNCHER = Path('/usr/local/bin/pids')
USER = 'pids'
STORAGE = 'pi-durable-sessions-storage'
SERVICE = 'pi-durable-sessions'
BUCKET = 'pid-cells'
CELLD_URL = 'https://github.com/denoland/celld/releases/download/v0.6.1/celld-x86_64-unknown-linux-gnu.gz'
CELLD_SHA = '79a8253cff5d4e8a4a9f7a2611e393390f7fe9025f00e88467875b007c44866b'
NODE_URL = 'https://nodejs.org/dist/v24.5.0/node-v24.5.0-linux-x64.tar.xz'
NODE_SHA = '32edb1f2aeaf8ea0d484af33bf3b5d8330d7d33c9cd8c70f811b8a643822e613'
RUSTFS_IMAGE = 'rustfs/rustfs@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff'
PROBE_IMAGE = 'busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662'
SANDBOX_NETWORK = 'celld'  # Created by celld; its nftables policy applies to this bridge.
DOCKER_DAEMON_JSON = Path('/etc/docker/daemon.json')
RESOLV_CONF = Path('/etc/resolv.conf')
RESOLVED_UPLINK = Path('/run/systemd/resolve/resolv.conf')
# celld rejects sandbox traffic to these ranges, so a resolver here is unreachable from every session.
SANDBOX_BLOCKED = [ipaddress.ip_network(n) for n in (
    '127.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16',
    '::1/128', 'fc00::/7', 'fe80::/10')]
SOURCE_FILES = ['package.json', 'package-lock.json', 'Dockerfile', 'wrangler.jsonc']
SOURCE_DIRS = ['src', 'ui', 'ops']
SKIP = {'node_modules', 'dist', '.git', '__pycache__', '.env', '.DS_Store'}
WARNINGS = [
    'No app accounts yet: every permitted tailnet client has full access. Restrict tailnet grants.',
    'Sandbox workspaces are ephemeral. Restarting celld can lose unpushed work.',
    'Remote previews still use localhost:8093. Use an SSH forward; custom-domain routing is deferred.',
    'Provider OAuth requires pasting the redirect URL; the Vite callback listeners are not installed.',
    'Local RustFS is not an off-machine backup. Back up the persistent data separately.',
]


class Failure(Exception):
    def __init__(self, message, code=1, action=None):
        super().__init__(message)
        self.code = code
        self.action = action


def run(args, *, capture=False, check=True, env=None, cwd=None, timeout=600):
    """Child diagnostics never contaminate the CLI's JSON stdout."""
    try:
        result = subprocess.run([str(a) for a in args], cwd=cwd, env=env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE if capture else sys.stderr,
                                stderr=subprocess.PIPE if capture else sys.stderr, text=True, timeout=timeout)
    except FileNotFoundError:
        raise Failure(f'Command not installed: {args[0]}', action='Run setup with --yes to install prerequisites.')
    except subprocess.TimeoutExpired:
        raise Failure(f'Timed out running {args[0]}', action='Inspect pids logs, then retry. Data has been preserved.')
    if check and result.returncode:
        # Do not echo arbitrary command output: external tools may print credentials.
        recovery = {
            ('docker', 'info'): 'Run sudo docker info and sudo systemctl status docker. Check daemon startup and /var/run/docker.sock permissions.',
            ('docker', 'context', 'inspect'): 'Run sudo docker context inspect. Select the local system Docker engine, not a remote context.',
        }.get(tuple(str(arg) for arg in args), 'Check diagnostics on stderr, or run pids logs. Fix the cause and retry.')
        raise Failure(f'{args[0]} failed (exit {result.returncode})', action=recovery)
    return result


def output(value, as_json):
    if as_json:
        print(json.dumps(value, indent=2))
    else:
        for key, item in value.items():
            print(f'{key}: {json.dumps(item) if isinstance(item, (dict, list)) else item}')


def read_json(path, default=None):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except (ValueError, OSError) as exc:
        raise Failure(f'Cannot read JSON at {path}: {exc}')


def atomic_write(path, text, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'w') as handle:
            handle.write(text)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def os_release(path=Path('/etc/os-release')):
    values = {}
    if path.exists():
        for line in path.read_text().splitlines():
            key, sep, value = line.partition('=')
            if sep:
                values[key] = value.strip('"\'')
    return values


def host_info():
    release = os_release()
    return {'os': platform.system(), 'architecture': platform.machine(),
            'distribution': release.get('ID', ''), 'version': release.get('VERSION_ID', ''),
            'systemd': Path('/run/systemd/system').is_dir(),
            'docker': shutil.which('docker') is not None, 'tailscale': shutil.which('tailscale') is not None}


def validate_host(host):
    if host['os'] != 'Linux' or host['architecture'] not in ('x86_64', 'amd64'):
        raise Failure('This test installer supports Linux x86-64 only (not macOS or Graviton/ARM).', 2)
    distro = host['distribution']
    major = int(host['version'].split('.')[0]) if re.match(r'^\d+', host['version']) else 0
    if not (distro in ('arch', 'omarchy') or distro == 'ubuntu' and major >= 22 or distro == 'debian' and major >= 12):
        raise Failure('Supported distributions: Omarchy/Arch, Ubuntu 22.04+, Debian 12+.', 2)
    if not host['systemd']:
        raise Failure('A running systemd host is required (not a regular Docker container).', 2)


def settings(args, previous):
    if args.config and not Path(args.config).exists():
        raise Failure(f'Config file does not exist: {args.config}', 2)
    incoming = read_json(Path(args.config), {}) if args.config else {}
    if not isinstance(incoming, dict) or set(incoming) - {'access', 'port', 'storage_port'}:
        raise Failure('Config accepts only access, port, storage_port.', 2)
    values = {key: previous[key] for key in ('access', 'port', 'storage_port') if key in previous}
    values.update(incoming)
    for key in ('access', 'port', 'storage_port'):
        if getattr(args, key) is not None:
            values[key] = getattr(args, key)
    values.setdefault('port', 8093)
    values.setdefault('storage_port', 19000)
    if 'access' not in values:
        if args.no_input or not sys.stdin.isatty():
            raise Failure('Choose --access local or --access tailscale for the first installation.', 2)
        values['access'] = input('Access [tailscale/local] (tailscale): ').strip() or 'tailscale'
    if values['access'] not in ('local', 'tailscale'):
        raise Failure('access must be local or tailscale. Public access is not supported before auth.', 2)
    for key in ('port', 'storage_port'):
        if type(values[key]) is not int or not 1024 <= values[key] <= 65535:
            raise Failure(f'{key} must be an integer between 1024 and 65535.', 2)
    if values['port'] == values['storage_port']:
        raise Failure('Application and storage ports must differ.', 2)
    for key in ('access', 'port', 'storage_port'):
        if key in previous and values[key] != previous[key]:
            raise Failure(f'{key} is already {previous[key]!r}; this test installer does not change it in place.', 2)
    return values


def source_files(source):
    for name in SOURCE_FILES:
        path = source / name
        if not path.is_file() or path.is_symlink():
            raise Failure(f'Not an application checkout: missing regular file {path}', 2)
        yield path
    for directory in SOURCE_DIRS:
        base = source / directory
        if not base.is_dir() or base.is_symlink():
            raise Failure(f'Missing source directory {base}', 2)
        for root, dirs, files in os.walk(base):
            dirs[:] = sorted(d for d in dirs if d not in SKIP and not d.startswith('.env'))
            for entry in dirs + files:
                if (Path(root) / entry).is_symlink():
                    raise Failure(f'Symlinks are not accepted in installation sources: {Path(root) / entry}', 2)
            for name in sorted(files):
                if name not in SKIP and not name.startswith('.env'):
                    yield Path(root) / name


def source_revision(source):
    digest = hashlib.sha256()
    for path in source_files(source):
        digest.update(str(path.relative_to(source)).encode() + b'\0')
        digest.update(path.read_bytes())
    return digest.hexdigest()[:20]


def install_plan(config, host, revision):
    return {'host': host, 'config': config, 'source_revision': revision,
            'paths': {'application': str(ROOT), 'config': str(CONFIG), 'data': str(DATA)},
            'steps': ['Check that sandboxes will get a DNS resolver celld lets them reach',
                      'Install/reuse distro Docker and required tools',
                      'Install checksum-pinned celld 0.6.1 and Node 24.5.0',
                      'Create dedicated pids service account and private random storage credentials',
                      'Build UI and worker from lockfiles as the service account',
                      'Start digest-pinned RustFS on loopback; create private bucket',
                      'Deploy worker, sandbox image and static assets',
                      'Enable systemd services; wait for UI and API health'] +
                     (['Install/reuse Tailscale; require authorization; configure private Serve HTTPS']
                      if config['access'] == 'tailscale' else []),
            'warnings': WARNINGS, 'public_ingress_required': False}


def require_root():
    if os.geteuid() != 0:
        raise Failure('This operation needs root.', 2, 'Rerun with sudo; inspect and setup --dry-run need no root.')


def consent(args):
    if args.yes:
        return
    if args.no_input or not sys.stdin.isatty():
        raise Failure('Approval required: pass --yes to allow the displayed host changes.', 2)
    if input('Apply these changes? [y/N] ').strip().lower() != 'y':
        raise Failure('Cancelled; no changes made.', 2)


@contextlib.contextmanager
def install_lock():
    CONFIG.mkdir(parents=True, exist_ok=True)
    CONFIG.chmod(0o755)  # Public settings are readable; credential files remain 0600.
    with (CONFIG / 'install.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Failure('Another pids operation is in progress. Retry when it finishes.', 3)
        yield


def port_available(port):
    with socket.socket() as sock:
        try:
            sock.bind(('127.0.0.1', port))
            return True
        except OSError:
            return False


def is_active(service):
    return bool(shutil.which('systemctl')) and run(
        ['systemctl', 'is-active', '--quiet', service], capture=True, check=False, timeout=15).returncode == 0


def preflight_ports(config):
    for key, service in [('port', SERVICE), ('storage_port', STORAGE)]:
        if not port_available(config[key]) and not is_active(service):
            raise Failure(f'127.0.0.1:{config[key]} is already occupied by another service.', 2,
                          f'Choose --{key.replace("_", "-")} on the first installation, or resolve the conflict.')


def resolv_nameservers(path):
    try:
        lines = Path(path).read_text().splitlines()
    except OSError:
        return []
    return [parts[1] for parts in (line.split() for line in lines) if len(parts) > 1 and parts[0] == 'nameserver']


def container_resolvers():
    """Resolvers Docker hands to containers: daemon.json dns, else the host's, and
    for a loopback-only stub (systemd-resolved) the uplink servers behind it."""
    configured = read_json(DOCKER_DAEMON_JSON, {}).get('dns')
    if configured:
        return [str(server) for server in configured], f'"dns" in {DOCKER_DAEMON_JSON}'
    servers = resolv_nameservers(RESOLV_CONF)
    if servers and all(getattr(parse_ip(server), 'is_loopback', False) for server in servers):
        return resolv_nameservers(RESOLVED_UPLINK), f'the uplink resolvers in {RESOLVED_UPLINK}'
    return servers, f'the resolvers in {RESOLV_CONF}'


def parse_ip(address):
    try:
        return ipaddress.ip_address(address.split('%')[0])
    except ValueError:
        return None


def sandbox_blocked(address):
    ip = parse_ip(address)
    return ip is None or any(ip in network for network in SANDBOX_BLOCKED)


def preflight_sandbox_dns():
    """Sessions clone repositories inside sandboxes; those need a resolver celld lets them reach."""
    servers, source = container_resolvers()
    if any(not sandbox_blocked(server) for server in servers):
        return
    raise Failure(f'Sandboxes would have no reachable DNS resolver: {source} lists {servers or "nothing"}, and celld '
                  'blocks sandbox traffic to loopback, private and tailnet addresses. Sessions could not clone '
                  'repositories or install packages. No changes made.', 2,
                  f'Give Docker a public resolver: set "dns": ["1.1.1.1", "8.8.8.8"] in {DOCKER_DAEMON_JSON} '
                  '(or remove a "dns" entry that points at this host when its upstream resolvers are already public), '
                  'then run sudo systemctl restart docker and rerun setup.')


def sandbox_dns_probe():
    """Ground truth on the real sandbox network: None when celld has not created it yet."""
    exists = run(['docker', 'network', 'inspect', SANDBOX_NETWORK], capture=True, check=False, timeout=30)
    if exists.returncode:
        return None
    probe = run(['docker', 'run', '--rm', '--network', SANDBOX_NETWORK, '--label', 'io.pids.managed=probe',
                 PROBE_IMAGE, 'nslookup', '-timeout=5', 'github.com'], capture=True, check=False, timeout=180)
    return probe.returncode == 0


def install_packages(host):
    # Reuse an existing engine; do not replace Docker CE or change its daemon configuration.
    if host['distribution'] in ('arch', 'omarchy'):
        packages = ['curl', 'ca-certificates', 'git', 'python', 'tar', 'xz']
        if not shutil.which('docker'):
            packages += ['docker', 'docker-buildx']
        run(['pacman', '-S', '--needed', '--noconfirm', *packages], timeout=1800)
    else:
        run(['apt-get', 'update'], timeout=600)
        packages = ['curl', 'ca-certificates', 'git', 'python3', 'tar', 'xz-utils']
        if not shutil.which('docker'):
            packages += ['docker.io']
        run(['apt-get', 'install', '-y', *packages], timeout=1800,
            env={**os.environ, 'DEBIAN_FRONTEND': 'noninteractive'})
    run(['systemctl', 'enable', '--now', 'docker'], timeout=120)
    run(['docker', 'info'], capture=True, timeout=30)
    # celld requires the host's Unix-socket engine, not an arbitrary Docker context.
    context = run(['docker', 'context', 'inspect'], capture=True, timeout=15)
    if json.loads(context.stdout)[0]['Endpoints']['docker']['Host'] != 'unix:///var/run/docker.sock':
        raise Failure('Use the local system Docker engine at /var/run/docker.sock, not a remote/rootless context.', 2)


def download(url, destination, checksum):
    run(['curl', '--proto', '=https', '--tlsv1.2', '-fsSL', '--retry', '3', '--max-time', '300',
         url, '-o', destination], timeout=330)
    actual = hashlib.sha256(destination.read_bytes()).hexdigest()
    if actual != checksum:
        raise Failure(f'Checksum mismatch for {url}; refusing to install.', 1)


def runtime_directories():
    # mkdir(mode=...) is still filtered by umask. Explicit chmod also repairs
    # an interrupted install performed under root's common restrictive umask.
    for path in (ROOT, ROOT / 'bin', ROOT / 'manager', ROOT / 'releases'):
        path.mkdir(parents=True, exist_ok=True)
        path.chmod(0o755)


def toolchain():
    runtime_directories()
    if not (ROOT / 'bin/celld').exists():
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            archive = Path(tmp) / 'celld.gz'
            download(CELLD_URL, archive, CELLD_SHA)
            binary = Path(tmp) / 'celld'
            with gzip.open(archive, 'rb') as src, binary.open('wb') as dst:
                shutil.copyfileobj(src, dst)
            binary.chmod(0o755)
            os.replace(binary, ROOT / 'bin/celld')
    if not (ROOT / 'node/bin/node').exists():
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            archive = Path(tmp) / 'node.tar.xz'
            download(NODE_URL, archive, NODE_SHA)
            stage = Path(tmp) / 'node'
            stage.mkdir()
            run(['tar', '-xJf', archive, '--no-same-owner', '--strip-components=1', '-C', stage])
            stage.chmod(0o755)
            os.replace(stage, ROOT / 'node')
    (ROOT / 'node').chmod(0o755)


def service_account():
    try:
        account = pwd.getpwnam(USER)
        if account.pw_dir != str(DATA) or account.pw_uid == 0:
            raise Failure('An unrelated pids user already exists; refusing to reuse it.', 2)
    except KeyError:
        run(['useradd', '--system', '--user-group', '--home-dir', DATA, '--shell', '/usr/sbin/nologin', USER])
        account = pwd.getpwnam(USER)
    run(['usermod', '-aG', 'docker', USER])
    DATA.mkdir(parents=True, exist_ok=True)
    os.chown(DATA, account.pw_uid, account.pw_gid)
    DATA.chmod(0o700)
    for directory in ('rustfs', 'rustfs-logs', 'cache', 'watch'):
        path = DATA / directory
        path.mkdir(exist_ok=True)
        os.chown(path, account.pw_uid, account.pw_gid)
        path.chmod(0o700)
    return account


def credentials(config):
    path = CONFIG / 'credentials.json'
    stored = read_json(path)
    if stored is None:
        if any((DATA / 'rustfs').iterdir()):
            raise Failure('Storage contains data but credentials.json is missing. Restore credentials; do not rotate blindly.')
        stored = {'access_key': secrets.token_hex(12), 'secret_key': secrets.token_hex(32)}
        atomic_write(path, json.dumps(stored))
    if set(stored) != {'access_key', 'secret_key'} or any(
            not isinstance(v, str) or not re.fullmatch('[0-9a-f]+', v) for v in stored.values()):
        raise Failure('Invalid storage credentials file. Restore the original generated credentials.')
    atomic_write(CONFIG / 'storage.env',
                 f'RUSTFS_ACCESS_KEY={stored["access_key"]}\nRUSTFS_SECRET_KEY={stored["secret_key"]}\n'
                 'RUSTFS_VOLUMES=/data\nRUSTFS_CONSOLE_ENABLE=false\nRUSTFS_OBS_LOG_DIRECTORY=/logs\n')
    atomic_write(CONFIG / 'celld.env',
                 f'AWS_ACCESS_KEY_ID={stored["access_key"]}\nAWS_SECRET_ACCESS_KEY={stored["secret_key"]}\n'
                 'AWS_REGION=us-east-1\nCELLD_TTL_MS=30000\nCELLD_FETCH_TIMEOUT_S=3600\n'
                 f'CELLD_WATCH={DATA}/watch\nCELLD_ASSET_CACHE_DIR={DATA}/cache\n'
                 'DOCKER_HOST=unix:///var/run/docker.sock\nCELLD_CONTAINER_PLATFORM=linux/amd64\n')
    return stored


def units(config, account):
    storage = f'''[Unit]
Description=pi-durable-sessions private object storage
Requires=docker.service
PartOf=docker.service
After=docker.service network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
ExecStart=/usr/bin/docker run --rm --name {STORAGE} --label io.pids.managed=storage --user {account.pw_uid}:{account.pw_gid} --security-opt no-new-privileges --cap-drop ALL --publish 127.0.0.1:{config['storage_port']}:9000 --env-file {CONFIG}/storage.env --volume {DATA}/rustfs:/data --volume {DATA}/rustfs-logs:/logs {RUSTFS_IMAGE}
ExecStop=/usr/bin/docker stop --time 30 {STORAGE}
Restart=always
RestartSec=5
TimeoutStartSec=120
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target docker.service
'''
    node = f'''[Unit]
Description=pi-durable-sessions application
Requires=docker.service
PartOf=docker.service
Wants={STORAGE}.service network-online.target
After=docker.service {STORAGE}.service network-online.target
StartLimitIntervalSec=0

[Service]
User={USER}
Group={USER}
SupplementaryGroups=docker
WorkingDirectory={DATA}
EnvironmentFile={CONFIG}/celld.env
Environment=PATH={ROOT}/bin:/usr/local/bin:/usr/bin:/bin
ExecStart={ROOT}/bin/celld --bucket s3://{BUCKET} --endpoint http://127.0.0.1:{config['storage_port']} --listen 127.0.0.1:{config['port']}
Restart=always
RestartSec=3
TimeoutStopSec=90
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target docker.service
'''
    return {STORAGE: storage, SERVICE: node}


def install_units(config, account, saved):
    for name, content in units(config, account).items():
        path = UNITS / f'{name}.service'
        if not path.exists() or path.read_text() != content:
            saved['pending_restarts'] = sorted(set(saved.get('pending_restarts', [])) | {name})
            # Intent precedes replacement: retry must restart even if the unit
            # file already matches after a failed image pull or deployment.
            atomic_write(CONFIG / 'config.json', json.dumps(saved, indent=2), 0o644)
            atomic_write(path, content, 0o644)


def restart_completed(service, saved):
    saved['pending_restarts'] = [name for name in saved.get('pending_restarts', []) if name != service]
    atomic_write(CONFIG / 'config.json', json.dumps(saved, indent=2), 0o644)


def prepare_source(source, revision, account):
    runtime_directories()
    release = ROOT / 'releases' / revision
    if not (release / '.built').exists():
        release.mkdir(parents=True, exist_ok=True)
        for path in source_files(source):
            target = release / path.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            if path.resolve() != target.resolve():
                shutil.copyfile(path, target)
        config = (release / 'wrangler.jsonc').read_text()
        assets = {'assets': {'directory': './ui/dist', 'binding': 'ASSETS', 'run_worker_first': True,
                             'not_found_handling': 'single-page-application'}}
        config = config.replace('{', '{' + json.dumps(assets)[1:-1] + ',', 1)
        atomic_write(release / 'wrangler.install.jsonc', config, 0o644)
        atomic_write(release / '.dockerignore', 'node_modules\nui\n.git\ndocs\n.env*\n', 0o644)
        run(['chown', '-R', f'{account.pw_uid}:{account.pw_gid}', release])
        # Persist the retained source BEFORE npm: curl's temporary checkout is
        # removed even when a build fails. A retry must not depend on it.
        saved = read_json(CONFIG / 'config.json', {})
        atomic_write(CONFIG / 'config.json', json.dumps({**saved, 'source': str(release)}, indent=2), 0o644)
        environment = {'PATH': f'{ROOT}/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
                       'HOME': str(DATA), 'LANG': 'C.UTF-8', 'npm_config_cache': str(DATA / 'npm-cache')}
        for command in [['npm', 'ci'], ['npm', '--prefix', 'ui', 'ci'], ['npm', '--prefix', 'ui', 'run', 'build']]:
            run(['runuser', '-u', USER, '--', *command], env=environment, cwd=release, timeout=1800)
        atomic_write(release / '.built', 'ok\n', 0o644)
    return release


def s3_request(config, keys, method, path, now=None):
    """Minimal SigV4 for bucket HEAD/PUT only; credentials never go to argv."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    stamp, day = now.strftime('%Y%m%dT%H%M%SZ'), now.strftime('%Y%m%d')
    host = f'127.0.0.1:{config["storage_port"]}'
    payload = hashlib.sha256(b'').hexdigest()
    headers = f'host:{host}\nx-amz-content-sha256:{payload}\nx-amz-date:{stamp}\n'
    signed = 'host;x-amz-content-sha256;x-amz-date'
    canonical = f'{method}\n{path}\n\n{headers}\n{signed}\n{payload}'
    scope = f'{day}/us-east-1/s3/aws4_request'
    string = f'AWS4-HMAC-SHA256\n{stamp}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}'
    key = ('AWS4' + keys['secret_key']).encode()
    for value in (day, 'us-east-1', 's3', 'aws4_request'):
        key = hmac.new(key, value.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, string.encode(), hashlib.sha256).hexdigest()
    return urllib.request.Request(f'http://{host}{path}', method=method,
        data=b'' if method == 'PUT' else None,
        headers={'x-amz-date': stamp, 'x-amz-content-sha256': payload,
                 'Authorization': f'AWS4-HMAC-SHA256 Credential={keys["access_key"]}/{scope}, SignedHeaders={signed}, Signature={signature}'})


def ensure_bucket(config, keys, seconds=120):
    # RustFS /health can return 200 before its S3 layer accepts requests.
    # Retry transient startup failures, but never disguise invalid credentials
    # as a missing bucket. Rechecking HEAD also resolves an ambiguous PUT.
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            try:
                with urllib.request.urlopen(s3_request(config, keys, 'HEAD', f'/{BUCKET}'), timeout=10):
                    return
            except urllib.error.HTTPError as exc:
                if exc.code != 404:
                    raise
            with urllib.request.urlopen(s3_request(config, keys, 'PUT', f'/{BUCKET}'), timeout=10):
                return
        except urllib.error.HTTPError as exc:
            if exc.code not in (409, 429, 500, 502, 503, 504):
                raise Failure(f'Bucket check/create returned HTTP {exc.code}; not replacing storage.')
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(2)
    raise Failure('S3 did not become ready in time.', 1, 'Run sudo pids logs, then retry setup; existing storage was not replaced.')


def http_ok(url, expected=None):
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            body = response.read(2 * 1024 * 1024)
            return response.status == 200 and (expected is None or expected in body)
    except (OSError, urllib.error.URLError):
        return False


def wait_http(url, expected=None, seconds=120):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if http_ok(url, expected):
            return
        time.sleep(2)
    raise Failure(f'Health check timed out: {url}', 1, 'Run sudo pids logs and sudo pids doctor --json, then retry setup.')


def tailscale_status():
    if not shutil.which('tailscale'):
        return {'BackendState': 'NotInstalled'}
    result = run(['tailscale', 'status', '--json'], capture=True, check=False, timeout=15)
    try:
        return json.loads(result.stdout)
    except ValueError:
        return {'BackendState': 'Unavailable'}


def serve_config():
    result = run(['tailscale', 'serve', 'status', '--json'], capture=True, check=False, timeout=15)
    if result.returncode:
        raise Failure('Cannot inspect Tailscale Serve; refusing to change it.', 3, 'Run sudo tailscale serve status.')
    try:
        return json.loads(result.stdout or '{}')
    except ValueError:
        raise Failure('Unrecognized Tailscale Serve status; no configuration changed.', 3)


def serve_owned(current, hostname, port):
    """Require exactly our root proxy on 443; never claim unrelated paths or Funnel."""
    if any(current.get('AllowFunnel', {}).values()):
        return False
    web = current.get('Web', {})
    expected = {'Handlers': {'/': {'Proxy': f'http://127.0.0.1:{port}'}}}
    return web.get(f'{hostname}:443') == expected and current.get('TCP', {}).get('443') == {'HTTPS': True}


def recorded_serve(hostname, port):
    record = read_json(CONFIG / 'serve.json', {})
    return record.get('hostname') == hostname and record.get('port') == port and record.get('state') in ('pending', 'active')


def preflight_exposure(config):
    if not shutil.which('tailscale'):
        return
    current = serve_config()  # Fail closed if an existing daemon cannot be inspected.
    if any(current.get('AllowFunnel', {}).values()):
        raise Failure('Existing Tailscale Funnel detected. No app services were started.', 3,
                      'Inspect sudo tailscale serve status and disable public exposure before installing this unauthenticated app.')
    status = tailscale_status()
    hostname = status.get('Self', {}).get('DNSName', '').rstrip('.')
    for site, settings in current.get('Web', {}).items():
        for handler in settings.get('Handlers', {}).values():
            proxy = handler.get('Proxy', '')
            # Refuse any unowned proxy aimed at this listener, including a
            # pre-existing exact match; matching config isn't proof we made it.
            if re.match(rf'^https?://(?:localhost|127\.0\.0\.1|\[::1\]):{config["port"]}(?:/|$)', proxy):
                if not (site == f'{hostname}:443' and recorded_serve(hostname, config['port']) and
                        serve_owned(current, hostname, config['port'])):
                    raise Failure('An unowned Tailscale route targets the application port. No app services were started.', 3,
                                  'Choose another application port on first install, or remove the conflicting route yourself.')
    if config['access'] == 'tailscale':
        occupied = '443' in current.get('TCP', {}) or f'{hostname}:443' in current.get('Web', {})
        if occupied and not (recorded_serve(hostname, config['port']) and serve_owned(current, hostname, config['port'])):
            raise Failure('Tailscale port 443 is already owned by another service. No app services were started.', 3)


def ensure_tailscale():
    if not shutil.which('tailscale'):
        # Official installer chooses the supported distro repository; only after setup approval.
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / 'tailscale-install.sh'
            run(['curl', '--proto', '=https', '-fsSL', '--max-time', '60',
                 'https://tailscale.com/install.sh', '-o', script], timeout=90)
            run(['sh', script], timeout=1800)
    run(['systemctl', 'enable', '--now', 'tailscaled'], timeout=120)


def configure_tailscale(config):
    status = tailscale_status()
    if status.get('BackendState') != 'Running':
        raise Failure('Application installed locally; Tailscale needs authorization.', 3,
                      'Run sudo tailscale up, approve this machine, then rerun sudo pids setup --yes --no-input --access tailscale.')
    hostname = status.get('Self', {}).get('DNSName', '').rstrip('.')
    if not re.fullmatch(r'[a-zA-Z0-9.-]+\.ts\.net', hostname):
        raise Failure('Tailscale has no usable MagicDNS hostname.', 3, 'Enable MagicDNS/HTTPS in your tailnet, then retry setup.')
    current = serve_config()
    # Other ports can coexist. Never overwrite 443 or any enabled public Funnel.
    occupied = '443' in current.get('TCP', {}) or f'{hostname}:443' in current.get('Web', {})
    if any(current.get('AllowFunnel', {}).values()) or occupied and not (
            recorded_serve(hostname, config['port']) and serve_owned(current, hostname, config['port'])):
        raise Failure('Existing Tailscale Serve/Funnel configuration conflicts; it was not changed.', 3,
                      'Inspect sudo tailscale serve status and choose how to resolve the existing route.')
    record = {'hostname': hostname, 'port': config['port'], 'state': 'pending'}
    # Persist ownership intent before mutation so an interrupted apply can be
    # retried without accidentally adopting some pre-existing matching route.
    atomic_write(CONFIG / 'serve.json', json.dumps(record))
    try:
        # Setup approval has already been granted; do not prompt on child stdin.
        run(['tailscale', 'serve', '--yes', '--bg', '--https=443', f'http://127.0.0.1:{config["port"]}'], timeout=45)
    except Failure:
        raise Failure('Local installation is ready, but private HTTPS setup did not complete.', 3,
                      'Check stderr for Tailscale approval URLs/errors. Enable HTTPS certificates in your tailnet, then rerun sudo pids setup --yes --no-input.')
    if not serve_owned(serve_config(), hostname, config['port']):
        raise Failure('Tailscale Serve did not reach the expected private configuration.', 3)
    atomic_write(CONFIG / 'serve.json', json.dumps({**record, 'state': 'active'}))
    return f'https://{hostname}'


def setup(args):
    host = host_info()
    previous = read_json(CONFIG / 'config.json', {})
    config = settings(args, previous)
    source = Path(args.source or previous.get('source', Path(__file__).resolve().parent.parent)).resolve()
    revision = source_revision(source)
    plan = install_plan(config, host, revision)
    if args.dry_run:
        # Inspect/dry-run are useful on unsupported development hosts too; apply is strict.
        try:
            validate_host(host)
            plan['supported_host'] = True
        except Failure as exc:
            plan['supported_host'] = False
            plan['host_error'] = str(exc)
        return plan
    validate_host(host)
    require_root()
    print(json.dumps(plan, indent=2), file=sys.stderr)
    consent(args)
    with install_lock():
        # Re-read after acquiring lock; prevent parallel first-install credential/config replacement.
        previous = read_json(CONFIG / 'config.json', {})
        config = settings(args, previous)
        preflight_ports(config)
        preflight_exposure(config)
        preflight_sandbox_dns()
        for service in (SERVICE, STORAGE):
            path = UNITS / f'{service}.service'
            if path.exists() and not (CONFIG / 'config.json').exists():
                raise Failure(f'Unmanaged unit {path} exists; refusing to replace it.', 2)
        if shutil.which('docker'):
            container = run(['docker', 'inspect', STORAGE], capture=True, check=False, timeout=15)
            if container.returncode == 0 and not (CONFIG / 'config.json').exists():
                raise Failure(f'Unmanaged Docker container {STORAGE} exists; refusing to reuse it.', 2)
        install_packages(host)
        if config['access'] == 'tailscale':
            ensure_tailscale()
            # Installing/starting Tailscale can load old persisted routes.
            preflight_exposure(config)
        account = service_account()
        toolchain()
        keys = credentials(config)
        # Install recovery commands before long builds, so a partial install can be inspected/retried.
        atomic_write(ROOT / 'manager/pids.py', Path(__file__).read_text(), 0o755)
        atomic_write(LAUNCHER, f'#!/bin/sh\nexec /usr/bin/python3 {ROOT}/manager/pids.py "$@"\n', 0o755)
        saved = {**config, 'source': str(source), 'revision': revision, 'state': 'installing',
                 'pending_restarts': previous.get('pending_restarts', [])}
        atomic_write(CONFIG / 'config.json', json.dumps(saved, indent=2), 0o644)
        release = prepare_source(source, revision, account)
        # The bootstrap checkout is temporary. Recovery always uses the retained release copy.
        saved['source'] = str(release)
        atomic_write(CONFIG / 'config.json', json.dumps(saved, indent=2), 0o644)
        install_units(config, account, saved)
        run(['docker', 'pull', RUSTFS_IMAGE], timeout=900)
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'enable', STORAGE, SERVICE])
        run(['systemctl', 'restart' if STORAGE in saved['pending_restarts'] else 'start', STORAGE])
        wait_http(f'http://127.0.0.1:{config["storage_port"]}/health')
        ensure_bucket(config, keys)
        restart_completed(STORAGE, saved)
        environment = {'PATH': f'{ROOT}/bin:{ROOT}/node/bin:{release}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
                       'HOME': str(DATA), 'LANG': 'C.UTF-8',
                       'AWS_ACCESS_KEY_ID': keys['access_key'], 'AWS_SECRET_ACCESS_KEY': keys['secret_key'],
                       'AWS_REGION': 'us-east-1', 'DOCKER_HOST': 'unix:///var/run/docker.sock',
                       'CELLD_CONTAINER_PLATFORM': 'linux/amd64', 'DOCKER_BUILDKIT': '0'}
        run(['runuser', '-u', USER, '--', ROOT / 'bin/celld', 'deploy', release / 'wrangler.install.jsonc',
             '--bucket', f's3://{BUCKET}', '--endpoint', f'http://127.0.0.1:{config["storage_port"]}', '--json'],
            cwd=release, env=environment, timeout=3600)
        run(['systemctl', 'restart' if SERVICE in saved['pending_restarts'] else 'start', SERVICE])
        url = f'http://127.0.0.1:{config["port"]}'
        wait_http(url + '/', b'<html')
        wait_http(url + '/api/sessions', b'[')
        restart_completed(SERVICE, saved)
        saved.update(state='ready-local', url=url)
        atomic_write(CONFIG / 'config.json', json.dumps(saved, indent=2), 0o644)
        if sandbox_dns_probe() is False:
            raise Failure('Application installed locally, but a sandbox on the celld network cannot resolve github.com.', 3,
                          'Sessions cannot clone repositories until Docker gives containers a public resolver. '
                          f'Check "dns" in {DOCKER_DAEMON_JSON}, run sudo systemctl restart docker, then sudo pids doctor --json.')
        if config['access'] == 'tailscale':
            url = configure_tailscale(config)
        saved.update(state='ready', url=url)
        atomic_write(CONFIG / 'config.json', json.dumps(saved, indent=2), 0o644)
    return {'ok': True, 'url': url, 'revision': revision, 'warnings': WARNINGS,
            'next': 'Open the URL and configure a model provider. Restrict access with tailnet grants.'}


def inspect(args):
    status = tailscale_status()
    # Current clients may also include a top-level alias. Use the node's own
    # addresses, falling back for older status schemas.
    ips = status.get('Self', {}).get('TailscaleIPs', status.get('TailscaleIPs', []))
    result = {'host': host_info(), 'installation': read_json(CONFIG / 'config.json', {}),
              'tailscale': {'state': status.get('BackendState'),
                            'hostname': status.get('Self', {}).get('DNSName', '').rstrip('.'),
                            'ips': ips}, 'warnings': WARNINGS}
    if args.domain:
        if not re.fullmatch(r'(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}', args.domain):
            raise Failure('Supply a DNS hostname, without a scheme, port, path, or wildcard.', 2)
        result['dns_plan'] = {'domain': args.domain, 'access': 'tailnet-only', 'proxied': False,
                             'records': [{'type': 'AAAA' if ':' in ip else 'A', 'name': args.domain, 'content': ip}
                                         for ip in ips],
                             'applied': False, 'custom_domain_serving_supported': False,
                             'next': 'DNS alone is insufficient. Custom-domain TLS and preview routing are a follow-up; use the ts.net URL now.'}
    return result


def doctor():
    config = read_json(CONFIG / 'config.json')
    if not config:
        raise Failure('Not installed.', 3, 'Run install.sh or pids setup from a checkout.')
    url = f'http://127.0.0.1:{config["port"]}'
    checks = {SERVICE: is_active(SERVICE), STORAGE: is_active(STORAGE),
              'ui': http_ok(url + '/', b'<html'), 'api': http_ok(url + '/api/sessions', b'['),
              'storage': http_ok(f'http://127.0.0.1:{config["storage_port"]}/health')}
    try:
        probe = sandbox_dns_probe()
    except Failure:
        probe = False
    if probe is not None:
        checks['sandbox_dns'] = probe
    if config['access'] == 'tailscale':
        status = tailscale_status()
        checks['tailscale'] = status.get('BackendState') == 'Running'
        try:
            hostname = status.get('Self', {}).get('DNSName', '').rstrip('.')
            checks['private_https_route'] = checks['tailscale'] and recorded_serve(hostname, config['port']) and serve_owned(
                serve_config(), hostname, config['port'])
        except Failure:
            checks['private_https_route'] = False
    return {'ok': all(checks.values()), 'checks': checks, 'url': config.get('url', url),
            'install_state': config.get('state'), 'warnings': WARNINGS,
            'remote_verification': 'From another tailnet client, open the URL and test chat and Terminal.'}


def uninstall(args):
    require_root()
    consent(args)
    with install_lock():
        config = read_json(CONFIG / 'config.json')
        if not config:
            raise Failure('No managed installation found; nothing removed.', 2)
        if config.get('state') == 'uninstalled-data-preserved':
            return {'ok': True, 'preserved': [str(DATA), str(CONFIG), str(ROOT)],
                    'note': 'Already uninstalled. Data and credentials remain preserved.'}
        if config['access'] == 'tailscale' and shutil.which('tailscale'):
            status = tailscale_status()
            hostname = status.get('Self', {}).get('DNSName', '').rstrip('.')
            current = serve_config()
            if recorded_serve(hostname, config['port']) and serve_owned(current, hostname, config['port']):
                run(['tailscale', 'serve', '--yes', '--https=443', 'off'], timeout=30)
            elif '443' in current.get('TCP', {}):
                raise Failure('Serve configuration has changed; refusing to remove someone else\'s route.', 3)
        for service in (SERVICE, STORAGE):
            path = UNITS / f'{service}.service'
            if path.exists():
                run(['systemctl', 'disable', '--now', service])
                path.unlink()
            else:
                state = run(['systemctl', 'show', '--property=LoadState', '--value', service], capture=True, check=False)
                if state.stdout.strip() != 'not-found':
                    raise Failure(f'Cannot establish that missing managed unit {service} is absent; no further removal performed.', 3)
        (CONFIG / 'serve.json').unlink(missing_ok=True)
        run(['systemctl', 'daemon-reload'])
        config['state'] = 'uninstalled-data-preserved'
        atomic_write(CONFIG / 'config.json', json.dumps(config, indent=2), 0o644)
    return {'ok': True, 'preserved': [str(DATA), str(CONFIG), str(ROOT)],
            'note': 'Services removed. Data, credentials, manager and dependencies retained for reinstall. No data purge was performed.'}


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise Failure(message, 2, f'Run {self.prog} --help for arguments and examples.')


def parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--json', action='store_true', help='Stable JSON stdout (default when stdout is not a TTY)')
    root = ArgumentParser(description=__doc__, epilog='Examples: pids inspect --json; pids setup --access tailscale --dry-run --json; sudo pids doctor --json')
    commands = root.add_subparsers(dest='command', required=True)
    info = commands.add_parser('inspect', parents=[common], help='Read host, installation and Tailscale facts without mutations')
    info.add_argument('--domain', help='Report DNS records for a custom domain; does not configure DNS/TLS')
    setup_parser = commands.add_parser('setup', parents=[common], help='Install, repair or deploy an explicit source checkout')
    setup_parser.add_argument('--source', help='Path to pi-durable-sessions (defaults to this checkout or installed release)')
    setup_parser.add_argument('--config', help='JSON file: access, port, storage_port')
    setup_parser.add_argument('--access', choices=['local', 'tailscale'])
    setup_parser.add_argument('--port', type=int)
    setup_parser.add_argument('--storage-port', type=int)
    setup_parser.add_argument('--dry-run', action='store_true', help='Plan only: no packages, files, services or downloads changed')
    for sub in (setup_parser, commands.add_parser('uninstall', parents=[common], help='Remove services and own Serve route; preserve ALL data')):
        sub.add_argument('--yes', action='store_true', help='Approve host changes')
        sub.add_argument('--no-input', action='store_true', help='Never prompt; fail with actionable missing-input errors')
    commands.add_parser('doctor', parents=[common], help='Bounded health checks; exit 3 if unhealthy')
    commands.add_parser('start', parents=[common], help='Start installed services')
    commands.add_parser('stop', parents=[common], help='Stop services (sandbox workspaces may be lost)')
    logs = commands.add_parser('logs', parents=[common], help='Read bounded journal logs')
    logs.add_argument('--lines', type=int, default=100)
    return root


def main():
    as_json = '--json' in sys.argv or not sys.stdout.isatty()
    try:
        args = parser().parse_args()
        if args.command == 'setup':
            result = setup(args)
        elif args.command == 'inspect':
            result = inspect(args)
        elif args.command == 'doctor':
            result = doctor()
        elif args.command == 'uninstall':
            result = uninstall(args)
        elif args.command in ('start', 'stop'):
            require_root()
            with install_lock():
                if not read_json(CONFIG / 'config.json'):
                    raise Failure('No managed installation found.', 2)
                services = [STORAGE, SERVICE] if args.command == 'start' else [SERVICE, STORAGE]
                for service in services:
                    run(['systemctl', args.command, service])
            result = {'ok': True, 'action': args.command, 'warnings': WARNINGS if args.command == 'stop' else []}
        else:
            if not 1 <= args.lines <= 1000:
                raise Failure('--lines must be between 1 and 1000.', 2)
            logs = run(['journalctl', '-u', SERVICE, '-u', STORAGE, '--no-pager', '-n', str(args.lines), '-o', 'cat'], capture=True)
            result = {'lines': logs.stdout.splitlines()}
        output(result, as_json)
        return 0 if result.get('ok', True) else 3
    except (Failure, OSError, urllib.error.URLError, ValueError) as exc:
        output({'ok': False, 'error': str(exc), 'action': getattr(exc, 'action', None)}, as_json)
        return getattr(exc, 'code', 1) if isinstance(getattr(exc, 'code', 1), int) and 0 < getattr(exc, 'code', 1) < 126 else 1


if __name__ == '__main__':
    sys.exit(main())
