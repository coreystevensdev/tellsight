import type { Metadata } from 'next';
import { TellsightLogo } from '@/components/common/TellsightLogo';
import LoginButton from './LoginButton';

export const metadata: Metadata = {
  title: 'Sign In, Tellsight',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  const params = await searchParams;
  const redirectPath = params.redirect ?? '/dashboard';

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background overflow-hidden">
      {/* dot grid background, communicates "data" without being literal */}
      <div
        className="absolute inset-0 opacity-[0.4] dark:opacity-[0.15]"
        style={{
          backgroundImage: 'radial-gradient(circle, var(--color-border) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }}
        aria-hidden="true"
      />
      {/* radial fade so dots don't tile to infinity */}
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
          <h1 className="text-2xl font-semibold text-foreground">Tellsight</h1>
          <p className="text-sm text-muted-foreground">
            Your data, explained in plain English
          </p>
        </div>

        <LoginButton redirectPath={redirectPath} />

        <p className="text-center text-xs text-muted-foreground">
          By signing in, you agree to our terms of service.
        </p>
      </div>
    </div>
  );
}
