'use strict';
// Real queue/DB/browser integration. These disruptive controls are confined to CI.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');

module.exports = async function reportScenarios({ page, base, state }) {
  if (process.env.COMPOSE_SMOKE_TEST !== 'true' || !process.env.COMPOSE_PROJECT_NAME?.startsWith('taskforge-ci-')) {
    throw new Error('Report integration requires an isolated disposable CI project');
  }
  let stage = 'initialization';
  let renamed = false;
  let stopped = false;
  let lock;
  const compose = (...args) => execFileSync('docker', ['compose', ...args], { encoding: 'utf8', stdio: ['pipe','pipe','pipe'], timeout: 120000 });
  const sql = query => compose('exec','-T','postgres','sh','-c', 'exec psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"', 'psql', query);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(fn, description, timeout = 20000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const value = await fn();
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`Timed out: ${description}`);
  }
  async function request(path, { method = 'GET', body, token, org, expected = 200 } = {}) {
    const response = await fetch(`${base}/api/v1${path}`, {
      method, signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type':'application/json', ...(token ? { Authorization:`Bearer ${token}` } : {}), ...(org ? {'x-organization-id':org} : {}) },
      ...(body ? {body:JSON.stringify(body)} : {}),
    });
    assert.equal(response.status, expected, `${method} ${path} status`);
    return response.json();
  }
  const login = await request('/auth/login', { method:'POST', expected:201, body:{email:state.email,password:state.password} });
  const token = login.data.accessToken;
  const org = login.data.user.currentOrganizationId;
  const api = (path, options = {}) => request(path, {token,org,...options});
  const status = (id, projectId = state.projectId) => api(`/projects/${projectId}/reports/${id}`).then(r=>r.data);
  const region = page.getByRole('region', {name:'Project summary',exact:true});
  const reportState = region.getByTestId('report-state');
  async function clickSubmit(label) {
    const response = page.waitForResponse(r => r.request().method()==='POST' && r.url()===`${base}/api/v1/projects/${state.projectId}/reports`);
    await region.getByRole('button',{name:label,exact:true}).click();
    const accepted = await response;
    assert.equal(accepted.status(),202);
    return (await accepted.json()).data.id;
  }
  async function visibleState(value, timeout = 20000) {
    await until(async ()=>(await reportState.textContent())===value,`visible ${value}`,timeout);
  }
  async function queueJob(id, remove = false) {
    const source = `const {Queue}=require('bullmq'); const Redis=require('ioredis');
(async()=>{const connection=new Redis({host:process.env.REDIS_HOST,port:Number(process.env.REDIS_PORT),password:process.env.REDIS_PASSWORD,maxRetriesPerRequest:null});
const q=new Queue('project-reports',{connection});try{const j=await q.getJob(process.argv[1]);if(!j)throw Error('Missing job');
const result={state:await j.getState(),progress:j.progress,attemptsMade:j.attemptsMade};if(process.argv[2]==='remove')await j.remove();console.log(JSON.stringify(result));}finally{await q.close();await connection.quit();}})().catch(()=>{process.exitCode=1;});`;
    return JSON.parse(compose('exec','-T','api','node','-e',source,id,remove?'remove':'inspect'));
  }
  async function acquireLock() {
    lock = spawn('docker',['compose','exec','-T','postgres','sh','-c','exec psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"'], {stdio:['pipe','pipe','pipe']});
    let output='';
    lock.stdout.on('data',chunk=>{output+=chunk.toString();});
    lock.stderr.on('data',()=>{});
    lock.stdin.write("BEGIN; LOCK TABLE tasks IN ACCESS EXCLUSIVE MODE; SELECT 'REPORT_LOCK_READY';\n");
    await until(()=>output.includes('REPORT_LOCK_READY'),'test SQL lock');
  }
  async function releaseLock() {
    if (!lock) return;
    const current=lock;lock=undefined;
    const exited=once(current,'exit');
    current.stdin.end('COMMIT;\n');
    const [code]=await exited;
    assert.equal(code,0,'test SQL lock release');
  }

  try {
    stage='report fixtures';
    const done=(await api(`/projects/${state.projectId}/tasks`,{method:'POST',expected:201,body:{title:'Report completed fixture',status:'done',priority:'high'}})).data;
    const deleted=(await api(`/projects/${state.projectId}/tasks`,{method:'POST',expected:201,body:{title:'Report deleted fixture'}})).data;
    await api(`/tasks/${deleted.id}`,{method:'DELETE'});
    const tasks=(await api(`/projects/${state.projectId}/tasks?limit=100`)).data;
    assert.ok(tasks.some(t=>t.id===done.id));
    assert.ok(!tasks.some(t=>t.id===deleted.id));
    const total=tasks.length;
    const doneCount=tasks.filter(t=>t.status==='done').length;

    stage='queued report and refresh';
    compose('stop','worker');stopped=true;
    await page.goto(`${base}/projects/${state.projectId}`);
    await region.getByRole('button',{name:'Generate summary',exact:true}).waitFor();
    const id=await clickSubmit('Generate summary');
    await visibleState('Queued');
    assert.equal((await status(id)).result,null);
    assert.equal((await queueJob(id)).state,'waiting');
    await page.reload();
    await visibleState('Queued');
    console.log('PASS: report submission from UI, real queued state while worker stopped, requester-scoped ID survives page refresh');

    const doomed=(await api('/projects',{method:'POST',expected:201,body:{name:`Removed report ${Date.now()}`}})).data;
    const missing=(await api(`/projects/${doomed.id}/reports`,{method:'POST',expected:202})).data;
    await api(`/projects/${doomed.id}`,{method:'DELETE'});

    stage='active processing and result';
    // Hold the real aggregation query briefly; the feature has no test/delay flag.
    await acquireLock();
    compose('start','worker');stopped=false;
    await visibleState('Processing',10000);
    const active=await status(id);
    assert.equal(active.state,'processing');
    assert.equal(active.progress,40);
    assert.equal((await queueJob(id)).state,'active');
    await releaseLock();
    await visibleState('Completed');
    assert.equal((await region.getByTestId('report-total').textContent()),String(total));
    assert.equal((await region.getByTestId('report-done').textContent()),String(doneCount));
    const completed=await status(id);
    assert.equal(completed.progress,100);
    assert.equal(completed.result.totalTasks,total);
    assert.equal(completed.result.byStatus.done,doneCount);
    assert.equal(completed.result.completionPercent,Math.round(doneCount/total*100));
    assert.equal((await queueJob(id)).state,'completed');
    console.log('PASS: real active BullMQ state/progress, SQL snapshot counts exclude deleted tasks, completed API result and browser result');

    await until(async ()=>(await status(missing.id,doomed.id)).state==='failed','removed-project terminal failure');
    assert.equal((await status(missing.id,doomed.id)).attemptsMade,1);
    console.log('PASS: removed project fails permanently, remains readable only by its original requester and does not waste retries');

    stage='automatic retries and visible terminal failure';
    sql('ALTER TABLE tasks RENAME TO tasks_report_test_unavailable');renamed=true;
    const failedId=await clickSubmit('Generate again');
    await visibleState('Retrying');
    const retrying=await status(failedId);
    assert.equal(retrying.state,'retrying');
    assert.ok(retrying.attemptsMade>=1);
    await visibleState('Failed');
    const failed=await status(failedId);
    assert.equal(failed.attemptsMade,3);
    assert.equal(failed.result,null);
    assert.equal((await queueJob(failedId)).state,'failed');
    assert.ok(!/SELECT|tasks_report_test_unavailable|password|stacktrace/.test(JSON.stringify(failed)));
    await region.getByRole('alert').filter({hasText:'This report could not be generated.'}).waitFor();
    sql('ALTER TABLE tasks_report_test_unavailable RENAME TO tasks');renamed=false;
    const recoveredId=await clickSubmit('Try again');
    assert.notEqual(recoveredId,failedId);
    await visibleState('Completed');
    assert.equal((await status(failedId)).state,'failed');
    assert.equal((await status(recoveredId)).result.totalTasks,total);
    console.log('PASS: genuine database failure, automatic backoff/retries, sanitized Failed UI after three attempts, and successful user retry');

    stage='report access control';
    await request(`/projects/${state.projectId}/reports/${recoveredId}`,{expected:401});
    await api(`/projects/${doomed.id}/reports/${recoveredId}`,{expected:404});
    const email=`report-outsider-${randomBytes(6).toString('hex')}@example.com`;
    const password=randomBytes(24).toString('hex');
    await request('/auth/register',{method:'POST',expected:201,body:{email,password,firstName:'Other',lastName:'Workspace'}});
    const mailBase=process.env.SMOKE_MAIL_URL||'http://127.0.0.1:8025';
    const message=await until(async()=>{
      const list=await (await fetch(`${mailBase}/api/v1/messages`)).json();
      return list.messages?.find(m=>m.To?.some(t=>t.Address===email));
    },'outsider verification email');
    const mail=await (await fetch(`${mailBase}/api/v1/message/${message.ID}`)).json();
    const verificationToken=mail.Text.match(/https?:\/\/[^\s]+\/auth\/verify-email\?token=([a-f0-9]+)/)?.[1];
    assert.ok(verificationToken);
    const other=(await request('/auth/verify-email',{method:'POST',expected:201,body:{token:verificationToken}})).data;
    await request(`/projects/${state.projectId}/reports/${recoveredId}`,{token:other.accessToken,org:other.user.currentOrganizationId,expected:404});
    await request(`/projects/${state.projectId}/reports`,{method:'POST',token:other.accessToken,org:other.user.currentOrganizationId,expected:404});
    console.log('PASS: authentication and cross-project/cross-organization report isolation');

    stage='missing retained result and empty project';
    await queueJob(recoveredId,true);
    await page.reload();
    await visibleState('Report unavailable or expired');
    await region.getByRole('button',{name:'Generate summary',exact:true}).waitFor();
    await clickSubmit('Generate summary');
    await visibleState('Completed');
    const empty=(await api('/projects',{method:'POST',expected:201,body:{name:`Empty report ${Date.now()}`}})).data;
    const emptyId=(await api(`/projects/${empty.id}/reports`,{method:'POST',expected:202})).data.id;
    await until(async()=>(await status(emptyId,empty.id)).state==='completed','empty report completion');
    const emptyResult=(await status(emptyId,empty.id)).result;
    assert.equal(emptyResult.totalTasks,0);
    assert.equal(emptyResult.completionPercent,0);
    console.log('PASS: actual removed-job 404/expired UI recovery and empty-project summary');
  } catch (error) {
    // Do not include exec stderr (which can contain internal database details).
    const message=error.cmd ? 'Container control failed; inspect bounded CI diagnostics' : error.message;
    throw new Error(`Report scenario ${stage}: ${message}`);
  } finally {
    if(lock) { try { await releaseLock(); } catch {} }
    if(renamed) { try { sql('ALTER TABLE tasks_report_test_unavailable RENAME TO tasks'); } catch {} }
    if(stopped) { try { compose('start','worker'); } catch {} }
  }
};
