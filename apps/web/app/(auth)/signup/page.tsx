import type { Metadata } from 'next';
import { TellsightLogo } from '@/components/common/TellsightLogo';
import LoginButton from '../login/LoginButton';
import SignupForm from './SignupForm';

export const metadata: Metadata = {
  title: 'Sign Up, Tellsight',
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string; invite?: string }>;
}) {
  const params = await searchParams;
  const redirectPath = params.redirect ?? '/dashboard';

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background overflow-hidden">
      <div
        className="absolute inset-0 opacity-[0.4] dark:opacity-[0.15]"
        style={{
          backgroundImage: 'radial-gradient(circle, var(--color-border) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }}
        aria-hidden="true"
      />
      <div
        className="absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse at center, transparent 30%, var(--color-background) 70%)',
        }}
        aria-hidden="true"
      />

      <div className="relative w-full max-w-sm space-y-8 rounded-xl border border-border/50 bg-card p-8 shadow-lg">
        <div className="flex flex-col items-center gap-3 text-center">
          <TellsightLogo size={44} />
          <h1 className="text-2xl font-semibold text-foreground">Create your account</h1>
          <p className="text-sm text-muted-foreground">
            Your data, explained in plain English
          </p>
        </div>

        <LoginButton redirectPath={redirectPath} label="Sign up with Google" />

        <div className="flex items-center gap-3" aria-hidden="true">
          <div className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted-foreground">or</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <SignupForm redirectPath={redirectPath} inviteToken={params.invite} />

        <p className="text-center text-xs text-muted-foreground">
          By creating an account, you agree to our terms of service.
        </p>
      </div>
    </div>
  );
}
