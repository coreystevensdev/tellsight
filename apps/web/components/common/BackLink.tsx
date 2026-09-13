import Link from 'next/link';

interface BackLinkProps {
  href?: string;
  label?: string;
}

// Points at a known parent rather than calling router.back(), so the
// destination is the same whether the user arrived from the dashboard, a
// digest email or a bookmark. History-back on a page reached from an email
// leaves the app entirely.
export function BackLink({ href = '/dashboard', label = 'Back to dashboard' }: BackLinkProps) {
  return (
    <Link
      href={href}
      className="mb-6 flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <span aria-hidden="true">&larr;</span>
      {label}
    </Link>
  );
}
