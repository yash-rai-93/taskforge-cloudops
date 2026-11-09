import { registerAs } from '@nestjs/config';

export const mailConfig = registerAs('mail', () => ({
  // Explicit opt-in supports local unauthenticated SMTP (Mailpit).
  enabled: process.env.SMTP_ENABLED === undefined
    ? !!process.env.SMTP_USER && !!process.env.SMTP_PASS
    : process.env.SMTP_ENABLED === 'true',
  host: process.env.SMTP_HOST || 'localhost',
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_SECURE === 'true',
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || 'TaskForge <noreply@taskforge.io>',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3001',
}));
