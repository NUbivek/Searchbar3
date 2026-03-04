const REQUIRED_CORE = [
  'SERPER_API_KEY'
];

const OPTIONAL_PROVIDERS = {
  llm: ['TOGETHER_API_KEY', 'PERPLEXITY_API_KEY', 'OPENAI_API_KEY'],
  twitter: ['TWITTER_CLIENT_ID', 'TWITTER_CLIENT_SECRET'],
  linkedin: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
  reddit: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
  market: ['FMP_API_KEY', 'FRED_API_KEY']
};

export function getEnvDiagnostics(env = process.env) {
  const missingCore = REQUIRED_CORE.filter((k) => !env[k]);

  const providers = Object.entries(OPTIONAL_PROVIDERS).reduce((acc, [name, keys]) => {
    const present = keys.filter((k) => !!env[k]);
    const missing = keys.filter((k) => !env[k]);
    acc[name] = {
      configured: present.length > 0,
      present,
      missing
    };
    return acc;
  }, {});

  return {
    ok: missingCore.length === 0,
    missingCore,
    providers,
    baseUrl: env.NEXT_PUBLIC_BASE_URL || null,
    productionUrl: env.NEXT_PUBLIC_PRODUCTION_URL || null,
    useProductionCallbacks: env.NEXT_PUBLIC_USE_PRODUCTION_CALLBACKS === 'true'
  };
}

export function assertCoreEnv(env = process.env) {
  const diag = getEnvDiagnostics(env);
  if (!diag.ok) {
    return {
      ...diag,
      error: `Missing required environment variables: ${diag.missingCore.join(', ')}`
    };
  }
  return diag;
}
