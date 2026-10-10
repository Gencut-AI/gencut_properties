import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
// Self-hosted variable font (weight + width axes, OFL-1.1): no build-time or
// runtime requests to a third-party font service.
import '@fontsource-variable/archivo/wdth.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'GenCut', template: '%s · GenCut' },
  description: 'An AI marketing department for real-estate agents: opportunities, campaigns and media, ready for your approval.',
  applicationName: 'GenCut',
  appleWebApp: { capable: true, title: 'GenCut', statusBarStyle: 'default' },
  icons: { icon: '/icon.svg', apple: '/apple-touch-icon.png' },
};

export const viewport: Viewport = {
  themeColor: '#0f6e73',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
