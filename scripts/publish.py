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
        # Commit tags are write-once by pipeline policy. Re-runs reuse the same digest;
        # refuse to overwrite a tag that already points to different image contents.
        try:
            remote = json.loads(run('docker', 'buildx', 'imagetools', 'inspect', tag, '--format', '{{json .Manifest}}'))
        except subprocess.CalledProcessError:
            remote = None
        if remote:
            raw = json.loads(run('docker', 'buildx', 'imagetools', 'inspect', tag, '--raw'))
            local_id = run('docker', 'image', 'inspect', tag, '--format', '{{.Id}}')
            if raw.get('config', {}).get('digest') != local_id:
                raise SystemExit('Refusing to overwrite an existing commit tag with different contents')
        else:
            subprocess.run(['docker', 'push', tag], check=True)
            remote = json.loads(run('docker', 'buildx', 'imagetools', 'inspect', tag, '--format', '{{json .Manifest}}'))
        digest = remote['digest']
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
            raise SystemExit('Registry did not return an image digest')
        # Verify the registry reference is independently addressable by that digest.
        run('docker', 'buildx', 'imagetools', 'inspect', f'{tag.split(":")[0]}@{digest}')
        digests[role] = digest
        print(f'Published/verified {tag} @ {digest}', flush=True)
    args.digests.write_text(json.dumps(digests) + '\n')
