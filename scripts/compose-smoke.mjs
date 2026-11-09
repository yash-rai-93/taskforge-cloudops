// Destructive integration test ONLY for an isolated disposable Compose project.
// Pauses/recreates services and writes synthetic data. Never run against production.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

if (process.env.COMPOSE_SMOKE_TEST !== 'true' || !process.env.COMPOSE_PROJECT_NAME?.startsWith('taskforge-ci-')) {
  throw new Error('Requires COMPOSE_SMOKE_TEST=true and an isolated taskforge-ci-* project');
}
const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:8080';
const mailBase = process.env.SMOKE_MAIL_URL || 'http://127.0.0.1:8025';
const compose = (...args) => execFileSync('docker', ['compose', ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 240000 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, description, timeout = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const result = await fn(); if (result) return result; } catch { /* retry readiness */ }
    await sleep(1000);
  }
  throw new Error(`Timed out: ${description}`);
}
let token;
let organizationId;
async function api(path, options = {}) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method: options.method || 'GET', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(organizationId ? { 'x-organization-id': organizationId } : {}) },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  // Never include response bodies, request credentials or tokens in error output.
  assert.ok(response.ok, `${options.method || 'GET'} ${path.split('?')[0]} returned ${response.status}`);
  return response.json();
}
const insideApi = (source, ...args) => compose('exec', '-T', 'api', 'node', '-e', source, ...args).trim();
const queueSource = `
const { Queue } = require('bullmq');
const Redis = require('ioredis');
(async () => {
 const connection = new Redis({host:process.env.REDIS_HOST,port:Number(process.env.REDIS_PORT),password:process.env.REDIS_PASSWORD,maxRetriesPerRequest:null});
 const queue = new Queue('activity',{connection});
 try {
  const jobs = await queue.getJobs(['wait','active','delayed','completed','failed'],0,999);
  const job = jobs.find(j=>j.data.payload?.entityId===process.argv[1]);
  if (!job) throw new Error('Expected queue job missing');
  if (process.argv[2]==='retry') await job.retry('completed');
  console.log(JSON.stringify({id:job.id,state:await job.getState()}));
 } finally { await queue.close(); await connection.quit(); }
})().catch(()=>{process.exitCode=1;});`;
const queue = (entityId, mode = 'inspect') => JSON.parse(insideApi(queueSource, entityId, mode));
const activities = async entityId => (await api(`/activity?entityId=${entityId}`)).data;
async function completed(entityId) {
  await until(() => queue(entityId).state === 'completed', 'BullMQ completion');
  const rows = await until(async () => { const rows = await activities(entityId); return rows.length ? rows : false; }, 'worker result API');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, queue(entityId).id, 'worker result must have queued event ID');
}

