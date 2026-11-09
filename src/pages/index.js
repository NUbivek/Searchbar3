import React, { useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import OpenSearch from '../components/OpenSearch';
import { TopBar, SectionSwitch } from '../components/layout/PageShell';

export default function Home() {
  const [selectedModel, setSelectedModel] = useState('auto');

  return (
    <div className="min-h-screen">
      <Head>
        <title>Research Hub</title>
        <meta name="description" content="Diligence research across curated sources, the web and your own documents, with every claim cited." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <TopBar />
      <main className="mx-auto max-w-5xl px-4 pb-16 pt-6">
        <SectionSwitch />
        <section className="mb-6 text-center">
          <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-ink">
            Research any company, founder or market
          </h1>
        </section>
        <OpenSearch selectedModel={selectedModel} setSelectedModel={setSelectedModel} />
      </main>
      <footer className="mx-auto flex max-w-5xl justify-end gap-3 px-4 pb-8 text-xs text-muted">
        <Link href="/privacy" className="hover:text-ink">Privacy</Link>
        <Link href="/terms" className="hover:text-ink">Terms</Link>
      </footer>
    </div>
  );
}
