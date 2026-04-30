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
      {/* bars tell a story: growth, dip, recovery, not a perfect staircase */}
      <rect x="8" y="14" width="6" height="20" rx="2" className="fill-primary/70" />
      <rect x="17" y="22" width="6" height="12" rx="2" className="fill-primary/50" />
      <rect x="26" y="10" width="6" height="24" rx="2" className="fill-primary" />
      {/* insight dot, the thing only Tellsight shows you */}
      <circle cx="29" cy="7" r="2.5" className="fill-accent-warm" />
    </svg>
  );
}
