# Identity matcher: what other files can call

One matcher now decides "does this text name the person, and their company?" for both the quick brief
(`src/server/founderCheck.js`) and the deep check (`src/server/founder/identity.js`). The shared code is in
`src/server/founder/names.js`. Positions are always given in the caller's original text.

## Names (`founder/names.js`)

**`personNameMatcher(name)`** returns `test(text) -> boolean` (the full name is written), with:
- `.positions(text)`: `[{ start, end, text, kind: 'full' | 'reversed-comma' }]`
- `.weakPositions(text)`: the weaker kinds, never the full name: `'reversed'` (surname first, no comma),
  `'initials'`, `'nickname'`, `'longer-surname'`, `'other-middle'`, `'other-suffix'`, `'other-given'`
- `.kind(text)`: `'full'`, one of the weak kinds, or `'none'`
- `.parts`: the parsed name

Example: `personNameMatcher('Eric Glyman')('GLYMAN, ERIC M, officer')` is `true`.
`personNameMatcher('John Smith').kind('John Smith-Jones said')` is `'longer-surname'`.

The full name accepts middle names and initials, titles and suffixes, accents either way, a hyphen or a space
inside a given name, "Surname, Given" and register capitals.

**`parsePersonName(raw)`** returns `{ display, given, middles, surname, suffix, title, tokens }`.
Example: `parsePersonName('Dr. Eric M. Glyman Jr.')` gives given `'Eric'`, middles `['M.']`, surname `'Glyman'`,
suffix `'jr'`.

**`cleanPersonName(raw)`** returns the name without titles or suffixes, in Given Surname order.
Example: `'Glyman, Eric'` gives `'Eric Glyman'`.

**`personNameVariants(name)`** returns the search forms: the name as typed, then given name plus surname.
Example: `'Elizabeth Anne Holmes'` gives `['Elizabeth Anne Holmes', 'Elizabeth Holmes']`.

**`isCommonName(name)`** returns a boolean. **`nameCommonness(name)`** returns
`{ common, givenCommon, surnameCommon }`.
Example: `isCommonName('Wei Zhang')` is `true` and `isCommonName('Trevor Milton')` is `false`.

**`foldAccents(s)`** and **`foldWithMap(s)`** fold accents one character for one.
Example: `foldAccents('José')` is `'Jose'`.

## Companies (`founder/names.js`)

**`isOrdinaryWordCompany(company)`** returns a boolean: whether the company is named with one ordinary word.
Example: `isOrdinaryWordCompany('Merge Labs')` is `true` and `isOrdinaryWordCompany('Theranos')` is `false`.

**`companyMention(company, text, { aliases?, person?, personWords? })`** returns
`{ named, strength, spans: [{ start, end, strength, how }] }`. The strengths are:
- `'strong'`: a legal form, a domain or handle, or a learned legal name
- `'marker'`: an ordinary word used as a company
- `'plain'`: a distinctive name written as a name

`person` is a name matcher. A mention right beside the person also counts ("Jane Roe of Ramp",
"Jane Roe - Ramp | LinkedIn").

Example: `companyMention('Merge', 'Merge raises $55M Series B led by Accel').named` is `true`.
`companyMention('Merge', 'Mainnet Merge Announcement').named` is `false`.

**`companyMentionMatcher(company, opts)`** is the reusable form: `(text) -> the same result`. `opts.aliases` may
be a function, so aliases learned later are seen.

**`companyMatchForms(company)`** returns `[{ form, ordinary, multi }]`: the forms that may be looked for in text.
A leftover key never stands alone.
Example: `companyMatchForms('Bank of America')` gives `[{ form: 'bank of america', ... }]`.

**`companyKeys(company)`** returns the grouping key. Its output is unchanged and it is re-exported by
founderCheck.js. **`companyKeyStrict(name)`** removes the legal form only.

**`isBroadOrganisation(name)`** returns `true` for universities, parties, government bodies, associations and very
large employers.

## Closeness (`founder/names.js`)

