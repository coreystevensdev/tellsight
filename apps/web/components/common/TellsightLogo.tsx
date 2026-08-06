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
      {/* an eye for "sight", a trendline for the "insight" inside it */}
      <path
        d="M6 20C6 20 12 10 20 10C28 10 34 20 34 20C34 20 28 30 20 30C12 30 6 20 6 20Z"
        className="stroke-primary"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <path
        d="M14 21L18 16L22 20L27 13"
        className="stroke-primary"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
