# Network Map rebuild: what I saw in a real browser (2026-11-21, local dev, invented samples)

Method: built-in browser on http://localhost:3009/network as the local test user. The pane is hidden, so the
browser fires no animation frames; I reload the page through document.write with requestAnimationFrame driven
by setTimeout (see "shim" below). Samples are served from public/_samples/*.json (TEMPORARY: delete before commit)
and loaded with DELETE then POST /api/network/contacts.

Shim reload snippet (javascript_tool):
  const html = await fetch('/network', { headers: { accept: 'text/html' } }).then((r) => r.text());
  const shim = '<script>window.requestAnimationFrame = function (cb) { return setTimeout(function () { cb(performance.now()); }, 16); }; window.cancelAnimationFrame = function (id) { clearTimeout(id); }; window.__rafShim = true;</' + 'script>';
  setTimeout(() => { document.open(); document.write(html.replace('<head>', '<head>' + shim)); document.close(); }, 50);

## Works
- Read-out, chips, examples render for VC-like (525), healthcare (239), sales CRM (328). Counts match the tests.
- Pressing a chip: panel title "at Stripe · 22", "22 lit" on the globe, 22 rows. Clinicians: 100 lit dots clearly seen.
- Ask example "Who do I know in Austin?": answer in the panel ("Answer · 27", "In Austin"), 27 lit, page scrolls to map.
- Remove all: confirm, then "All of your network data was removed." and the empty state; no console error.
- Arrange by Company: instant (was 31 s). By place: countries. Sales CRM opens By tag.
- Phone (375): no sideways scroll; panel above globe. Night mode: legible, lit dots clear.

## Defects to fix (B = browser)
B1 (major). By role's first layer on the globe and the panel's group rows are still the four FIXED groups
   ("Founders & executives / Operators & talent / Investors & LPs / Experts & advisors"). Healthcare file: read-out
   says "100 clinicians and 64 researchers" but the globe says "Experts & advisors 135". The first layer must be the
   file's own families (same words as the read-out and chips), largest first, small ones folded into one last group.
B2 (major). Chips combine by AND: after pressing one chip the others relabel to intersection counts and the zero
   ones are disabled ("0 investors", "0 at Google", "1 engineers"). A user cannot go from Stripe to Google with one
   click and the card looks as if the network shrank. Change: a click on a chip SWITCHES to it (press again or
   Clear to go back to everyone); chip labels and counts never change. Narrowing moves into the people panel as a
   "Narrow to" row: other shortcuts with a non-zero, smaller intersection, each with its count; pressing one adds it
   (up to three in all), shown as removable parts of the title. Singular/plural must be right wherever a count is 1.
B3 (minor). Row tags are wordy: "finance or accounting person", "sales or marketing person", "product or design
   person", "researcher or academic". Use a short tag per family (Finance, Sales & marketing, Product & design...).
B4 (minor). After pressing a chip the breadcrumb under the globe changes to a group the user never opened
   ("All > Experts & advisors 135") because the camera turned. The breadcrumb should follow what the user opened,
   not where the camera happens to look during a selection.
B5 (major). By tag: the globe/panel group counts (prospect 89, customer 53, partner 53) disagree with the chips and
   read-out (107, 73, 69) because a person with several tags sits under one tag only. Show the tag's full count on
   the group (and say in the hint how many sit elsewhere); clicking a tag group selects everyone with the tag.
B6 (major). By company: "Other companies 116" is the largest bubble, faces the viewer and is listed first in the
   panel's group rows; the biggest named companies carry no label at whole-globe view. The largest NAMED company
   should face the viewer, the top companies should be labelled, and "Other companies" goes last/back.
B7 (minor). Answer panel title is "Answer · 27"; it should say what the list is ("In Austin · 27", or the question).
B8 (major on phones). At 375 px the people list shows only one and a half people (group rows eat the space);
   give the list real height on phones.
B10 (minor). LP list read-out: "By tag: 23 cold, 23 met 2026, 20 committed." The number inside the tag name
   ("2026") is set in bold like a count. Quote tag names in the sentence and bold only the counts.
B11 (minor). An opened row shows the classifier's internal line: "Title and company: lp / allocator · Tagged
   passed". Say it plainly ("Counted as an investor from the title" / "Tagged “passed”") or leave the role line out.
B12 (major). Clicking on the globe is unreliable: LP list, By tag, whole-globe view: a click just above the
   "COMMITTED 20" label selected "cold · 23" (the big front cluster); then, with cold selected, a click exactly on the
   dimmed "COMMITTED 20" label did nothing. A click on any group label or hub must select that group, also while
   another selection is active; a click on empty space inside a big cluster must not select a different group than
   the label nearest the pointer.
B13 (minor). A selection made on the globe that equals a shortcut (tag "cold" = chip 23 tagged "cold") does not
   show that chip as pressed.
B14 (minor). Small file (22 people), Find "blue" (6 at Bluebird Labs): the camera faces the lit people head-on, so
   the "You" marker at the centre sits on top of them and the rest of the globe is empty. When the lit set is tight,
   zoom in to it and keep "You" off the lit dots.
B15 (works). Find "blue": title 'Find “blue” · 6', 6 lit, six rows. Rows open in place with Company profile, Founder
   check and Intro paths; the globe draws a dashed path to the opened person.
B9 (note). Dev page does not start in a hidden pane (Next dev waits for an animation frame). Not a product defect.
