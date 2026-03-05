# Cost Guardrails

This project must be operated in budget-aware mode across subscription-based services.

## Scope

Applies to:
- Vercel deployments
- Serper API usage
- Tavily API usage
- Together/LLM provider usage
- Codex run-time/tool usage
- Any other paid or quota-limited platform used by this repo

## Rules

1. Prefer local validation first.
- Use local build/test checks before remote deployment or paid API usage.

2. Minimize deployment frequency.
- Batch related changes into one deployable patch.
- Avoid repeated redeploys for partial/incremental checks.
- Trigger deploy only when required for user-facing verification.

3. Use provider fallbacks to avoid hard failures.
- Keep fail-soft behavior enabled.
- Use primary provider first (Serper), then fallback provider (Tavily) when needed.
- Avoid unnecessary repeated live calls during debugging.

4. Limit paid LLM traffic.
- Only call paid LLM endpoints when feature validation requires it.
- Prefer deterministic/local fallback behavior when debugging transport/UI.

5. Reduce Codex/tool churn.
- Avoid duplicate commands and redundant builds.
- Reuse existing outputs where valid.
- Keep command count minimal and purpose-driven.

6. Include cost impact in execution updates.
- Any action that may consume quota/credits should be called out before execution.

7. Preserve quota for final verification.
- Reserve budget for final end-to-end validation after patch groups are complete.

## Operational Default

When uncertain, choose the lower-cost path that still preserves correctness and fail-soft reliability.
