# Tavus PAL tools for Research Hub

Not a knowledge document: do not upload this file to the knowledge base.
Create the three tools below in the PAL Maker from it.

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
Open one of Research Hub's three main sections at once. Call it whenever the
visitor says go to, open, show, take me to or switch to a section, AND
whenever they ask about their own contacts, network, connections, intros,
who they know, or who can help them raise, source deals or diligence (use
network_map for all of those). Sections: open_research (research a company,
founder or market), network_map (their own contacts on a globe),
founder_check (a background brief on one person). Do not ask for
confirmation first.

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
Run an Open Research search and show the cited answer on the page. Call it
immediately, without asking first, whenever the visitor names a company,
market, sector, funding round, investor, product or topic and wants to know
about it: "research", "look up", "search", "find out", "what do we know
about", "tell me about", "who invested in", "how much did they raise", "is
it any good". Write the query as 3 to 10 words, name first, then what they
want, nouns only. If they give only a name, use "<name> funding, investors
and latest news". One subject per call.

**Parameters (JSON schema):**
```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "3 to 10 words, name first then what is wanted, e.g. \"Stripe latest funding round and investors\", \"Mistral AI valuation 2026\", \"vertical AI insurance market size and leaders\"."
    }
  },
  "required": ["query"]
}
```

## 3. `run_founder_check`

**Description:**
Run a Founder Check: a background brief on one person (career, companies,
education, litigation mentions, press, and who in the visitor's network can
help diligence them). Call it immediately whenever the visitor names a
person and wants background on them: "check", "vet", "look into", "who is",
"background on", "can we trust", "reference check". Requires first and last
name; if you have only one name, ask for the other before calling. Always
pass the company when the visitor mentioned one, to avoid mixing up people
with the same name. For a company rather than a person, use run_research.

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
