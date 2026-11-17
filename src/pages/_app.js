import React from 'react';
import '../styles/globals.css';
import { Analytics } from '@vercel/analytics/react';
import { SessionProvider } from 'next-auth/react';

function MyApp({ Component, pageProps: { session, ...pageProps } }) {
  return (
    <SessionProvider session={session}>
      <Component {...pageProps} />
      <Analytics />
    </SessionProvider>
  );
}

export default MyApp;
