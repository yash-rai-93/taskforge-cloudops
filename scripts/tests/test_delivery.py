import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
from deploy import Deployment, DeploymentError
from release import validate, bundle, ROLES

REPO = 'yash-rai-93/taskforge-cloudops'

def manifest(sha='a' * 40):
    return {'schema':1, 'repository':REPO, 'commit':sha, 'images':{
        role:{'tag':f'ghcr.io/{REPO}-{role}:{sha}', 'digest':f'ghcr.io/{REPO}-{role}@sha256:'+'d'*64}
        for role in ROLES}}

class FakeDocker(Deployment):
    def __init__(self, root):
        super().__init__(root, REPO)
        self.events = []
        self.fail = None
        self.unhealthy = None

    def run(self, command, env, timeout=240):
        self.events.append(command)
        release = Path(command[command.index('-f')+1]).parent
        if self.fail and self.fail in command:
            raise DeploymentError('private command detail must never reach output')
        if self.unhealthy == release and 'up' in command and 'api' in command:
            raise DeploymentError('unhealthy new app')
        if 'config' in command:
            images = json.loads((release / 'docker-compose.release.json').read_text())['services']
            return json.dumps({'services':{**images, 'postgres':{}, 'redis':{}, 'nginx':{'ports':[{'published':'18080'}]}}})
        return ''

    def health(self, config):
        self.events.append(['health'])

class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'releases').mkdir()
        self.secret = self.root / '.env.production'
        self.secret.write_text('JWT_SECRET=private\n')
        self.secret.chmod(0o600)
        self.delivery = FakeDocker(self.root)

    def make(self, sha='a'*40):
        path = self.root / 'releases' / sha
        bundle(SCRIPTS.parent, path, manifest(sha))
        return path

    def test_release_requires_correct_owner_full_sha_and_every_digest(self):
        mutations = [lambda m:m.update(commit='latest'), lambda m:m.update(repository='other/repo'),
            lambda m:m['images'].pop('worker'), lambda m:m['images']['api'].update(digest='ghcr.io/other/api@sha256:'+'d'*64),
            lambda m:m['images']['api'].update(tag=f'ghcr.io/{REPO}-api:latest'),
            lambda m:m['images']['worker'].update(digest=f'ghcr.io/{REPO}-worker:latest')]
        for mutate in mutations:
            candidate = manifest()
            mutate(candidate)
            with self.subTest(candidate=candidate):
                with self.assertRaises(ValueError):
                    validate(candidate, REPO)
        self.assertEqual(validate(manifest(), REPO), manifest())

    def test_first_deployment_only_promotes_after_health(self):
        release = self.make()
        self.delivery.execute(release)
        self.assertEqual((self.root / 'current').resolve(), release)
        self.assertFalse((self.root / 'previous').exists())
        events = self.delivery.events
        migration = next(i for i,e in enumerate(events) if 'run' in e)
        application = next(i for i,e in enumerate(events) if 'up' in e and 'api' in e)
        self.assertLess(migration, application)
        self.assertEqual(events[-1], ['health'])
        self.assertEqual(self.secret.read_text(), 'JWT_SECRET=private\n')

    def test_failed_new_app_restores_previous_without_schema_revert_or_pointer_change(self):
        old, new = self.make(), self.make('b'*40)
        self.delivery.execute(old)
        self.delivery.unhealthy = new
        with self.assertRaisesRegex(DeploymentError, 'previous application release restored'):
            self.delivery.execute(new)
        self.assertEqual((self.root / 'current').resolve(), old)
        self.assertEqual(sum('run' in e for e in self.delivery.events), 2)
        self.assertEqual(self.delivery.events[-1], ['health'])

    def test_pull_and_migration_failure_do_not_replace_application(self):
        old, new = self.make(), self.make('b'*40)
        self.delivery.execute(old)
        for failure in ('pull', 'run'):
            self.delivery.events.clear()
            self.delivery.fail = failure
            with self.assertRaises(DeploymentError):
                self.delivery.execute(new)
            self.assertEqual((self.root / 'current').resolve(), old)
            self.assertFalse(any('up' in e and 'api' in e for e in self.delivery.events))

    def test_failed_first_deploy_does_not_claim_success(self):
        release = self.make()
        self.delivery.unhealthy = release
        with self.assertRaisesRegex(DeploymentError, 'no previous healthy release'):
            self.delivery.execute(release)
        self.assertFalse((self.root / 'current').exists())

    def test_manual_rollback_uses_previous_healthy_release_and_skips_migrations(self):
        old, new = self.make(), self.make('b'*40)
        self.delivery.execute(old)
        self.delivery.execute(new)
        self.delivery.events.clear()
        self.delivery.execute(rollback=True)
        self.assertEqual((self.root / 'current').resolve(), old)
        self.assertEqual((self.root / 'previous').resolve(), new)
        self.assertFalse(any('run' in e or 'pull' in e for e in self.delivery.events))

    def test_rollback_without_history_fails(self):
        with self.assertRaisesRegex(DeploymentError, 'No previous'):
            self.delivery.execute(rollback=True)

    def test_world_readable_secret_is_rejected_before_docker(self):
        release = self.make()
        self.secret.chmod(0o644)
        with self.assertRaisesRegex(DeploymentError, 'must not be accessible'):
            self.delivery.execute(release)
        self.assertEqual(self.delivery.events, [])

    def test_tampered_image_override_is_rejected(self):
        release = self.make()
        (release / 'docker-compose.release.json').write_text('{"services":{}}')
        with self.assertRaisesRegex(DeploymentError, 'does not match'):
            self.delivery.execute(release)
        self.assertEqual(self.delivery.events, [])

    def test_bundle_outside_release_root_is_rejected(self):
        with self.assertRaisesRegex(DeploymentError, 'inside the deployment'):
            self.delivery.execute(self.root / 'elsewhere')

    def test_concurrent_deployment_is_rejected(self):
        import fcntl
        release = self.make()
        with (self.root / '.deploy.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(DeploymentError, 'Another deployment'):
                self.delivery.execute(release)

    def test_pr_cannot_invoke_publication_script(self):
        env = {**os.environ, 'REPOSITORY':REPO, 'RELEASE_SHA':'a'*40,
               'GITHUB_EVENT_NAME':'pull_request', 'GITHUB_REF':'refs/pull/4/merge'}
        result = subprocess.run([sys.executable, str(SCRIPTS/'publish.py'), '--images', str(self.root),
            '--digests', str(self.root/'out.json')], env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('requires a main push', result.stderr)
        self.assertFalse((self.root/'out.json').exists())

if __name__ == '__main__':
    unittest.main()
