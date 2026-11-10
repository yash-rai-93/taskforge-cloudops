#!/usr/bin/env python3
"""Publish tested image archives. Called only after every CI gate succeeds on main."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
from release import ROLES

def run(*command):
    return subprocess.check_output(command, text=True).strip()

def publish_image(tag):
    """Push a missing tag or verify an existing tag against the tested config ID."""
    local_id = run('docker', 'image', 'inspect', tag, '--format', '{{.Id}}')
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
    raw = json.loads(run('docker', 'buildx', 'imagetools', 'inspect', pinned, '--raw'))
    if raw.get('config', {}).get('digest') != local_id:
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
        run('docker', 'load', '-i', str(args.images / f'{role}.tar'))
        tag = f'ghcr.io/{repository}-{role}:{sha}'
        labels = json.loads(run('docker', 'image', 'inspect', tag))[0]['Config']['Labels']
        if labels.get('org.opencontainers.image.revision') != sha or labels.get('org.opencontainers.image.source') != f'https://github.com/{repository}':
            raise SystemExit('Tested image labels do not match this repository/commit')
        references[role] = tag
    digests = {}
    for role, tag in references.items():
        digests[role] = publish_image(tag)
        print(f'Published/verified {tag} @ {digests[role]}', flush=True)
    args.digests.write_text(json.dumps(digests) + '\n')
