'use strict';

// Updated only while BullMQ is consuming and PostgreSQL/Redis respond.
try {
  const { mtimeMs } = require('node:fs').statSync('/tmp/taskforge-worker-health');
  process.exit(Date.now() - mtimeMs < 30000 ? 0 : 1);
} catch {
  process.exit(1);
}
