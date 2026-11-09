// Test production topology with locally built images in a disposable CI project.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
if (process.env.COMPOSE_SMOKE_TEST !== 'true' || !process.env.COMPOSE_PROJECT_NAME?.startsWith('taskforge-ci-')) {
  throw new Error('Production smoke test requires disposable CI opt-in');
}
const tag = process.env.GITHUB_SHA;
assert.match(tag || '', /^[0-9a-f]{40}$/);
const file = join(tmpdir(), `taskforge-production-${process.pid}.env`);
const vars = {
 IMAGE_NAMESPACE:'taskforge-production-test', API_IMAGE_TAG:tag, WORKER_IMAGE_TAG:tag, FRONTEND_IMAGE_TAG:tag,
 DB_NAME:'taskforge', DB_USERNAME:'taskforge', DB_PASSWORD:randomBytes(24).toString('hex'),
 REDIS_PASSWORD:randomBytes(24).toString('hex'), JWT_SECRET:randomBytes(32).toString('hex'),
 FRONTEND_URL:'http://127.0.0.1:18080', HTTP_PORT:'18080', SMTP_ENABLED:'false',
};
writeFileSync(file, Object.entries(vars).map(([key,value])=>`${key}=${value}`).join('\n')+'\n', {mode:0o600});
const args = ['compose','-p',`${process.env.COMPOSE_PROJECT_NAME}-production`,'--env-file',file,'-f','docker-compose.prod.yml'];
// Prevent local-stack variables from overriding the isolated production fixture.
const env = {...process.env};
for (const key of Object.keys(vars)) delete env[key];
const docker = (...tail) => execFileSync('docker',[...args,...tail],{env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:240000});
try {
 for(const role of ['api','worker','frontend']) {
  execFileSync('docker',['tag',`taskforge-local-${role}`,`taskforge-production-test-${role}:${tag}`]);
 }
 docker('config','--quiet');
 const config=JSON.parse(docker('config','--format','json'));
 assert.equal(config.services.mailpit,undefined);
 assert.equal(config.services.postgres.ports,undefined);
 assert.equal(config.services.redis.ports,undefined);
 for(const role of ['api','worker','frontend'])assert.ok(config.services[role].image.endsWith(`-${role}:${tag}`));
 docker('up','-d','--pull','never','--wait','--wait-timeout','180');
 assert.equal((await fetch('http://127.0.0.1:18080/health')).status,200);
 assert.ok((await (await fetch('http://127.0.0.1:18080/login')).text()).includes('/_next/static/'));
 console.log('PASS: standalone production topology, three SHA-tagged images, fresh migrations, healthy worker/API/frontend, private DB/Redis and no Mailpit');
} catch {
 // Environment and inspected configurations can contain secrets; never dump them.
 console.error('Production topology smoke check failed; credentials withheld');
 try {
  let logs=docker('logs','--tail','40','api','worker','migrate','frontend','nginx');
  for(const secret of [vars.DB_PASSWORD,vars.REDIS_PASSWORD,vars.JWT_SECRET])logs=logs.split(secret).join('[redacted]');
  console.error(logs);
 } catch { console.error('Production service diagnostics unavailable'); }
 process.exitCode=1;
} finally {
 try { docker('down','-v','--remove-orphans'); } catch { process.exitCode=1; }
 rmSync(file,{force:true});
}
