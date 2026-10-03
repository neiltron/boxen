"""Offline installer checks: python3 -m unittest discover -s ops -v."""
import contextlib
import io
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import urllib.error

import pids


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        for name in ('ROOT', 'CONFIG', 'DATA', 'UNITS'):
            self.stack.enter_context(patch.object(pids, name, self.base / name.lower()))
        self.stack.enter_context(patch.object(pids, 'LAUNCHER', self.base / 'bin/pids'))
        self.config = {'access': 'local', 'port': 18093, 'storage_port': 19000}
        self.host = {'os': 'Linux', 'architecture': 'x86_64', 'distribution': 'arch',
                     'version': '', 'systemd': True}

    def args(self, *extra):
        return pids.parser().parse_args(['setup', '--no-input', *extra])

    def source(self):
        root = self.base / 'source'
        root.mkdir(exist_ok=True)
        for name in pids.SOURCE_FILES:
            (root / name).write_text('{}')
        for name in pids.SOURCE_DIRS:
            (root / name).mkdir(exist_ok=True)
            (root / name / 'example.txt').write_text(name)
        return root

    def test_supported_hosts(self):
        for distro, version in [('arch', ''), ('omarchy', '3.0.0'), ('ubuntu', '22.04'), ('ubuntu', '24.04'), ('debian', '12')]:
            pids.validate_host({**self.host, 'distribution': distro, 'version': version})

    def test_omarchy_uses_pacman_not_apt(self):
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            return types.SimpleNamespace(returncode=0, stdout=json.dumps([
                {'Endpoints': {'docker': {'Host': 'unix:///var/run/docker.sock'}}}]))
        with patch.object(pids, 'run', side_effect=run), patch.object(pids.shutil, 'which', return_value=None):
            pids.install_packages({**self.host, 'distribution': 'omarchy'})
        self.assertEqual(calls[0][:4], ['pacman', '-S', '--needed', '--noconfirm'])
        self.assertIn('docker', calls[0])
        self.assertFalse(any(args[0] == 'apt-get' for args in calls))

    def test_unsupported_hosts(self):
        for changes in [{'os': 'Darwin'}, {'architecture': 'aarch64'}, {'systemd': False},
                        {'distribution': 'amzn'}, {'distribution': 'ubuntu', 'version': '20.04'}]:
            with self.subTest(changes=changes), self.assertRaises(pids.Failure):
                pids.validate_host({**self.host, **changes})

    def test_settings_defaults_and_required_access(self):
        with self.assertRaisesRegex(pids.Failure, 'Choose --access'):
            pids.settings(self.args(), {})
        result = pids.settings(self.args('--access', 'tailscale'), {})
        self.assertEqual(result, {'access': 'tailscale', 'port': 8093, 'storage_port': 19000})

    def test_explicit_missing_config_fails_even_with_access_or_previous_settings(self):
        path = self.base / 'missing.json'
        for previous in ({}, self.config):
            with self.subTest(previous=previous), self.assertRaises(pids.Failure) as caught:
                pids.settings(self.args('--config', str(path), '--access', 'local'), previous)
            self.assertEqual(caught.exception.code, 2)
            self.assertIn(str(path), str(caught.exception))
        self.assertFalse(pids.CONFIG.exists())

    def test_config_validation_precedes_mutation(self):
        for value in [{'access': 'public'}, {'port': True}, {'port': 22}, {'port': 65536},
                      {'port': 19000}, {'unknown': 'flag'}, ['local']]:
            path = self.base / 'config.json'
            path.write_text(json.dumps(value))
            with self.subTest(value=value), self.assertRaises(pids.Failure):
                pids.settings(self.args('--config', str(path)), self.config)
        self.assertFalse(pids.CONFIG.exists())

    def test_existing_settings_are_preserved_and_not_silently_changed(self):
        self.assertEqual(pids.settings(self.args(), self.config), self.config)
        with self.assertRaisesRegex(pids.Failure, 'already'):
            pids.settings(self.args('--port', '18094'), self.config)

    def test_dry_run_has_no_side_effects_on_unsupported_host(self):
        source = self.source()
        args = self.args('--source', str(source), '--access', 'tailscale', '--dry-run')
        with patch.object(pids, 'host_info', return_value={**self.host, 'os': 'Darwin'}):
            plan = pids.setup(args)
        self.assertFalse(plan['supported_host'])
        self.assertFalse(plan['public_ingress_required'])
        self.assertFalse(pids.CONFIG.exists())
        self.assertFalse(pids.ROOT.exists())

    def test_noninteractive_approval_never_reads_input(self):
        args = self.args('--access', 'local')
        with patch('builtins.input', side_effect=AssertionError('must not prompt')):
            with self.assertRaisesRegex(pids.Failure, 'Approval required'):
                pids.consent(args)
            args.yes = True
            pids.consent(args)

    def test_source_hash_excludes_secrets_dependencies_and_builds(self):
        source = self.source()
        before = pids.source_revision(source)
        for name in ('ui/node_modules/lib', 'ui/dist/app.js', 'ui/.env.local', 'ops/__pycache__/cache'):
            path = source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('not a source file')
        self.assertEqual(before, pids.source_revision(source))
        (source / 'src/example.txt').write_text('changed')
        self.assertNotEqual(before, pids.source_revision(source))

    def test_source_symlink_rejected(self):
        source = self.source()
        (source / 'src/link').symlink_to('/etc/passwd')
        with self.assertRaisesRegex(pids.Failure, 'Symlinks'):
            pids.source_revision(source)

    def test_atomic_write_permissions_and_replace(self):
        path = self.base / 'secret'
        pids.atomic_write(path, 'one')
        pids.atomic_write(path, 'two')
        self.assertEqual(path.read_text(), 'two')
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual([p.name for p in self.base.iterdir()], ['secret'])

    def test_credentials_are_random_private_and_stable_on_rerun(self):
        (pids.DATA / 'rustfs').mkdir(parents=True)
        first = pids.credentials(self.config)
        self.assertEqual(first, pids.credentials(self.config))
        self.assertGreaterEqual(len(first['secret_key']), 64)
        for name in ('credentials.json', 'celld.env', 'storage.env'):
            self.assertEqual(stat.S_IMODE((pids.CONFIG / name).stat().st_mode), 0o600)
        self.assertNotIn(first['secret_key'], json.dumps(pids.install_plan(self.config, self.host, 'revision')))

    def test_missing_credentials_never_rotate_existing_storage(self):
        directory = pids.DATA / 'rustfs'
        directory.mkdir(parents=True)
        (directory / 'existing-object').touch()
        with self.assertRaisesRegex(pids.Failure, 'Restore credentials'):
            pids.credentials(self.config)
        self.assertFalse((pids.CONFIG / 'credentials.json').exists())

    def test_install_lock_rejects_concurrent_mutations(self):
        with pids.install_lock():
            with self.assertRaisesRegex(pids.Failure, 'in progress'):
                with pids.install_lock():
                    pass
        with pids.install_lock():
            pass

    def test_units_bind_loopback_and_drop_application_privileges(self):
        account = types.SimpleNamespace(pw_uid=123, pw_gid=123)
        units = pids.units(self.config, account)
        self.assertIn('127.0.0.1:19000:9000', units[pids.STORAGE])
        self.assertIn('User=pids', units[pids.SERVICE])
        self.assertIn('--listen 127.0.0.1:18093', units[pids.SERVICE])
        self.assertIn('TimeoutStopSec=90', units[pids.SERVICE])
        for unit in units.values():
            self.assertIn('PartOf=docker.service', unit)
            self.assertIn('WantedBy=multi-user.target docker.service', unit)
        self.assertNotIn('swarmsecret', str(units))
        self.assertNotIn('--privileged', str(units))

    def test_bound_port_detected(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
            self.assertFalse(pids.port_available(port))
            with patch.object(pids, 'is_active', return_value=False):
                with self.assertRaisesRegex(pids.Failure, 'occupied'):
                    pids.preflight_ports({**self.config, 'port': port})

    def test_download_checksum_failure(self):
        path = self.base / 'download'
        path.write_bytes(b'corrupted')
        with patch.object(pids, 'run'):
            with self.assertRaisesRegex(pids.Failure, 'Checksum mismatch'):
                pids.download('https://example.test/file', path, '0' * 64)

    def test_serve_ownership_requires_exact_root_private_proxy(self):
        hostname = 'machine.example.ts.net'
        current = {'TCP': {'443': {'HTTPS': True}}, 'Web': {
            f'{hostname}:443': {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:18093'}}}}}
        self.assertTrue(pids.serve_owned(current, hostname, 18093))
        self.assertFalse(pids.serve_owned(current, hostname, 8093))
        self.assertFalse(pids.serve_owned({**current, 'AllowFunnel': {f'{hostname}:443': True}}, hostname, 18093))
        current['Web'][f'{hostname}:443']['Handlers']['/other'] = {'Proxy': 'http://localhost:3000'}
        self.assertFalse(pids.serve_owned(current, hostname, 18093))

    def test_tailscale_conflict_does_not_mutate_serve(self):
        calls = []
        with patch.object(pids.shutil, 'which', return_value='/usr/bin/tailscale'), \
             patch.object(pids, 'run', side_effect=lambda args, **kw: calls.append(args)), \
             patch.object(pids, 'tailscale_status', return_value={'BackendState': 'Running', 'Self': {'DNSName': 'host.tail.ts.net.'}}), \
             patch.object(pids, 'serve_config', return_value={'TCP': {'443': {'HTTPS': True}}}):
            with self.assertRaisesRegex(pids.Failure, 'conflicts'):
                pids.configure_tailscale(self.config)
        self.assertEqual(calls, [])

    def test_tailscale_serve_is_noninteractive_after_approval(self):
        calls = []
        current = {'TCP': {'443': {'HTTPS': True}}, 'Web': {'host.tail.ts.net:443':
                  {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:18093'}}}}}
        with patch.object(pids.shutil, 'which', return_value='/usr/bin/tailscale'), \
             patch.object(pids, 'run', side_effect=lambda args, **kw: calls.append(args)), \
             patch.object(pids, 'tailscale_status', return_value={'BackendState': 'Running', 'Self': {'DNSName': 'host.tail.ts.net.'}}), \
             patch.object(pids, 'serve_config', side_effect=[{}, current]):
            self.assertEqual(pids.configure_tailscale(self.config), 'https://host.tail.ts.net')
        self.assertEqual(calls[-1], ['tailscale', 'serve', '--yes', '--bg', '--https=443', 'http://127.0.0.1:18093'])

    def test_tailscale_https_approval_failure_returns_external_action(self):
        def run(args, **kw):
            if args[0] == 'tailscale':
                raise pids.Failure('approval needed')
        with patch.object(pids.shutil, 'which', return_value='/usr/bin/tailscale'), \
             patch.object(pids, 'run', side_effect=run), \
             patch.object(pids, 'tailscale_status', return_value={'BackendState': 'Running', 'Self': {'DNSName': 'host.tail.ts.net.'}}), \
             patch.object(pids, 'serve_config', return_value={}):
            with self.assertRaises(pids.Failure) as caught:
                pids.configure_tailscale(self.config)
        self.assertEqual(caught.exception.code, 3)
        self.assertIn('HTTPS certificates', caught.exception.action)

    def test_tailscale_login_returns_action_not_a_hanging_prompt(self):
        with patch.object(pids.shutil, 'which', return_value='/usr/bin/tailscale'), patch.object(pids, 'run'), \
             patch.object(pids, 'tailscale_status', return_value={'BackendState': 'NeedsLogin'}):
            with self.assertRaises(pids.Failure) as caught:
                pids.configure_tailscale(self.config)
        self.assertEqual(caught.exception.code, 3)
        self.assertIn('tailscale up', caught.exception.action)

    def test_bucket_forbidden_is_not_treated_as_missing(self):
        error = urllib.error.HTTPError('http://localhost', 403, 'Forbidden', {}, None)
        with patch.object(pids.urllib.request, 'urlopen', side_effect=error) as request:
            with self.assertRaisesRegex(pids.Failure, '403'):
                pids.ensure_bucket(self.config, {'access_key': 'test', 'secret_key': 'test'})
        self.assertEqual(request.call_count, 1)

    def test_bucket_retries_transient_startup_then_creates(self):
        error = urllib.error.HTTPError('http://localhost', 503, 'Starting', {}, None)
        missing = urllib.error.HTTPError('http://localhost', 404, 'Missing', {}, None)
        with patch.object(pids.urllib.request, 'urlopen', side_effect=[error, missing, contextlib.nullcontext()]) as request, \
             patch.object(pids.time, 'sleep'):
            pids.ensure_bucket(self.config, {'access_key': 'test', 'secret_key': 'test'})
        self.assertEqual([call.args[0].method for call in request.call_args_list], ['HEAD', 'HEAD', 'PUT'])

    def test_bucket_retry_has_a_deadline(self):
        error = urllib.error.HTTPError('http://localhost', 503, 'Starting', {}, None)
        with patch.object(pids.urllib.request, 'urlopen', side_effect=error), \
             patch.object(pids.time, 'monotonic', side_effect=[0, 0, 121]), patch.object(pids.time, 'sleep'):
            with self.assertRaisesRegex(pids.Failure, 'did not become ready'):
                pids.ensure_bucket(self.config, {'access_key': 'test', 'secret_key': 'test'})

    def test_s3_credentials_are_only_in_authorization_header(self):
        req = pids.s3_request(self.config, {'access_key': 'access', 'secret_key': 'secret'}, 'PUT', '/pid-cells')
        self.assertEqual(req.full_url, 'http://127.0.0.1:19000/pid-cells')
        self.assertIn('Credential=access/', req.headers['Authorization'])
        self.assertNotIn('secret', str(req.headers))
        self.assertEqual(req.data, b'')

    def test_local_uninstall_preserves_data_credentials_without_tailscale_calls(self):
        pids.atomic_write(pids.CONFIG / 'config.json', json.dumps(self.config))
        pids.atomic_write(pids.CONFIG / 'credentials.json', 'credentials')
        pids.atomic_write(pids.DATA / 'rustfs/object', 'durable state')
        for name in (pids.SERVICE, pids.STORAGE):
            pids.atomic_write(pids.UNITS / f'{name}.service', 'managed')
        args = pids.parser().parse_args(['uninstall', '--yes', '--no-input'])
        with patch.object(pids, 'require_root'), patch.object(pids, 'run') as run:
            result = pids.uninstall(args)
        self.assertTrue(result['ok'])
        self.assertEqual((pids.DATA / 'rustfs/object').read_text(), 'durable state')
        self.assertEqual((pids.CONFIG / 'credentials.json').read_text(), 'credentials')
        self.assertFalse((pids.UNITS / f'{pids.SERVICE}.service').exists())
        self.assertFalse(any(call.args[0][0] == 'tailscale' for call in run.call_args_list))

    def test_uninstall_partial_install_tolerates_confirmed_absent_units(self):
        pids.atomic_write(pids.CONFIG / 'config.json', json.dumps({**self.config, 'state': 'installing'}))
        args = pids.parser().parse_args(['uninstall', '--yes', '--no-input'])
        with patch.object(pids, 'require_root'), patch.object(pids, 'run', return_value=types.SimpleNamespace(stdout='not-found\n')) as run:
            result = pids.uninstall(args)
        self.assertTrue(result['ok'])
        self.assertFalse(any(call.args[0][1] == 'disable' for call in run.call_args_list))

    def test_runtime_directories_are_traversable_under_restrictive_umask(self):
        previous = os.umask(0o077)
        try:
            pids.runtime_directories()
            for path in (pids.ROOT, pids.ROOT / 'bin', pids.ROOT / 'manager', pids.ROOT / 'releases'):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o755)
            pids.atomic_write(pids.CONFIG / 'secret', 'private')
            with pids.install_lock():
                self.assertEqual(stat.S_IMODE(pids.CONFIG.stat().st_mode), 0o755)
            self.assertEqual(stat.S_IMODE((pids.CONFIG / 'secret').stat().st_mode), 0o600)
        finally:
            os.umask(previous)

    def test_pending_restarts_survive_identical_unit_files_on_retry(self):
        account = types.SimpleNamespace(pw_uid=123, pw_gid=123)
        saved = dict(self.config)
        pids.install_units(self.config, account, saved)
        retried = pids.read_json(pids.CONFIG / 'config.json')
        pids.install_units(self.config, account, retried)
        self.assertEqual(set(retried['pending_restarts']), {pids.SERVICE, pids.STORAGE})
        pids.restart_completed(pids.STORAGE, retried)
        self.assertEqual(pids.read_json(pids.CONFIG / 'config.json')['pending_restarts'], [pids.SERVICE])
        pids.restart_completed(pids.SERVICE, retried)
        self.assertEqual(pids.read_json(pids.CONFIG / 'config.json')['pending_restarts'], [])

    def test_funnel_preflight_blocks_local_and_tailscale_access(self):
        for access in ('local', 'tailscale'):
            with self.subTest(access=access), patch.object(pids.shutil, 'which', return_value='/usr/bin/tailscale'), \
                 patch.object(pids, 'serve_config', return_value={'AllowFunnel': {'host.tail.ts.net:443': True}}):
                with self.assertRaisesRegex(pids.Failure, 'Funnel detected'):
                    pids.preflight_exposure({**self.config, 'access': access})

    def test_exposure_preflight_runs_before_package_or_service_changes(self):
        source = self.source()
        args = self.args('--source', str(source), '--access', 'local', '--yes')
        with patch.object(pids, 'host_info', return_value=self.host), patch.object(pids, 'require_root'), \
             patch.object(pids, 'preflight_ports'), patch.object(pids, 'preflight_exposure', side_effect=pids.Failure('unsafe exposure')), \
             patch.object(pids, 'install_packages') as packages, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(pids.Failure, 'unsafe exposure'):
                pids.setup(args)
        packages.assert_not_called()
        self.assertFalse(pids.ROOT.exists())

    def test_matching_serve_route_cannot_be_silently_adopted(self):
        current = {'TCP': {'443': {'HTTPS': True}}, 'Web': {'host.tail.ts.net:443':
                   {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:18093'}}}}}
        status = {'BackendState': 'Running', 'Self': {'DNSName': 'host.tail.ts.net.'}}
        with patch.object(pids.shutil, 'which', return_value='/usr/bin/tailscale'), \
             patch.object(pids, 'tailscale_status', return_value=status), patch.object(pids, 'serve_config', return_value=current):
            with self.assertRaisesRegex(pids.Failure, 'unowned'):
                pids.preflight_exposure(self.config)
            with self.assertRaisesRegex(pids.Failure, 'conflicts'):
                pids.configure_tailscale(self.config)
            pids.atomic_write(pids.CONFIG / 'serve.json', json.dumps({'hostname': 'host.tail.ts.net', 'port': 18093, 'state': 'pending'}))
            pids.preflight_exposure(self.config)  # Retrying an interrupted owned apply is safe.

    def test_captured_docker_failure_has_safe_bootstrap_diagnostics(self):
        result = types.SimpleNamespace(returncode=1, stdout='', stderr='sensitive details')
        with patch.object(pids.subprocess, 'run', return_value=result):
            with self.assertRaises(pids.Failure) as caught:
                pids.run(['docker', 'info'], capture=True)
        self.assertIn('sudo docker info', caught.exception.action)
        self.assertNotIn('sensitive details', str(caught.exception))

    def test_uninstall_rerun_is_a_noop(self):
        pids.atomic_write(pids.CONFIG / 'config.json', json.dumps({**self.config, 'state': 'uninstalled-data-preserved'}))
        args = pids.parser().parse_args(['uninstall', '--yes', '--no-input'])
        with patch.object(pids, 'require_root'), patch.object(pids, 'run') as run:
            result = pids.uninstall(args)
        self.assertTrue(result['ok'])
        run.assert_not_called()

    def tailscale_uninstall_fixture(self):
        config = {**self.config, 'access': 'tailscale'}
        pids.atomic_write(pids.CONFIG / 'config.json', json.dumps(config))
        pids.atomic_write(pids.CONFIG / 'credentials.json', 'credentials')
        pids.atomic_write(pids.DATA / 'rustfs/object', 'durable state')
        for name in (pids.SERVICE, pids.STORAGE):
            pids.atomic_write(pids.UNITS / f'{name}.service', 'managed')
        self.stack.enter_context(patch.object(pids, 'require_root'))
        self.stack.enter_context(patch.object(pids.shutil, 'which', return_value='/usr/bin/tailscale'))
        status = {'BackendState': 'Running', 'Self': {'DNSName': 'host.tail.ts.net.'}}
        pids.atomic_write(pids.CONFIG / 'serve.json', json.dumps({'hostname': 'host.tail.ts.net', 'port': 18093, 'state': 'active'}))
        current = {'TCP': {'443': {'HTTPS': True}, '8443': {'HTTPS': True}}, 'Web': {
            'host.tail.ts.net:443': {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:18093'}}},
            'host.tail.ts.net:8443': {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:3000'}}}}}
        args = pids.parser().parse_args(['uninstall', '--yes', '--no-input'])
        return args, status, current

    def test_tailscale_uninstall_removes_only_owned_443_route(self):
        args, status, current = self.tailscale_uninstall_fixture()
        unrelated = json.loads(json.dumps(current['Web']['host.tail.ts.net:8443']))
        with patch.object(pids, 'tailscale_status', return_value=status), \
             patch.object(pids, 'serve_config', return_value=current), patch.object(pids, 'run') as run:
            result = pids.uninstall(args)
        self.assertTrue(result['ok'])
        # Only the port-scoped removal is allowed, never a global Serve reset.
        self.assertEqual([call.args[0] for call in run.call_args_list], [
            ['tailscale', 'serve', '--yes', '--https=443', 'off'],
            ['systemctl', 'disable', '--now', pids.SERVICE],
            ['systemctl', 'disable', '--now', pids.STORAGE],
            ['systemctl', 'daemon-reload'],
        ])
        self.assertEqual(current['Web']['host.tail.ts.net:8443'], unrelated)
        self.assertEqual(current['TCP']['8443'], {'HTTPS': True})
        self.assertEqual((pids.DATA / 'rustfs/object').read_text(), 'durable state')
        self.assertEqual((pids.CONFIG / 'credentials.json').read_text(), 'credentials')
        for name in (pids.SERVICE, pids.STORAGE):
            self.assertFalse((pids.UNITS / f'{name}.service').exists())

    def test_tailscale_uninstall_conflict_leaves_routes_and_services_untouched(self):
        args, status, current = self.tailscale_uninstall_fixture()
        handlers = current['Web']['host.tail.ts.net:443']['Handlers']
        handlers['/other'] = {'Proxy': 'http://127.0.0.1:3001'}
        before = json.dumps(current, sort_keys=True)
        config_before = (pids.CONFIG / 'config.json').read_text()
        with patch.object(pids, 'tailscale_status', return_value=status), \
             patch.object(pids, 'serve_config', return_value=current), patch.object(pids, 'run') as run:
            with self.assertRaisesRegex(pids.Failure, 'refusing to remove') as caught:
                pids.uninstall(args)
        self.assertEqual(caught.exception.code, 3)
        run.assert_not_called()
        self.assertEqual(json.dumps(current, sort_keys=True), before)
        self.assertEqual((pids.CONFIG / 'config.json').read_text(), config_before)
        for name in (pids.SERVICE, pids.STORAGE):
            self.assertEqual((pids.UNITS / f'{name}.service').read_text(), 'managed')

    def test_tailscale_uninstall_unavailable_status_makes_no_destructive_calls(self):
        args, status, current = self.tailscale_uninstall_fixture()
        config_before = (pids.CONFIG / 'config.json').read_text()
        for state, result in [
            (status, types.SimpleNamespace(returncode=1, stdout='')),
            (status, types.SimpleNamespace(returncode=0, stdout='invalid json')),
            ({'BackendState': 'Unavailable'}, types.SimpleNamespace(returncode=0, stdout=json.dumps(current))),
        ]:
            with self.subTest(state=state, result=result), \
                 patch.object(pids, 'tailscale_status', return_value=state), \
                 patch.object(pids, 'run', return_value=result) as run:
                with self.assertRaises(pids.Failure) as caught:
                    pids.uninstall(args)
                self.assertEqual(caught.exception.code, 3)
                run.assert_called_once_with(
                    ['tailscale', 'serve', 'status', '--json'], capture=True, check=False, timeout=15)
            self.assertEqual((pids.CONFIG / 'config.json').read_text(), config_before)
            for name in (pids.SERVICE, pids.STORAGE):
                self.assertEqual((pids.UNITS / f'{name}.service').read_text(), 'managed')

    def test_cli_without_stdin_returns_json_for_missing_input(self):
        command = [sys.executable, str(Path(pids.__file__)), 'setup', '--no-input', '--dry-run']
        result = subprocess.run(command, input='', capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn('Choose --access', json.loads(result.stdout)['error'])

    def test_parser_errors_use_json_without_stdin(self):
        for arguments in [['setup', '--access', 'public'], ['missing-command'], ['setup', '--port', 'not-a-number']]:
            with self.subTest(arguments=arguments):
                result = subprocess.run([sys.executable, str(Path(pids.__file__)), *arguments, '--json'],
                                        input='', capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 2)
                parsed = json.loads(result.stdout)
                self.assertFalse(parsed['ok'])
                self.assertIn('--help', parsed['action'])

    def test_dns_plan_uses_actual_self_addresses_and_never_applies(self):
        status = {'BackendState': 'Running', 'Self': {'DNSName': 'host.tail.ts.net.',
                  'TailscaleIPs': ['100.64.0.10', 'fd7a:115c:a1e0::10']}}
        args = pids.parser().parse_args(['inspect', '--domain', 'sessions.example.com'])
        with patch.object(pids, 'tailscale_status', return_value=status), patch.object(pids, 'host_info', return_value=self.host):
            result = pids.inspect(args)
        self.assertEqual([r['type'] for r in result['dns_plan']['records']], ['A', 'AAAA'])
        self.assertEqual(result['dns_plan']['records'][0]['content'], '100.64.0.10')
        self.assertFalse(result['dns_plan']['applied'])
        self.assertFalse(result['dns_plan']['proxied'])

    def test_source_copy_survives_build_failure(self):
        source = self.source()
        revision = pids.source_revision(source)
        saved = {**self.config, 'source': str(source)}
        pids.atomic_write(pids.CONFIG / 'config.json', json.dumps(saved))
        account = types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        def fail_build(args, **kw):
            if args[0] == 'runuser':
                raise pids.Failure('simulated build failure')
        with patch.object(pids, 'run', side_effect=fail_build):
            with self.assertRaisesRegex(pids.Failure, 'build failure'):
                pids.prepare_source(source, revision, account)
        retained = pids.ROOT / 'releases' / revision
        self.assertEqual(pids.read_json(pids.CONFIG / 'config.json')['source'], str(retained))
        self.assertTrue((retained / 'src/example.txt').exists())
        self.assertFalse((retained / '.built').exists())


if __name__ == '__main__':
    unittest.main()
