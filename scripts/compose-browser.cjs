'use strict';
// Uses ephemeral CI-only Playwright dependencies; no credentials/screenshots are printed.
const assert = require('node:assert/strict');
const { readFileSync, rmSync } = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
let stage = 'initialization';
let privateValues = [];
(async () => {
  const state = JSON.parse(readFileSync(process.env.SMOKE_STATE_FILE, 'utf8'));
  privateValues = [state.password, state.email];
  const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:8080';
  function onExpectedOrigin(value) {
    const actual = new URL(value);
    actual.protocol = actual.protocol.replace(/^ws/, 'http');
    return actual.origin === new URL(base).origin;
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const external = [];
    let upgrade;
    const upgraded = new Promise(resolve => { upgrade = resolve; });
    page.on('websocket', socket => {
      if (!onExpectedOrigin(socket.url())) external.push(true);
      socket.on('framereceived', frame => { if (frame.payload === '3probe') upgrade(); });
    });
    page.on('request', request => {
      if (['xhr','fetch','websocket'].includes(request.resourceType()) && !onExpectedOrigin(request.url())) external.push(true);
    });
    stage = 'browser login';
    await page.goto(`${base}/login`);
    await page.getByLabel('Email address').fill(state.email);
    await page.locator('#password').fill(state.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).filter({ visible: true }).click();
    await page.waitForURL(`${base}/`);
    stage = 'WebSocket proxy upgrade';
    let timer;
    try { await Promise.race([upgraded, new Promise((_,reject) => { timer=setTimeout(()=>reject(new Error('WebSocket upgrade timeout')),20000); })]); }
    finally { clearTimeout(timer); }
    stage = 'task listing';
    await page.goto(`${base}/tasks`);
    await page.getByText(state.taskTitle, { exact: true }).first().waitFor({ timeout: 30000 });
    stage = 'task creation through the UI';
    await page.getByRole('button', { name: 'New task', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Create Task', exact: true });
    await dialog.locator('#task-project').click();
    await page.getByRole('option', { name: state.projectName, exact: true }).click();
    const title = `Browser queued ${Date.now()}`;
    await dialog.getByLabel('Title', { exact: true }).fill(title);
    const created = page.waitForResponse(response => response.request().method() === 'POST' && /\/api\/v1\/projects\/[^/]+\/tasks$/.test(new URL(response.url()).pathname));
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    assert.ok((await created).ok());
    stage = 'worker result displayed in activity feed';
    await page.goto(`${base}/activity`);
    await page.getByRole('main').getByRole('heading', { name: 'Activity', exact: true }).waitFor();
    await page.getByRole('main').getByText(title, { exact: false }).first().waitFor({ timeout: 30000 });
    stage = 'same-origin network assertions';
    assert.equal(external.length, 0, 'browser API/socket requests must use the public proxy origin');
    console.log('PASS: browser login, WebSocket upgrade, task creation, worker result UI and same-origin requests');
  } finally {
    await browser.close();
    rmSync(process.env.SMOKE_STATE_FILE, { force: true });
  }
})().catch(error => {
  let message = String(error.message).replace(/eyJ[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+/g, '[redacted token]');
  for (const value of privateValues) if (value) message = message.split(value).join('[redacted]');
  console.error(`Browser smoke check failed at ${stage}: ${message.slice(0, 1800)}`);
  process.exitCode = 1;
});
