# Deep check maintenance log (a run every two weeks)

## 2026-11-17 (Claude, handover)
- Health: 1,735 tests pass; production build compiles.
- Production: released `eb6ee9d` (merge of preview `5cd490a`) at the owner's request. Smoke check: `/founder` 200, `/api/llm/models` 200, deep check gated behind sign-in (401 when signed out).
- Models on preview: chat and extract answer (Gemini). OpenRouter rejects its key: the owner must rotate `OPENROUTER_API_KEY`.
- Scores (round 4): Milton 80, Neumann 74, Mensch 72; average 75.3; no wrong-person attributions.
- Open: see CODEX-HANDOVER.md section 4 and open-items-round4.json.