**`nameNearCompany(text, namePos, companySpan, { isSelf, companySpans })`** returns a boolean. The two must be in
the same sentence (up to 250 characters apart) or in neighbouring sentences (up to 120 characters apart). The
company must not be given to another person in between, and the name must not be tied to another organisation
("John Smith of Morgan Stanley"). Two exceptions:
- A whole field of a record written as fields ("Jane Roe | Acme | ...") ties the whole record.
- A company domain or handle need not be close.

**`cooccurrences(text, namePositions, companySpans, opts)`** returns `[{ name, company }]` pairs.

**`isWholeField(text, start, end)`** says whether the span is a whole `" | "` or `"; "` field.

**`describedAsSomeoneElse(text, namePos)`** is `true` after "John Smith, a Utah man" or "John Smith, 45,".

## Quick brief (`founderCheck.js`)

- **`nameMatcher(name | variants[])`** now uses `personNameMatcher`. It adds `.weakPositions` and `.parts`;
  `.re` and `.variants` are kept.
- **`nameVariants(name)`** keeps its old behaviour: it drops middle initials only, and also strips titles and
  suffixes.
- **`normalizePersonName(name)`** also strips titles and suffixes and reads "Surname, Given".
- **`companyMatcher(company, { person })`** is new as an export. It returns `test(text)`, `.spans(text)` and
  `.near(text, hasName)`. The quick brief keeps a page only when `.near` holds or the page is a profile already
  tied to the person.

## Deep check (`identity.js`)

**`matchSubject(subject, text, { date })`** returns `{ level, reasons, basis?, weak? }`.
- `basis` lists the anchors that carried the grade: `company`, `schools`, `people`, `handles`, `domains`,
  `related`, `event`, `role` or `reversed-name`.
- A grade carried only by `related` or `event` should not make a record's threads trusted.
- `weak` is set on `'none'` results when a weaker form of the name was seen.

**`addCompanyAlias(subject, { company, alias, origin })`** returns a boolean. It learns a fuller legal name or a
domain of a known company, from a record tied by more than the bare word.
- Example: `addCompanyAlias(s, { company: 'Ramp', alias: 'Ramp Business Corp', origin: 'form-d-1' })`. After it,
  "Ramp Business UK Ltd" ties to Ramp, but "Ramp Network" does not.
- `exportAnchors` writes the alias as `aliases: [{ value, of, origin }]`, and `restoreSubject` reads it back.

**`addEventAnchor(subject, { event, date, origin, docket? })`** now takes an optional `docket`. The anchor counts
only for a shared docket, or for a record dated 14 days before to 120 days after the event that does not describe
someone else. It never counts for a common name. `docket` is exported and restored.

**`addAnchor(..., 'encyclopedia')`** refuses broad organisations.

**`subject.common`** is `true` for a very common name. Such a name needs the company, or a nearby school,
associate, handle or domain, to go above possible.

## Round 3, second pass (identity2): other names, large employers, other scripts, outcomes

### Other names of the person (`identity.js`)

**`createSubject({ name, company, otherNames })`**: `otherNames` is a list (or one string split on `;` or new
lines) of names the user typed for the same person: a former or maiden name, an anglicised name, the name in
another script. They are graded exactly like the main name (`subject.hasName` matches them). New fields:
- `subject.otherNames`: the typed names, cleaned (`['Jane Smith']`).
- `subject.searchNames`: every search form, main name first (`['Jane Doe', 'Jane Smith']`). `subject.variants` is
  unchanged (main name only), so sources that want the old names must loop over `searchNames`.
- `subject.mononym`: `true` for a one-word name in a spaced script ("Budi"). Such a subject is tied only with the
  company beside the name, and then `'likely'` unless a second fact (school, associate, handle, domain, another
  company, the role they held) is there. The name alone gives `'none'` (`weak: 'mononym-without-company'`); the
  name followed or preceded by another capitalised name word ("Budi Santoso") gives `'none'` with
  `weak: 'longer-name'`.

