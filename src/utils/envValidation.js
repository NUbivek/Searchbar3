const SEARCH_PROVIDER_KEYS = ['TAVILY_API_KEY', 'SERPER_API_KEY'];

const OPTIONAL_PROVIDERS = {
  search: SEARCH_PROVIDER_KEYS,
  // Only providers whose plan cannot bill (see src/server/llm/providers.js)
  llm: ['GOOGLE_AI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'NVIDIA_API_KEY'],
  twitter: ['TWITTER_CLIENT_ID', 'TWITTER_CLIENT_SECRET'],
  linkedin: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
  reddit: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
  market: ['FMP_API_KEY', 'FRED_API_KEY']
};

export function getEnvDiagnostics(env = process.env) {
  const searchProviderPresent = SEARCH_PROVIDER_KEYS.filter((k) => !!env[k]);
  const missingCore = searchProviderPresent.length > 0
    ? []
    : ['TAVILY_API_KEY or SERPER_API_KEY'];

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
