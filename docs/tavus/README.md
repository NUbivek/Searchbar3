# Tavus video guide: what goes where

Everything the video guide needs, and where each file goes in Tavus. Nothing
here changes the site; the site side is already built
(`src/components/tavus/`).

| File | Where it goes in Tavus | How |
|---|---|---|
| `00-agent-instructions.txt` | The PAL's **instructions** (system prompt) | Paste the whole text. It replaces any earlier instructions about this site. |
| `03-pal-tools.md` | The PAL's **tools** | Create three tools from it: name, description and parameters exactly as written. Delivery: app message. On resolve: generate a response. |
| `kb-01-site-map.txt` … `kb-07-faq-and-limits.txt` | The PAL's **knowledge base** | Upload all seven as separate documents. Remove the two older files (`01-site-overview-and-navigation`, `02-walkthroughs-faq-and-limits`) so the guide has no out-of-date copy. |

Do not upload `00-agent-instructions.txt`, `03-pal-tools.md` or this file to
the knowledge base.

## Why it is split this way

- **Instructions are always in the agent's mind; knowledge documents are
  searched.** Anything the guide needs on every turn (which tool to use, how
  to phrase a search, how to speak) is in the instructions, so acting never
  waits on a document search.
- **One topic per document.** Each knowledge file starts with a `TOPIC` line
  and a `USE THIS WHEN` line and covers one area, so a search returns the
  right passage and little else. Seven small files retrieve faster and more
  accurately than two long ones.
- **No duplicates.** A fact lives in one file. Uploading old and new copies
  together gives the guide conflicting answers.

## Settings worth checking in Tavus

- **Retrieval strategy.** Tavus offers `speed`, `balanced` and `quality` for
  document search; `quality` is the default. With documents this small,
  `speed` or `balanced` should answer just as well and sooner. Set it where
  the PAL's knowledge base is configured, if that option is shown.
- **Processing time.** New documents take a few minutes to process after
  upload. Test after they show as ready.
- **Tags.** If you use tags, give all seven the same tag (for example
  `research-hub`) and attach by tag, so a later re-upload only needs the
  same tag.

## When the site changes

Update the matching `kb-*.txt` file here, then re-upload only that file in
Tavus and delete its old copy. If a section, tool or routing rule changes,
update `00-agent-instructions.txt` and paste it again. The short context the
site itself sends at the start of every call is in
`src/components/tavus/guideTools.js` (`initialContext`, `describePage`).

## Test script (two minutes)

1. "Research Stripe's latest funding." → a search runs on Open Research
   without the guide asking permission.
2. "Check Arthur Mensch at Mistral." → Founder Check runs with both fields.
3. "Who in my network can help me raise?" → the guide opens the Network Map
   and points at "Raise capital" in Presets.
4. "Where do I upload my LinkedIn contacts?" → a one-sentence answer naming
   "Upload Connections.csv", no tool call.
5. "What does single-source mean?" → a one-sentence definition.