**`addNameAlias(subject, { alias, origin })`** returns `true` when new. Use it for a name found in a record already
tied to the person (Wikidata "also known as" or birth name, "formerly known as", "née"). Refused: one-word names,
the person's own name, a known name. A record naming the person only under such an alias is graded `'likely'` at
most, with `'alias'` in `basis` and a reason "names the person as X, another name found in a linked record".

**`findNameAliases(subject, text)`** returns `[{ name, how }]` for "née Smith" (given name kept), "formerly known
as", "also known as" / "a.k.a.", "born X Y", read only right after the person's full name. Turn each into a
thread with `makeThread('alias', name, why)` and only from a record graded confirmed or likely.

**Saving and restoring.** `exportAnchors(subject).otherNames` is `[{ value, origin, typed }]`: typed names have
`origin: 'given', typed: true`; found ones `typed: false`. `restoreSubject({ name, company, otherNames?, anchors })`
takes the typed names from `otherNames` when given, else from the saved entries with `typed: true`, and re-adds the
found ones through `addNameAlias`. `addAnchor(..., 'otherNames', ...)` is refused: use the two calls above.

### Large employers

**`isLargeEmployer(name)`** (`names.js`, new): every `isBroadOrganisation` case plus more very large employers
(Nvidia, Infosys, HSBC, Capital One, ...). `isBroadOrganisation` keeps its old list and meaning.
A company anchor that is a large employer is stored with `broad: true`. In `matchSubject`, the full name beside
only such a company ("John Smith, a Google engineer") is `'likely'`, with a reason saying a second fact is needed;
with a school, associate, handle, domain, a second company anchor or a matching role anchor it is `'confirmed'`.
`describedAsSomeoneElse` now also reads "John Smith, a Google engineer in Ohio," as someone ordinary and local.

### Legal forms and scripts (`names.js`)

`companyKeyStrict`, `companyKeys` and `companyMatchForms` strip legal forms written at the end of a name in many
countries (Pvt Ltd, Private Limited, Pte Ltd, Ltda, Sdn Bhd, JSC, PJSC, OOO, AB, AS, ApS, Oy, Kft, sp. z o.o.,
S.A. de C.V., S.r.l., S.p.A., KK, GK, GmbH, SAS, dotted or not) and "PT" before a name. Only at the end, after
another word, so "As Seen On Screen" keeps "as". Example: `companyKeys('Zepto Technologies Private Limited')` is
`['zepto']`. Letters of every script are kept: `companyKeys('Яндекс')` is `['яндекс']`. A name in a script
written without spaces (Han, kana, Hangul, Thai) is found inside a run of letters, both for companies
(`companyMention('字节跳动', '张一鸣是字节跳动的创始人。')`) and people (`personNameMatcher('张一鸣')` is a full
name, not a one-word name). `nameTokens` keeps letters of every script; `slugCandidates` returns `[]` for a name
not written in plain Latin letters. `personNameMatcher(name).mononym` is new.

### Outcome of a legal matter

**`matterOutcome(text, { person })`** (`names.js`) returns `{ outcome, role, phrase, rest }`:
- `outcome`: `'acquitted' | 'overturned' | 'vacated' | 'dismissed' | 'dropped' | 'won' | 'pardoned' | null`.
  A denied motion to dismiss is not a dismissal; 'won' needs `person` (who won).
- `role`: `'defendant' | 'plaintiff' | 'witness' | 'victim' | 'juror' | null` (needs `person`, a name matcher such
  as `subject.hasName`); defendant wins when both are read.
- `phrase` / `rest`: the words that state the outcome, and the text without them.

`severityFromText(text, subject)` uses it: an exculpatory outcome is `'low'` (or `'medium'` if a non-criminal
adverse matter remains), unless the text still reports another criminal matter ("acquitted on two counts but
convicted of wire fraud" stays high); a pardon is `'medium'`; the person as plaintiff, witness, victim or juror and
not accused is `'low'`. Store the outcome on the finding (`data.outcome`) so the report can show it beside the
matter: `makeFinding` should call `matterOutcome(text, { person: subject.hasName })`.

`THREAD_KINDS` (finding.js) now includes `'alias'`.
