'use strict';

// Run after npm run build. Uses compiled services and local doubles only:
// no PostgreSQL, Redis, SMTP, Stripe or AWS calls, and no real credentials.
const assert = require('node:assert/strict');
const nodemailer = require('nodemailer');
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

  // Exercise the upgraded mailer's real message compilation without an SMTP server.
  // Configured application paths must retain sender, recipient and frontend links.
  const configuredMail = new MailService(new ConfigService({ mail: {
    user: 'synthetic-user', pass: 'synthetic-password',
    from: 'TaskForge <sender@example.com>', frontendUrl: 'https://assessment.example.com',
  } }));
  assert.equal(configuredMail.enabled, true);
  configuredMail.logger = mail.logger;
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const messages = [];
  configuredMail.transporter = {
    async sendMail(options) {
      const info = await transport.sendMail(options);
      messages.push(JSON.parse(info.message));
      return info;
    },
  };
  await configuredMail.sendVerifyEmail({
    to: 'test@example.com', firstName: 'Test', token: 'synthetic-only',
  });
  await configuredMail.sendPasswordResetEmail({
    to: 'test@example.com', token: 'synthetic-only',
  });
  await configuredMail.sendInvitationEmail({
    recipientEmail: 'test@example.com', organizationName: 'Test workspace',
    role: 'member', inviteToken: 'synthetic-only',
  });
  await configuredMail.sendTaskAssignedEmail({
    recipientEmail: 'test@example.com', taskTitle: 'Test task', organizationName: 'Test workspace',
    priority: 'medium', taskId: 'synthetic-task',
  });
  const paths = [
    '/auth/verify-email?token=synthetic-only', '/auth/reset-password?token=synthetic-only',
    '/invite/synthetic-only', '/tasks',
  ];
  assert.equal(messages.length, paths.length);
  messages.forEach((message, index) => {
    assert.equal(message.from.address, 'sender@example.com');
    assert.equal(message.to[0].address, 'test@example.com');
    assert.ok(message.text.includes(`https://assessment.example.com${paths[index]}`));
    assert.ok(message.html.includes(`https://assessment.example.com${paths[index]}`));
  });
  transport.close();

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
  console.log('PASS: optional integrations, four configured email templates, required env validation');
}
main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
