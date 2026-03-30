import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { ResponsiveToaster } from '@/components/common/ResponsiveToaster';
import './globals.css';

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'SaaS Analytics Dashboard',
  description: 'AI-powered analytics that explains your business data in plain English.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} font-sans antialiased`}>
        {children}
        <ResponsiveToaster />
      </body>
    </html>
  );
}
