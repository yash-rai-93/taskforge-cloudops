#!/usr/bin/env python3
"""Real Docker release/digest/migration/rollback checks, confined to disposable CI."""
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
from deploy import Deployment, DeploymentError
from release import bundle, ROLES

if os.environ.get('COMPOSE_SMOKE_TEST') != 'true' or not os.environ.get('COMPOSE_PROJECT_NAME', '').startswith('taskforge-ci-'):
    raise SystemExit('Deployment tests require an isolated disposable CI project')
project = os.environ['COMPOSE_PROJECT_NAME'] + '-delivery'
registry = 'localhost:15000'
repository = 'taskforge/delivery-test'
source = Path(__file__).resolve().parent.parent
root = Path(tempfile.mkdtemp(prefix='taskforge-delivery-'))
(root / 'releases').mkdir()
values = dict(DB_NAME='delivery', DB_USERNAME='delivery', DB_PASSWORD=secrets.token_hex(24),
              REDIS_PASSWORD=secrets.token_hex(24), JWT_SECRET=secrets.token_hex(32),
              FRONTEND_URL='http://127.0.0.1:18081', HTTP_PORT='18081', SMTP_ENABLED='false')
secret_file = root / '.env.production'
secret_file.write_text(''.join(f'{k}={v}\n' for k, v in values.items()))
secret_file.chmod(0o600)
deployment = Deployment(root, repository, registry=registry, project=project)
registry_name = project + '-registry'

def docker(*args):
    return subprocess.check_output(['docker', *args], text=True, stderr=subprocess.STDOUT, timeout=240).strip()

def release(sha, broken=False):
    images = {}
    for role in ROLES:
        tag = f'{registry}/{repository}-{role}:{sha}'
        image = 'taskforge-delivery-broken' if broken and role == 'worker' else f'taskforge-local-{role}'
        docker('tag', image, tag)
        docker('push', tag)
        digest = json.loads(docker('buildx', 'imagetools', 'inspect', tag, '--format', '{{json .Manifest}}'))['digest']
        images[role] = {'tag': tag, 'digest': f'{registry}/{repository}-{role}@{digest}'}
    path = root / 'releases' / sha
    bundle(source, path, {'schema':1, 'repository':repository, 'commit':sha, 'images':images}, registry=registry)
    return path

try:
    docker('run', '-d', '--name', registry_name, '-p', '127.0.0.1:15000:5000', 'registry:2')
    broken = root / 'broken'
    broken.mkdir()
    (broken / 'Dockerfile').write_text('FROM taskforge-local-worker\nHEALTHCHECK --interval=2s --timeout=1s --start-period=0s --retries=2 CMD exit 1\nCMD ["node", "-e", "process.exit(1)"]\n')
    docker('build', '-t', 'taskforge-delivery-broken', str(broken))
    first = release(os.environ['GITHUB_SHA'])
    deployment.execute(first)
    assert (root / 'current').resolve() == first
    command, env, _ = deployment.config(first)
    deployment.run(command + ['exec', '-T', 'postgres', 'sh', '-c',
        'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "CREATE TABLE deployment_probe (value text); INSERT INTO deployment_probe VALUES (\'survives\');"'], env)
    print('PASS: real registry pushes/digests, digest-pinned pulls, migrations and healthy first deployment', flush=True)
    bad = release('b' * 40, broken=True)
    try:
        deployment.execute(bad)
        raise AssertionError('Unhealthy worker was incorrectly accepted')
    except DeploymentError as error:
        assert 'previous application release restored' in str(error)
    assert (root / 'current').resolve() == first
    deployment.health(deployment.config(first)[2])
    persisted = deployment.run(command + ['exec', '-T', 'postgres', 'sh', '-c',
        'psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT value FROM deployment_probe"'], env)
    assert persisted.strip() == 'survives'
    print('PASS: genuinely broken worker rejects release; automatic rollback restores healthy previous images and preserves PostgreSQL data', flush=True)
    second = release('c' * 40)
    deployment.execute(second)
    assert (root / 'current').resolve() == second
    deployment.execute(rollback=True)
    assert (root / 'current').resolve() == first
    print('PASS: second healthy release, previous-release tracking and manual application rollback', flush=True)
except Exception:
    print('Deployment integration failed; credential-bearing subprocess output withheld', flush=True)
    raise SystemExit(1) from None
finally:
    try:
        candidates = list((root / 'releases').iterdir())
        if candidates:
            command, env, _ = deployment.config(candidates[0])
            deployment.run(command + ['down', '-v', '--remove-orphans'], env)
    finally:
        try:
            docker('rm', '-f', registry_name)
        finally:
            shutil.rmtree(root)
