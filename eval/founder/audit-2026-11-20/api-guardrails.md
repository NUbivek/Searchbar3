# Privacy guardrails: functions for other engineers (round 3)

Module: `src/server/founder/guardrails.js`. It has no Node or network dependencies, so the page can import it too.
Health words now count only when they describe a person ("he was diagnosed", "her depression"). A company's or a
study's subject ("a diabetes-care startup", "a thesis on chemotherapy", "an HIV drug patent") is kept.

## cleanSentences(text, opts?) -> { text, removed, dropped }
The main cleaner. It removes each sentence or line about health, religion, sexuality, immigration, political
donations, children, infobox birth, spouse or parents fields, or a relative with no stated public role. In the
sentences it keeps, it redacts phones, emails, ID numbers, street lines, P.O. boxes, dates of birth and ages. It
never drops the whole text for one bad sentence.
- `opts.keepStreets`: keep office street lines (official company register entries only).
- `opts.kin`: `false` skips the relatives rule (short labels); `'notices'` applies only the wedding and death-notice part.
- `removed` counts by reason: `health, religion, sexuality, immigration, politics, minor, relatives, personal-details, phone, email, id, address, location, dob, age`.

```js
cleanSentences('Jane Doe founded Acme. She was treated for anxiety. Call 415-555-0100.')
// { text: 'Jane Doe founded Acme. Call [phone removed].', removed: { health: 1, phone: 1 }, dropped: 1 }
```
Quick brief: run it on each search result's title and snippet before ranking, and drop the result when its text comes back empty.

## cleanModelText(text, opts?) -> { text, removed }
For text a model wrote. It strips `<script>`/HTML, images and links that are not http(s) or that point to blocked
sites (a link keeps its words). It then cleans line by line, keeping markdown markers and the `[Source n]`
citations of kept sentences. Re-check citations afterwards: a removed line takes its citations with it.
```js
cleanModelText('- Holmes founded Theranos [Source 1].\n- Holmes has two children [Source 3].').text
// '- Holmes founded Theranos [Source 1].'
```

## privacyReason(text, { kin }?) -> string | null
The reason one sentence must not be used, or null. Use it for single lines, such as profile lines.
`privacyReason('Milton married Carrie in 2010.') // 'relatives'`

## cleanData(value, opts?) -> { data, removed }
Walks an object or array recursively. It drops personal fields (`dob`, `phone`, `email`, `spouse`, ...) and links
that are not http(s). It leaves identifier fields as they are (`caseNumber`, `accession`, ...), and cleans every
other string. Strings shorter than 4 words skip the relatives rule, so `relation: 'father'` stays.
`cleanData({ role: 'lives at 12 Elm Street', website: 'javascript:x' }).data // { role: '[location removed]' }`

## isSafeUrl(url) -> boolean, safeHref(url) -> string | null
Accepts only absolute http(s) links. Use `safeHref` for every `<a href>` on the page (`f.url`, profile links,
NetworkLinks `p.profileUrl`, the quick brief's Sources list). When it returns null, render plain text.
`safeHref('javascript:alert(1)') // null`

## sanitizeFinding(finding) -> finding | null (changed)
Returns null when the url is not http(s) or is blocked, the record is an unconfirmed obituary, the title is
private, or every sentence of a non-empty quote was removed. Otherwise only the bad sentences go, and `data` is
cleaned with cleanData. Office street lines stay only when `isCompanyRegisterEntry(finding)` is true
(`uk-companies-house`, `fr-companies`, `us-state-registries`, `lei-register`, `sec-company` with category
`corporate`).

## Other exports
- `redactPII(text, { keepStreets }?) -> string`: redaction only. Dates of birth now lose the year too:
  `'born on March 3, 1984 in Lyon'` becomes `'born in Lyon'`.
- `isSensitive(text)` now also covers political donations. `mentionsMinor(text)` now also covers minors' initials
  in court captions, "has two children" and infobox "Children 3".
- `isBlockedUrl(url)` now also blocks FEC individual-contribution pages, OpenSecrets donor lookups and followthemoney.org.
- `isCompanyRegisterEntry(finding)` and `isOfficialRecord(finding)` return booleans.

## finding.js
- `makeFinding` refuses links that are not http(s). It runs the rules on the full text before clipping, so a
  phone number cut at the clip no longer leaks. It cleans the title, the quote and all of `data`. `gradeText` is
  cleaned by the same rules.
- `makeThread('url', v)` refuses links that are not http(s), and `why` is cleaned.
