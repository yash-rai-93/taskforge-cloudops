import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "deploy-remote.sh"


class RemoteDeliveryTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        binary = self.root / "bin"
        binary.mkdir()
        self.trace = self.root / "trace"
        for name in ("ssh", "scp", "aws", "session-manager-plugin"):
            stub = binary / name
            stub.write_text("#!/bin/bash\nprintf '%s %s\\n' \"$(basename \"$0\")\" \"$*\" >> \"$TRACE\"\n")
            stub.chmod(0o755)
        curl = binary / "curl"
        curl.write_text("""#!/bin/bash
while (($#)); do
    if [[ "$1" == --output ]]; then output=$2; shift; fi
    url=$1
    shift
done
printf 'probe %s\\n' "$url" >> "$TRACE"
case "$url" in
    */health) printf '{"data":{"status":"ok"}}' > "$output" ;;
    */login)
        if [[ "${BROKEN_LOGIN:-false}" == true ]]; then
            printf '<html>Wrong upstream</html>' > "$output"
        else
            printf '<html><script src="/_next/static/login.js"></script></html>' > "$output"
        fi
        ;;
    *) exit 1 ;;
esac
printf 200
""")
        curl.chmod(0o755)
        archive = self.root / "taskforge-release.tar.gz"
        archive.write_bytes(b"test fixture")
        (self.root / "taskforge-release.tar.gz.sha256").write_text(
            hashlib.sha256(archive.read_bytes()).hexdigest() + "\n"
        )
        self.env = {
            **os.environ,
            "PATH": f"{binary}:{os.environ['PATH']}",
            "TRACE": str(self.trace),
            "DEPLOY_TRANSPORT": "ssm",
            "AWS_REGION": "ap-south-1",
            "DEPLOY_HOST": "i-0123456789abcdef0",
            "DEPLOY_USER": "deploy",
            "DEPLOY_ROOT": "/srv/taskforge/deploy",
            "DEPLOY_SSH_KEY": "test-fixture",
            "DEPLOY_KNOWN_HOSTS": "test-fixture",
            "PRODUCTION_URL": "https://taskforge.example.com",
            "RELEASE_SHA": "a" * 40,
            "REPOSITORY": "yash-rai-93/taskforge-cloudops",
        }

    def deploy(self, **overrides):
        return subprocess.run(
            ["bash", str(SCRIPT), str(self.root)],
            env={**self.env, **overrides},
            text=True,
            capture_output=True,
            timeout=10,
        )

    def test_ssm_tunnel_applies_to_ssh_and_bundle_transfer(self):
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.trace.read_text().splitlines()
        for line in (c for c in commands if c.startswith(("ssh ", "scp "))):
            self.assertIn("StrictHostKeyChecking=yes", line)
            self.assertIn("ProxyCommand=aws ssm start-session --region ap-south-1", line)
            self.assertIn("--document-name AWS-StartSSHSession", line)
        self.assertTrue(any(c.startswith("scp ") for c in commands))
        self.assertTrue(any(c.endswith("/login") for c in commands))

    def test_invalid_ssm_target_never_connects(self):
        result = self.deploy(DEPLOY_HOST="taskforge.example.com")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.trace.exists())

    def test_invalid_checksum_never_connects(self):
        (self.root / "taskforge-release.tar.gz").write_bytes(b"changed after signing")
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.trace.exists())

    def test_wrong_public_frontend_requests_rollback(self):
        result = self.deploy(BROKEN_LOGIN="true")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--rollback", self.trace.read_text())

    def test_direct_ssh_keeps_existing_transport(self):
        result = self.deploy(DEPLOY_TRANSPORT="ssh", DEPLOY_HOST="taskforge.example.com")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("ProxyCommand=", self.trace.read_text())
