import React from 'react';
import '../styles/globals.css';
import { Analytics } from '@vercel/analytics/react';
import { SessionProvider } from 'next-auth/react';
import dynamic from 'next/dynamic';

// The Tavus guide (floating video agent) is browser-only; mounted once here so
// a call survives client-side navigation between pages.
const TavusGuide = dynamic(() => import('../components/tavus/TavusGuide'), { ssr: false });

function MyApp({ Component, pageProps: { session, ...pageProps } }) {
  return (
    <SessionProvider session={session}>
      <Component {...pageProps} />
      <TavusGuide />
      <Analytics />
    </SessionProvider>
  );
}

export default MyApp;