try {
  await until(async () => (await fetch(`${base}/health`)).ok, 'public API health');
  const loginPage = await fetch(`${base}/login`);
  assert.equal(loginPage.status, 200);
  assert.ok((await loginPage.text()).includes('/_next/static/'), 'Next.js login shell/assets must be served');
  for (const role of ['api', 'worker', 'frontend', 'nginx']) {
    assert.notEqual(compose('exec', '-T', role, 'id', '-u').trim(), '0', `${role} must run without root`);
  }
  let noAuth;
  try { compose('exec', '-T', 'redis', 'sh', '-c', 'unset REDISCLI_AUTH; redis-cli -e ping'); }
  catch (error) { noAuth = String(error.stdout); }
  assert.ok(noAuth?.includes('NOAUTH'), 'Redis must reject unauthenticated requests');
  console.log('PASS: frontend/proxy/API readiness, non-root application containers, Redis authentication');

  const suffix = randomBytes(6).toString('hex');
  const email = `compose-${suffix}@example.com`;
  const password = randomBytes(24).toString('hex');
  await api('/auth/register', { method: 'POST', body: { email, password, firstName: 'Compose', lastName: 'Test' } });
  const message = await until(async () => {
    const list = await (await fetch(`${mailBase}/api/v1/messages`)).json();
    return list.messages?.find(m => m.To?.some(to => to.Address === email));
  }, 'local verification email');
  const body = await (await fetch(`${mailBase}/api/v1/message/${message.ID}`)).json();
  const match = body.Text.match(/https?:\/\/[^\s]+\/auth\/verify-email\?token=([a-f0-9]+)/);
  assert.ok(match, 'verification link must exist in local inbox');
  const verification = await api('/auth/verify-email', { method: 'POST', body: { token: match[1] } });
  token = verification.data.accessToken;
  assert.ok(token);
  organizationId = verification.data.user.currentOrganizationId;
  assert.ok(organizationId);
  console.log('PASS: signup, real local SMTP capture, email verification and workspace creation');

  const project = (await api('/projects', { method: 'POST', body: { name: `Compose ${suffix}` } })).data;
  const task = (await api(`/projects/${project.id}/tasks`, { method: 'POST', body: { title: `Queued task ${suffix}` } })).data;
  await completed(task.id);
  console.log('PASS: task -> Redis/BullMQ -> dedicated worker -> PostgreSQL activity -> REST result');

  compose('stop', 'worker');
  const queued = (await api('/projects', { method: 'POST', body: { name: `Persistence ${suffix}` } })).data;
  await until(() => queue(queued.id).state === 'waiting', 'queued work while worker stopped');
  assert.equal((await activities(queued.id)).length, 0, 'API must not write the worker result itself');
  compose('stop', 'nginx', 'frontend', 'api');
  compose('up', '-d', '--wait', '--wait-timeout', '120', '--force-recreate', 'postgres', 'redis');
  compose('up', '-d', '--wait', '--wait-timeout', '180');
  await completed(queued.id);
  assert.equal((await api(`/tasks/${task.id}`)).data.title, task.title);
  console.log('PASS: PostgreSQL data and pending Redis jobs survive service recreation');

  queue(queued.id, 'retry');
  await completed(queued.id);
  assert.equal((await activities(queued.id)).length, 1);
  console.log('PASS: replaying a completed job does not duplicate the persisted activity');

  const workerId = compose('ps', '-q', 'worker').trim();
  const restartCount = () => Number(execFileSync('docker', ['inspect', '--format', '{{.RestartCount}}', workerId], { encoding: 'utf8' }));
  const before = restartCount();
  // Crash the Node child, allowing the container restart policy to recover it.
  try { compose('exec', '-T', 'worker', 'node', '-e', `
const fs=require('fs');
for(const name of fs.readdirSync('/proc')) {
 if(!/^\\d+$/.test(name)||Number(name)===1||Number(name)===process.pid)continue;
 try { if(fs.readFileSync('/proc/'+name+'/cmdline','utf8').includes('dist/worker.js')) {process.kill(Number(name),'SIGKILL');break;} }catch{}
}`); } catch (error) {
    // The exec process may be terminated as the crashed container exits.
    if (![137, 143].includes(error.status)) throw error;
  }
  await until(() => restartCount() > before, 'automatic crash restart');
  await until(() => execFileSync('docker', ['inspect', '--format', '{{.State.Health.Status}}', workerId], { encoding: 'utf8' }).trim() === 'healthy', 'restarted worker health');
  const afterRestart = (await api('/projects', { method: 'POST', body: { name: `Restart ${suffix}` } })).data;
  await completed(afterRestart.id);
  console.log('PASS: worker crash recovery, fresh dependency heartbeat and subsequent job processing');

  assert.ok(process.env.SMOKE_STATE_FILE, 'SMOKE_STATE_FILE must be outside the repository');
  writeFileSync(process.env.SMOKE_STATE_FILE, JSON.stringify({ email, password, taskTitle: task.title, projectName: project.name }), { mode: 0o600 });
} catch (error) {
  // exec errors can include captured logs; expose only the sanitized message category.
  console.error(error.code && error.code !== 'ERR_ASSERTION' ? `Container command failed (${error.code}); inspect bounded service diagnostics` : error.message);
  process.exitCode = 1;
}
