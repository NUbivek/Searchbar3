import React, { useState } from 'react';
import Head from 'next/head';
import OpenSearch from '../components/OpenSearch';
import ModeTabs from '../components/ModeTabs';

export default function Home() {
  // Updated to use standardized model ID
  const [selectedModel, setSelectedModel] = useState('or-openai');

  return (
    <div className="min-h-screen bg-gray-50">
      <Head>
        <title>Research Hub</title>
        <meta name="description" content="Comprehensive research tool" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <main className="container mx-auto px-4 py-6">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-gray-800">Research Hub</h1>
          <p className="text-gray-600 mt-1">Search across web, academic sources, and more.</p>
        </div>
        
        <ModeTabs activeMode="open" />
        <OpenSearch 
          selectedModel={selectedModel}
          setSelectedModel={setSelectedModel}
        />
      </main>
    </div>
  );
}
