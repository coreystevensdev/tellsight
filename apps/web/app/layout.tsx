import type { Metadata } from 'next';
import { Inter, Newsreader, JetBrains_Mono } from 'next/font/google';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ResponsiveToaster } from '@/components/common/ResponsiveToaster';
import './globals.css';

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  display: 'swap',
});

// Editorial body copy (marketing page, AI summary text) -- UI chrome (nav,
// buttons, dense dashboard tables) stays on Inter for small-size legibility.
const newsreader = Newsreader({
  variable: '--font-newsreader',
  subsets: ['latin'],
  display: 'swap',
  style: ['normal', 'italic'],
});

// Financial figures in the AI summary and stat tables get tabular monospace
// digits, not the proportional sans -- easier to scan a column of numbers.
const jetbrainsMono = JetBrains_Mono({
  variable: '--font-jetbrains-mono',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  // Without this, Next resolves the generated opengraph-image against
  // http://localhost:3000, and production served exactly that:
  //   <meta property="og:image" content="http://localhost:3000/opengraph-image?...">
  // So every share of the live demo on LinkedIn, Slack or iMessage produced no
  // preview card at all.
  //
  // Defaulted to the real domain rather than read only from the environment,
  // because this is evaluated when the page is prerendered and the image build
  // has no APP_URL. The deploy does write APP_URL into the instance's .env, so
  // the override still works wherever the value is present at build time.
  metadataBase: new URL(process.env.APP_URL ?? 'https://tellsight.coreystevens.dev'),
  title: 'Tellsight',
  description: 'Analytics that explains your business data in plain English. Built on Claude.',
  openGraph: {
    title: 'Tellsight',
    description: 'Analytics that explains your business data in plain English. Built on Claude.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Tellsight',
    description: 'Analytics that explains your business data in plain English. Built on Claude.',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The font variables belong on <html>: globals.css reads them from @theme,
  // which compiles to :root, and :root cannot see a property set on <body>.
  return (
    <html
      lang="en"
      className={`${inter.variable} ${newsreader.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body className="font-sans antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {children}
          <ResponsiveToaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
