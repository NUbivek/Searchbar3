# Prompt for the daily Codex run

Paste the text below as the task for a scheduled daily Codex run in the
repository `NUbivek/Searchbar3`.

---

You maintain and improve Research Hub (https://diligence.bivek.ai), a Next.js due-diligence site for a venture investor. This is your daily run.

Before doing anything, read these files in the repository, in this order: `CODEX-HANDOVER.md`, `AGENTS.md`, `FOUNDER-CHECK.md`, `README.md`, and the last entry of `eval/founder/LOG.md` (create the file if it is missing). The handover's section 2 lists rules that must never be weakened: free-only models, never pinning a namesake's record on the founder, the privacy rules, polite and permitted access, honest coverage, the UI wording rules, and the house rules. Treat every one of them as a hard constraint. If a change would break one, do not make it.

Then follow section 3 of `CODEX-HANDOVER.md`, "The daily run", step by step:

1. Sync the `claude/research-hub-fix` branch.
2. Health: the full test suite and the production build must pass. Fix anything red first.
3. Production smoke check (read-only).
4. Model chain check on the latest preview deployment.
5. A live evaluation of one or two subjects from `eval/founder/ground-truth.md`, rotating day to day, on a local server.
6. Grade each report against the ground truth, and find the cause of each miss in the code.
7. Fix the highest-value problems: today's findings first, then the open items in `eval/founder/open-items-round4.json`. Each fix gets a test. Run the full suite and the build, then commit and `git push origin claude/research-hub-fix`. Re-run one subject live to confirm the score did not drop, and revert any fix that lowers it or adds a wrong attribution.
8. Append a dated entry to `eval/founder/LOG.md`:
   - health results;
   - scores per subject;
   - commits;
   - what is still open;
   - anything the owner must do (for example a rejected provider key);
   - a one-line release note when preview is green and ahead of production.

Never:

- merge to or push the production branch `openclaw-fixes`, unless the owner has written "push to production" for this specific change;
- read `.env` or credential files, or print secrets or the owner's contacts;
- add a paid service, or read the paid keys that sit unused in Vercel;
- set `FOUNDER_DEEP_PUBLIC` anywhere but your local server;
- delete the owner's local data folders (`.data/*`).

Work in small, tested commits. If you are unsure whether a change keeps a rule, leave it out and note it in the log for the owner.
