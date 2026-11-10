import LoginForm from './login-form';

// Read the opt-in public demo credentials from the running frontend.
export const dynamic = 'force-dynamic';

export default function LoginPage() {
  const email = process.env.PUBLIC_DEMO_EMAIL?.trim();
  const password = process.env.PUBLIC_DEMO_PASSWORD;

  return <LoginForm demo={email && password ? { email, password } : undefined} />;
}
