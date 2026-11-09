'use strict';

// Run after npm run build. Uses compiled services and local doubles only:
// no PostgreSQL, Redis, SMTP, Stripe or AWS calls, and no real credentials.
const assert = require('node:assert/strict');
const { ConfigService } = require('@nestjs/config');
const { Test } = require('@nestjs/testing');
const { StripeService } = require('../dist/modules/billing/services/stripe.service');
const { BillingService } = require('../dist/modules/billing/services/billing.service');
const { MailService } = require('../dist/modules/mail/mail.service');
const { envValidationSchema } = require('../dist/config/env.validation');

async function main() {
  const module = await Test.createTestingModule({
    providers: [StripeService, { provide: ConfigService, useValue: new ConfigService({}) }],
  }).compile();
  const stripe = module.get(StripeService);
  assert.equal(stripe.enabled, false, 'empty Stripe settings must allow DI construction');
  await assert.rejects(
    stripe.createCustomer('test@example.com', 'Test', {}),
    error => error.getStatus() === 503,
    'disabled Stripe must fail before any network request',
  );
  assert.throws(
    () => stripe.constructWebhookEvent(Buffer.from('{}'), 'synthetic'),
    error => error.getStatus() === 503,
  );
  const enabled = new StripeService(new ConfigService({
    billing: { stripeSecretKey: 'synthetic-non-live-key' },
  }));
  assert.equal(enabled.enabled, true, 'configured Stripe remains available');

  // No billing dependencies may be called when the integration is disabled.
  const unexpected = new Proxy({}, {
    get() { throw new Error('Disabled billing accessed a dependency'); },
  });
  const billing = new BillingService(
    unexpected, stripe, unexpected, unexpected, unexpected, unexpected, unexpected,
  );
  await billing.initializeOrgBilling('synthetic-org', 'test@example.com', 'Test');

  const mail = new MailService(new ConfigService({}));
  assert.equal(mail.enabled, false, 'SMTP may be unconfigured at construction');
  // Suppress preview output; never print a reset/invitation token in verification.
  mail.logger = { log() {}, debug() {}, warn() {}, error() {} };
  mail.transporter.sendMail = () => { throw new Error('SMTP must not send when disabled'); };
  await mail.sendPasswordResetEmail({ to: 'test@example.com', token: 'synthetic-only' });

  const base = {
    NODE_ENV: 'production', DB_HOST: 'postgres', DB_USERNAME: 'taskforge',
    DB_PASSWORD: 'synthetic-fixture-only', DB_NAME: 'taskforge', REDIS_HOST: 'redis',
    JWT_SECRET: 'synthetic-validation-only-value-longer-than-32',
    STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', SMTP_USER: '', SMTP_PASS: '',
  };
  assert.equal(envValidationSchema.validate(base).error, undefined);
  for (const key of ['DB_HOST', 'DB_USERNAME', 'DB_PASSWORD', 'DB_NAME', 'REDIS_HOST', 'JWT_SECRET']) {
    assert.ok(envValidationSchema.validate({ ...base, [key]: '' }).error, `${key} must be required`);
  }
  assert.ok(envValidationSchema.validate({ ...base, JWT_SECRET: 'too-short' }).error);
  await module.close();
  console.log('PASS: optional Stripe/SMTP construction, disabled integration guards, required env validation');
}
main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
