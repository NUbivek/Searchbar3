# Provider Capability Matrix

What works with which keys, and what happens without them. Every feature
degrades honestly: missing providers are listed on the page, never faked.

## Search (Open Research, Founder Check, Company Profile)
| Source | Key | Without the key |
|---|---|---|
| Curated registry (VC portfolios, funding/startup news, market analysis) | none | always on |
| Hacker News | none | always on |
| Web + news (Serper primary, Tavily fallback) | `SERPER_API_KEY` or `TAVILY_API_KEY` | not searched; listed as unavailable |
| LinkedIn / X / Reddit / Substack / Medium / Crunchbase / PitchBook / Carta | `SERPER_API_KEY` or `TAVILY_API_KEY` (site searches) | not searched |
| Verified: SEC EDGAR filings | none (SEC requires a User-Agent, set in code) | always on |
| Verified: market data (FMP) | `FMP_API_KEY` | SEC only |
| Litigation (CourtListener) | `COURTLISTENER_API_TOKEN` (free account) | skipped and stated |

## AI answers (search answer, founder brief, data-room Q&A)
Free-first chain; the best model each provider serves today is picked from
its live model list (`src/server/llm/providers.js`).
| Order | Provider | Key | Cost |
|---|---|---|---|
| 1 | Groq (gpt-oss-120b, Qwen 3.x) | `GROQ_API_KEY` | free tier |
| 2 | OpenRouter free models (Nemotron, Gemma) | `OPENROUTER_API_KEY` | free models only |
| 3 | Google Gemini (Flash first) | `GOOGLE_AI_API_KEY` (or `GEMINI_API_KEY`) | free tier, **only while the key's Google project has no billing account** |
| 4 | Together | `TOGETHER_API_KEY` **and** `LLM_ALLOW_PAID=true` | paid, off by default |

Each provider is tried in order; a rate limit or error moves to the next.
Gemini's free tier lets Google use prompts (the question and source
excerpts) to improve its products; contact data is never sent to any model.

Without any of these, answers are quoted directly from sources (same
sections), and the page says so.

## Accounts and storage
- Google sign-in: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`
- Database (history, workspaces, notes, watchlists, network contacts): `DATABASE_URL` (Neon via Vercel). Local development uses an embedded database.
- Watchlist cron (daily, `vercel.json`): `CRON_SECRET`
- Watchlist email digests (optional): `RESEND_API_KEY` (Resend free tier: 3,000 emails/month) and `ALERT_EMAIL_FROM` (a sender on a domain verified in Resend; without it Resend's onboarding address is used, which only delivers to the Resend account owner). Without the key, alerts are in-app only and the Watchlist page says so.

## Network Map
- Connections: import LinkedIn's own data export (`Connections.csv`) or any CSV/XLSX of contacts. LinkedIn's API does not give third-party apps a member's connections.
- LinkedIn sign-in (profile only): `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`
- X following (needs a paid X API tier): `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET`
- Contact data is never sent to AI providers; only the question text is.

Use `/api/debug/env-check` and `/api/llm/models` to inspect what is configured.
