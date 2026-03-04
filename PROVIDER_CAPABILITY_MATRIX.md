# Provider Capability Matrix

This file explains what works directly vs fallback behavior when credentials are missing.

## Core
- Web search (`/api/search/web`): requires `SERPER_API_KEY`.

## LLM
- Primary: Together (`TOGETHER_API_KEY`)
- Fallback: Perplexity (`PERPLEXITY_API_KEY`)
- Optional alternate: OpenAI (`OPENAI_API_KEY`)

## Social OAuth
- Twitter OAuth: `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET`
- LinkedIn OAuth: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`
- Reddit OAuth: `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`

## Financial
- FMP: `FMP_API_KEY`
- FRED: `FRED_API_KEY`

## Fallback behavior policy (best effort)
- If direct provider credentials are unavailable or rejected, routes should return usable fallback responses where implemented.
- Fallback mode should not expose secrets in client responses.
- Use `/api/debug/env-check` to inspect what is configured.
