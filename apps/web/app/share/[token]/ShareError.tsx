import Link from 'next/link';

const VARIANTS = {
  'not-found': {
    title: "This shared insight doesn't exist",
    message: 'The link may have been removed or the URL is incorrect.',
  },
  expired: {
    title: 'This shared insight has expired',
    message: 'Shared links are available for a limited time. Ask the sender for a new link.',
  },
} as const;

export default function ShareError({ variant }: { variant: keyof typeof VARIANTS }) {
  const { title, message } = VARIANTS[variant];

  return (
    <div className="w-full max-w-sm space-y-4 rounded-lg bg-card p-8 text-center shadow-sm">
      <h1 className="text-lg font-semibold text-foreground">{title}</h1>
      <p className="text-sm text-muted-foreground">{message}</p>
      <Link
        href="/"
        className="inline-flex h-12 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Go to homepage
      </Link>
    </div>
  );
}
