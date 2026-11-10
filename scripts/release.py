#!/usr/bin/env python3
"""Produce a credential-free deployment bundle from a tested source checkout."""
import argparse
import json
import re
import shutil
from pathlib import Path

ROLES = ('api', 'worker', 'frontend')

def validate(manifest, repository, registry="ghcr.io"):
    if manifest.get('schema') != 1 or manifest.get('repository') != repository.lower():
        raise ValueError('Unexpected release schema or repository')
    if not re.fullmatch(r'[0-9a-f]{40}', manifest.get('commit', '')):
        raise ValueError('Release requires a full lowercase commit SHA')
    if set(manifest.get('images', {})) != set(ROLES):
        raise ValueError('Release requires exactly three application images')
    for role in ROLES:
        image = manifest['images'][role]
        prefix = f'{registry}/{repository.lower()}-{role}'
        if image.get('tag') != f'{prefix}:{manifest["commit"]}':
            raise ValueError('Unexpected image ownership or tag')
        if not re.fullmatch(re.escape(prefix) + r'@sha256:[0-9a-f]{64}', image.get('digest', '')):
            raise ValueError('Release requires repository-scoped image digests')
    return manifest

def bundle(source, target, manifest, registry="ghcr.io"):
    validate(manifest, manifest['repository'], registry)
    target.mkdir(parents=True, exist_ok=False)
    for name in ('docker-compose.prod.yml', 'nginx/nginx.conf', 'scripts/deploy.py', 'scripts/release.py'):
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / name, destination)
    (target / 'release.json').write_text(json.dumps(manifest, indent=2) + '\n')
    services = {role: {'image': manifest['images'][role]['digest']} for role in ROLES}
    services['migrate'] = {'image': manifest['images']['api']['digest']}
    (target / 'docker-compose.release.json').write_text(json.dumps({'services': services}, indent=2) + '\n')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--digests', type=Path, required=True, help='JSON mapping api/worker/frontend to sha256 digests')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    repository = args.repository.lower()
    digests = json.loads(args.digests.read_text())
    images = {role: {'tag': f'ghcr.io/{repository}-{role}:{args.commit}',
                     'digest': f'ghcr.io/{repository}-{role}@{digests[role]}'} for role in ROLES}
    bundle(Path(__file__).resolve().parent.parent, args.output,
           {'schema': 1, 'repository': repository, 'commit': args.commit, 'images': images})
