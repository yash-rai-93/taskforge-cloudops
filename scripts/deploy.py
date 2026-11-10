#!/usr/bin/env python3
"""Deploy an already-published bundle; never fetch code or credentials from Git."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import urllib.request
from release import validate

class DeploymentError(RuntimeError):
    pass

class Deployment:
    def __init__(self, root, repository, registry="ghcr.io", project="taskforge-production"):
        self.root = Path(root).resolve()
        self.repository = repository.lower()
        self.registry = registry
        self.project = project
        self.secret_file = self.root / '.env.production'

    def run(self, command, env, timeout=240):
        try:
            return subprocess.run(command, env=env, capture_output=True, text=True,
                                  check=True, timeout=timeout).stdout
        except (subprocess.SubprocessError, OSError):
            # Docker/config output may contain secrets. Never include it in exceptions.
            raise DeploymentError('Deployment command failed; inspect private host diagnostics') from None

    def config(self, release):
        release = Path(release).resolve()
        if release.parent != (self.root / 'releases').resolve():
            raise DeploymentError('Bundle must be inside the deployment releases directory')
        manifest = validate(json.loads((release / 'release.json').read_text()), self.repository, self.registry)
        if release.name != manifest['commit']:
            raise DeploymentError('Release directory does not match commit')
        # Prevent a modified override from silently replacing validated image references.
        expected = {r: {'image': manifest['images'][r]['digest']} for r in ('api', 'worker', 'frontend')}
        expected['migrate'] = {'image': manifest['images']['api']['digest']}
        if json.loads((release / 'docker-compose.release.json').read_text()) != {'services': expected}:
            raise DeploymentError('Image override does not match release manifest')
        env = {k: os.environ[k] for k in ('PATH', 'HOME', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR', 'LANG') if k in os.environ}
        # Values are public release metadata, not copied to the private env file.
        env.update(IMAGE_NAMESPACE=f'{self.registry}/{self.repository}',
                   **{f'{r.upper()}_IMAGE_TAG': manifest['commit'] for r in ('api', 'worker', 'frontend')})
        command = ['docker', 'compose', '--project-name', self.project, '--env-file', str(self.secret_file),
                   '-f', str(release / 'docker-compose.prod.yml'), '-f', str(release / 'docker-compose.release.json')]
        config = json.loads(self.run(command + ['config', '--format', 'json'], env))
        for role in expected:
            if config['services'][role]['image'] != expected[role]['image']:
                raise DeploymentError('Resolved image does not match validated digest')
        if any(config['services'][r].get('ports') for r in ('postgres', 'redis')):
            raise DeploymentError('Database and Redis must remain private')
        return command, env, config

    def health(self, config):
        port = config['services']['nginx']['ports'][0]['published']
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            for path in ('/health', '/login'):
                with opener.open(f'http://127.0.0.1:{port}{path}', timeout=10) as response:
                    body = response.read(2_000_000)
                    if response.status != 200 or (path == '/login' and b'/_next/static/' not in body):
                        raise DeploymentError('Application HTTP verification failed')
                    if path == '/health':
                        result = json.loads(body)
                        if result.get('data', result).get('status') != 'ok':
                            raise DeploymentError('API dependency health verification failed')
        except (OSError, ValueError):
            raise DeploymentError('Application HTTP verification failed') from None

    def start(self, release):
        command, env, config = self.config(release)
        self.run(command + ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '180',
                            'api', 'worker', 'frontend', 'nginx'], env)
        self.health(config)

    def point(self, name, target):
        temporary = self.root / f'.{name}.next'
        temporary.unlink(missing_ok=True)
        temporary.symlink_to(target)
        temporary.replace(self.root / name)

    def deploy(self, release, migrate=True):
        release = Path(release).resolve()
        current = self.root / 'current'
        previous = current.resolve() if current.is_symlink() else None
        # Preparation/migration failures do not replace the running application.
        command, env, _ = self.config(release)
        if migrate:
            self.run(command + ['pull'], env)
            self.run(command + ['up', '-d', '--wait', '--wait-timeout', '120', 'postgres', 'redis'], env)
            self.run(command + ['run', '--rm', '--no-deps', 'migrate'], env)
        try:
            self.start(release)
        except DeploymentError:
            if previous and previous != release:
                try:
                    self.start(previous)
                    print('Previous application release restored and health-checked', flush=True)
                except DeploymentError:
                    raise DeploymentError('New release and automatic rollback failed; manual recovery required') from None
                raise DeploymentError('New release failed; previous application release restored') from None
            raise DeploymentError('First release failed; no previous healthy release is available') from None
        if previous and previous != release:
            self.point('previous', previous)
        self.point('current', release)
        print(f'Healthy application release: {release.name}', flush=True)

    def execute(self, release=None, rollback=False):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not self.secret_file.is_file() or self.secret_file.is_symlink():
            raise DeploymentError('A private .env.production file is required on the host')
        if stat.S_IMODE(self.secret_file.stat().st_mode) & 0o077:
            raise DeploymentError('.env.production must not be accessible to group or other users')
        with (self.root / '.deploy.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise DeploymentError('Another deployment is running') from None
            if rollback:
                previous = self.root / 'previous'
                if not previous.is_symlink():
                    raise DeploymentError('No previous healthy release exists')
                release = previous.resolve()
            self.deploy(release, migrate=not rollback)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--release', type=Path)
    parser.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    if bool(args.release) == args.rollback:
        parser.error('Specify exactly one of --release or --rollback')
    try:
        Deployment(args.root, args.repository).execute(args.release, args.rollback)
    except (DeploymentError, ValueError, KeyError, OSError):
        # Deliberately hide subprocess/config values; operators inspect host logs privately.
        print('Deployment failed; the current release pointer was not advanced. Check private host diagnostics.', file=sys.stderr)
        sys.exit(1)
