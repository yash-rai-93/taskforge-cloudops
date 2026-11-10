#!/usr/bin/env python3
"""Publish tested image archives. Called only after every CI gate succeeds on main."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
from release import ROLES

def run(*command):
    return subprocess.check_output(command, text=True).strip()

def archive_config_digest(archive):
    with tarfile.open(archive) as image:
        manifests = json.load(image.extractfile('manifest.json'))
        if len(manifests) != 1:
            raise RuntimeError('Expected one platform image in the tested archive')
        config = image.extractfile(manifests[0]['Config']).read()
    return 'sha256:' + hashlib.sha256(config).hexdigest()

def registry_config_digest(reference):
    manifest = json.loads(run('docker', 'buildx', 'imagetools', 'inspect', reference, '--raw'))
    if 'manifests' in manifest:
        platforms = [item for item in manifest['manifests']
                     if item.get('platform', {}).get('os') == 'linux'
                     and item.get('platform', {}).get('architecture') == 'amd64']
        if len(platforms) != 1:
            raise RuntimeError('Expected one linux/amd64 registry manifest')
        image = reference.rsplit('@', 1)[0]
        manifest = json.loads(run('docker', 'buildx', 'imagetools', 'inspect',
                                  f'{image}@{platforms[0]["digest"]}', '--raw'))
    return manifest['config']['digest']

def publish_image(tag, expected_config):
    """Push a missing tag or verify an existing tag against the tested archive."""
    inspect = ['docker', 'buildx', 'imagetools', 'inspect', tag, '--format', '{{json .Manifest}}']
    try:
        remote = json.loads(subprocess.check_output(inspect, stderr=subprocess.DEVNULL, text=True))
    except subprocess.CalledProcessError:
        run('docker', 'push', tag)
        remote = json.loads(run(*inspect))
    digest = remote['digest']
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
        raise RuntimeError('Registry did not return an image digest')
    pinned = f'{tag.rsplit(":", 1)[0]}@{digest}'
    if registry_config_digest(pinned) != expected_config:
        raise RuntimeError('Registry digest does not match tested image. Refusing to overwrite the commit tag.')
    return digest

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--images', type=Path, required=True)
    parser.add_argument('--digests', type=Path, required=True)
    args = parser.parse_args()
    repository, sha = os.environ['REPOSITORY'].lower(), os.environ['RELEASE_SHA']
    if os.environ.get('GITHUB_EVENT_NAME') != 'push' or os.environ.get('GITHUB_REF') != 'refs/heads/main':
        raise SystemExit('Publication requires a main push')
    if not re.fullmatch(r'[a-z0-9_.-]+/[a-z0-9_.-]+', repository) or not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise SystemExit('Invalid repository or commit')
    # Validate the complete set before any push. Never silently retag/rebuild a missing image.
    references = {}
    for role in ROLES:
        archive = args.images / f'{role}.tar'
        run('docker', 'load', '-i', str(archive))
        tag = f'ghcr.io/{repository}-{role}:{sha}'
        labels = json.loads(run('docker', 'image', 'inspect', tag))[0]['Config']['Labels']
        if labels.get('org.opencontainers.image.revision') != sha or labels.get('org.opencontainers.image.source') != f'https://github.com/{repository}':
            raise SystemExit('Tested image labels do not match this repository/commit')
        references[role] = (tag, archive_config_digest(archive))
    digests = {}
    for role, (tag, config) in references.items():
        digests[role] = publish_image(tag, config)
        print(f'Published/verified {tag} @ {digests[role]}', flush=True)
    args.digests.write_text(json.dumps(digests) + '\n')
