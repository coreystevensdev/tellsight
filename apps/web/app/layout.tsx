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
  title: 'Tellsight',
  description: 'Analytics that explains your business data in plain English. Built on Claude.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${newsreader.variable} ${jetbrainsMono.variable} font-sans antialiased`}
      >
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {children}
          <ResponsiveToaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
