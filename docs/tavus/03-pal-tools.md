# Tavus PAL tools for Research Hub

Add these three tools to the PAL in the Tavus PAL Maker (or with the Tools
API). The page already handles them (`src/components/tavus/guideTools.js`
and `TavusGuide.js`); the names and parameters must match exactly.

For every tool:
- **Delivery:** app message (`delivery: { "app_message": true }`, the default),
  so the call reaches the page.
- **On resolve:** `generate_response`, so the agent speaks after the page
  replies with the result (for example "Running research for …").

---

## 1. `go_to_section`

**Description (tells the PAL when to use it):**
Take the visitor to one of Research Hub's three main sections. Use when the
visitor asks to go to, open, show or switch to Open Research (research a
company, founder or market), the Network Map (their own contacts and who can
help them raise, source deals or diligence) or Founder Check (a background
brief on one person).

**Parameters (JSON schema):**
```json
{
  "type": "object",
  "properties": {
    "section": {
      "type": "string",
      "enum": ["open_research", "network_map", "founder_check"],
      "description": "Which section to open."
    }
  },
  "required": ["section"]
}
```

## 2. `run_research`

**Description:**
Run an Open Research search for the visitor and show the cited answer on the
page. Use when the visitor asks to research, look up, find out about, or
search for a company, founder, market, funding round or topic. Pass their
request as a concise search query.

**Parameters (JSON schema):**
```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "The search query, e.g. \"Stripe latest funding round and investors\"."
    }
  },
  "required": ["query"]
}
```

## 3. `run_founder_check`

**Description:**
Run a Founder Check: a background brief on one person (career, companies,
education, litigation mentions, press, and who in the visitor's network can
help diligence them). Use when the visitor asks to check, vet or look into a
specific founder or person. Needs the person's first and last name; add the
company when the visitor mentions it, to avoid confusing people with the same
name.

**Parameters (JSON schema):**
```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "The person's full name, first and last, e.g. \"Arthur Mensch\"."
    },
    "company": {
      "type": "string",
      "description": "Optional company to narrow the search, e.g. \"Mistral\"."
    }
  },
  "required": ["name"]
}
```

---

## What the page does with each call

| Tool | Page action | Reply to the agent |
|---|---|---|
| `go_to_section` | Client-side route change to `/`, `/network` or `/founder` (the call keeps going) | `success`: "Opened Network Map." |
| `run_research` | Opens `/?q=<query>`, which runs the search | `success`: "Running research for …" |
| `run_founder_check` | Opens `/founder?name=…&company=…`, which runs the check | `success`: "Running a founder check on …" |
| any bad input | Nothing | `error` with the reason (e.g. "Founder Check needs a first and last name.") |

## What the agent is told about the page

- When a conversation starts: a short description of Research Hub plus the
  page the visitor is on and their current query (`conversational-context`).
- During a call, on every page or query change: an `append_llm_context`
  update such as "Update: The visitor is on Open Research … Their current
  research query is "Anthropic funding"."
