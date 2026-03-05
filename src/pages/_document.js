import React from 'react';
import { Html, Head, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        {/* React-based category display is now used instead of emergency display */}
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
