import type { SVGProps } from 'react';

// Three connector cards used to share one lucide chain-link icon, and
// QuickBooks and Shopify shared a tile colour too, so two of the three were
// indistinguishable apart from their heading.
//
// Paths are the verified marks from simple-icons (CC0 1.0), inline because the
// CSP admits no external asset host and three paths do not earn a dependency.
// The marks remain each company's trademark and appear only to identify the
// service a card connects to.
//
// Deliberately not drawn in brand colours. Measured against the tiles they sit
// on, every one of the three fails contrast in at least one theme: QuickBooks
// #2CA01C is 2.85:1 on the dark tile, Shopify #7AB55C is 2.16:1 on the light
// one, and Square #3E4348 is 1.46:1 on dark, which is close to invisible. The
// shape carries the recognition; currentColor keeps both themes legible and
// keeps three competing greens out of a palette built around one accent.
const MARKS = {
  quickbooks: { title: 'QuickBooks', d: 'M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm.642 4.1335c.9554 0 1.7296.776 1.7296 1.7332v9.0667h1.6c1.614 0 2.9275-1.3156 2.9275-2.933 0-1.6173-1.3136-2.9333-2.9276-2.9333h-.6654V7.3334h.6654c2.5722 0 4.6577 2.0897 4.6577 4.667 0 2.5774-2.0855 4.6666-4.6577 4.6666H12.642zM7.9837 7.333h3.3291v12.533c-.9555 0-1.73-.7759-1.73-1.7332V9.0662H7.9837c-1.6146 0-2.9277 1.316-2.9277 2.9334 0 1.6175 1.3131 2.9333 2.9277 2.9333h.6654v1.7332h-.6654c-2.5725 0-4.6577-2.0892-4.6577-4.6665 0-2.5771 2.0852-4.6666 4.6577-4.6666Z' },
  shopify: { title: 'Shopify', d: 'M15.337 23.979l7.216-1.561s-2.604-17.613-2.625-17.73c-.018-.116-.114-.192-.211-.192s-1.929-.136-1.929-.136-1.275-1.274-1.439-1.411c-.045-.037-.075-.057-.121-.074l-.914 21.104h.023zM11.71 11.305s-.81-.424-1.774-.424c-1.447 0-1.504.906-1.504 1.141 0 1.232 3.24 1.715 3.24 4.629 0 2.295-1.44 3.76-3.406 3.76-2.354 0-3.54-1.465-3.54-1.465l.646-2.086s1.245 1.066 2.28 1.066c.675 0 .975-.545.975-.932 0-1.619-2.654-1.694-2.654-4.359-.034-2.237 1.571-4.416 4.827-4.416 1.257 0 1.875.361 1.875.361l-.945 2.715-.02.01zM11.17.83c.136 0 .271.038.405.135-.984.465-2.064 1.639-2.508 3.992-.656.213-1.293.405-1.889.578C7.697 3.75 8.951.84 11.17.84V.83zm1.235 2.949v.135c-.754.232-1.583.484-2.394.736.466-1.777 1.333-2.645 2.085-2.971.193.501.309 1.176.309 2.1zm.539-2.234c.694.074 1.141.867 1.429 1.755-.349.114-.735.231-1.158.366v-.252c0-.752-.096-1.371-.271-1.871v.002zm2.992 1.289c-.02 0-.06.021-.078.021s-.289.075-.714.21c-.423-1.233-1.176-2.37-2.508-2.37h-.115C12.135.209 11.669 0 11.265 0 8.159 0 6.675 3.877 6.21 5.846c-1.194.365-2.063.636-2.16.674-.675.213-.694.232-.772.87-.075.462-1.83 14.063-1.83 14.063L15.009 24l.927-21.166z' },
  square: { title: 'Square', d: 'M4.01 0A4.01 4.01 0 000 4.01v15.98c0 2.21 1.8 4 4.01 4.01h15.98C22.2 24 24 22.2 24 19.99V4A4.01 4.01 0 0019.99 0H4zm1.62 4.36h12.74c.7 0 1.26.57 1.26 1.27v12.74c0 .7-.56 1.27-1.26 1.27H5.63c-.7 0-1.26-.57-1.26-1.27V5.63a1.27 1.27 0 011.26-1.27zm3.83 4.35a.73.73 0 00-.73.73v5.09c0 .4.32.72.72.72h5.1a.73.73 0 00.73-.72V9.44a.73.73 0 00-.73-.73h-5.1Z' },
} as const;

export type ConnectorName = keyof typeof MARKS;

interface ConnectorMarkProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: ConnectorName;
  /** Decorative by default: every card already names its provider in a heading. */
  decorative?: boolean;
}

export function ConnectorMark({ name, decorative = true, ...props }: ConnectorMarkProps) {
  const mark = MARKS[name];

  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      // A decorative mark has no accessible name to query, and "each card shows
      // its own provider" is the whole point of this component existing.
      data-mark={name}
      {...props}
    >
      {!decorative && <title>{mark.title}</title>}
      <path d={mark.d} />
    </svg>
  );
}
