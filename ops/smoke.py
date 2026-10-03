#!/usr/bin/env python3
"""Isolated live storage + deployment + HTTP smoke. Never installs host services.
Requires local Docker, celld 0.6.1, esbuild, npm ci, and npm --prefix ui run build.
Usage: python3 ops/smoke.py --celld /path/to/celld-0.6.1
Does not start a model turn or test a sandbox PTY/systemd/Tailscale.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid

import pids


def smoke(binary):
    source = Path(__file__).resolve().parent.parent
    if not (source / 'ui/dist/index.html').exists() or not (source / 'node_modules').exists():
        raise SystemExit('First run npm ci && npm --prefix ui ci && npm --prefix ui run build.')
    name = 'pids-smoke-' + uuid.uuid4().hex[:12]
    node = None
    with tempfile.TemporaryDirectory(prefix='pids-smoke-') as tmp:
        project = Path(tmp)
        try:
            for path in pids.source_files(source):
                target = project / path.relative_to(source)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, target)
            shutil.copytree(source / 'ui/dist', project / 'ui/dist')
            (project / 'node_modules').symlink_to(source / 'node_modules')
            assets = {'assets': {'directory': './ui/dist', 'binding': 'ASSETS', 'run_worker_first': True,
                                 'not_found_handling': 'single-page-application'}}
            config = (project / 'wrangler.jsonc').read_text().replace('{', '{' + json.dumps(assets)[1:-1] + ',', 1)
            (project / 'wrangler.jsonc').write_text(config)
            (project / '.dockerignore').write_text('node_modules\nui\n.git\n')
            keys = {'access_key': uuid.uuid4().hex, 'secret_key': uuid.uuid4().hex + uuid.uuid4().hex}
            env_file = project / 'storage.env'
            pids.atomic_write(env_file, f'RUSTFS_ACCESS_KEY={keys["access_key"]}\nRUSTFS_SECRET_KEY={keys["secret_key"]}\nRUSTFS_CONSOLE_ENABLE=false\n')
            pids.run(['docker', 'run', '-d', '--name', name, '--publish', '127.0.0.1::9000',
                      '--env-file', env_file, pids.RUSTFS_IMAGE], timeout=300)
            address = pids.run(['docker', 'port', name, '9000'], capture=True).stdout.strip()
            settings = {'storage_port': int(address.rsplit(':', 1)[1])}
            endpoint = f'http://127.0.0.1:{settings["storage_port"]}'
            pids.wait_http(endpoint + '/health')
            pids.ensure_bucket(settings, keys)
            pids.ensure_bucket(settings, keys)
            env = {**os.environ, 'AWS_ACCESS_KEY_ID': keys['access_key'], 'AWS_SECRET_ACCESS_KEY': keys['secret_key'],
                   'AWS_REGION': 'us-east-1', 'CELLD_WATCH': str(project / 'watch'),
                   'CELLD_ASSET_CACHE_DIR': str(project / 'cache'), 'CELLD_TTL_MS': '30000',
                   'CELLD_FETCH_TIMEOUT_S': '3600', 'PATH': str(source / 'node_modules/.bin') + ':' + os.environ['PATH']}
            env.pop('AWS_SESSION_TOKEN', None)
            pids.run([binary, 'deploy', project, '--bucket', f's3://{pids.BUCKET}', '--endpoint', endpoint], env=env, timeout=1800)
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            base = f'http://127.0.0.1:{port}'
            with (project / 'node.log').open('w+') as log:
                node = subprocess.Popen([binary, '--bucket', f's3://{pids.BUCKET}', '--endpoint', endpoint,
                                         '--listen', f'127.0.0.1:{port}'], env=env, stdout=log, stderr=log)
                try:
                    pids.wait_http(base + '/', b'<html')
                    pids.wait_http(base + '/api/sessions', b'[')
                    with urllib.request.urlopen(base, timeout=10) as response:
                        html = response.read().decode()
                    asset = re.search(r'src="(/assets/[^\"]+\.js)"', html).group(1)
                    with urllib.request.urlopen(base + asset, timeout=10) as response:
                        assert len(response.read()) > 100_000
                        assert 'javascript' in response.headers['content-type']
                    try:
                        urllib.request.urlopen(base + '/api/not-a-route', timeout=10)
                    except urllib.error.HTTPError as error:
                        assert error.code == 404 and json.load(error)['error'] == 'unknown route'
                    else:
                        raise AssertionError('API misses must not serve the SPA')
                    print(json.dumps({'ok': True, 'checks': ['signed bucket create/rerun', 'deploy worker + sandbox image + assets',
                                                            'UI HTML', 'hashed JavaScript asset', 'API', 'API 404']}))
                except Exception:
                    log.seek(0)
                    print(log.read()[-12000:], file=sys.stderr)
                    raise
        finally:
            if node is not None:
                node.terminate()
                try:
                    node.wait(timeout=90)
                except subprocess.TimeoutExpired:
                    node.kill()
                    node.wait(timeout=10)
            pids.run(['docker', 'rm', '-f', '-v', name], check=False, capture=True, timeout=60)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--celld', default=shutil.which('celld-0.6.1') or shutil.which('celld'))
    args = parser.parse_args()
    if not args.celld:
        parser.error('Supply --celld /path/to/celld-0.6.1')
    smoke(args.celld)
