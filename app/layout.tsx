import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

function resolveMetadataBase(): URL {
  try {
    return new URL(process.env.BETTER_AUTH_URL ?? 'http://localhost:3000');
  } catch {
    return new URL('http://localhost:3000');
  }
}

const description =
  'Vigilo is an engineering preview of a sandbox-first repair pipeline: frozen source, isolated execution, bounded model access, and human review. Real baselines are measured; autonomous repair is not yet demonstrated.';

export const metadata: Metadata = {
  metadataBase: resolveMetadataBase(),
  title: 'Vigilo — AI repair that has to show its work',
  description,
  applicationName: 'Vigilo',
  openGraph: {
    type: 'website',
    siteName: 'Vigilo',
    title: 'Vigilo — AI repair that has to show its work',
    description,
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Vigilo: engineering preview v0.9' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Vigilo — AI repair that has to show its work',
    description,
    images: ['/og.png'],
  },
};

export const viewport: Viewport = {
  themeColor: '#f4f1e8',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
