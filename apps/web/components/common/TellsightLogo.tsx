interface TellsightLogoProps {
  size?: number;
  className?: string;
}

export function TellsightLogo({ size = 20, className }: TellsightLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <rect width="40" height="40" rx="10" className="fill-primary/15" />
      {/* bars for the financial data, a checkmark for it being verified against
          the source, not just asserted (the audit drawer's whole point) */}
      <rect x="7" y="21" width="5" height="10" rx="1.5" className="fill-primary/45" />
      <rect x="15" y="15" width="5" height="16" rx="1.5" className="fill-primary/70" />
      <path
        d="M23 22L28 27L37 16"
        className="stroke-primary"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
