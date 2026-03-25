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
    <div className="w-full max-w-sm space-y-4 rounded-lg bg-white p-8 text-center shadow-sm">
      <h1 className="text-lg font-semibold text-gray-900">{title}</h1>
      <p className="text-sm text-gray-600">{message}</p>
      <Link
        href="/"
        className="inline-flex h-12 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-white transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        Go to homepage
      </Link>
    </div>
  );
}
