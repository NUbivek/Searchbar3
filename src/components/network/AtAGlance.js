/**
 * "Your network at a glance": what the uploaded file holds, in plain words
 * (built by profileNetwork, counts bold), the shortcuts built from it, and
 * the ask box with three example questions taken from the file.
 */
import React from 'react';
import { HiOutlineMagnifyingGlass, HiOutlineSparkles } from 'react-icons/hi2';
import Shortcuts from './Shortcuts';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');

/**
 * One sentence of the read-out, from profileNetwork's parts: only the pieces
 * marked as counts are bold, so a number inside a tag or a name ("met 2026")
 * stays plain (R7, B10). A plain string (an older profile) is shown as it is.
 */
export function Sentence({ parts }) {
  if (!Array.isArray(parts)) return <>{String(parts || '')}</>;
  return (
    <>
      {parts.map((p, i) => (p.bold
        ? <strong key={i} className="font-semibold text-ink">{p.text}</strong>
        : <React.Fragment key={i}>{p.text}</React.Fragment>))}
    </>
  );
}

const AtAGlance = React.forwardRef(function AtAGlance({
  profile, pressedId, onToggle, onEveryone, everyoneActive,
  question, onQuestion, onAsk, asking, askError, onExample, allHidden = false,
}, ref) {
  const examples = profile.questions || [];
  // A fixed placeholder built from the file: no rotating text.
  const placeholder = examples[0] ? `Ask about your network, e.g. ${examples[0].text}` : 'Ask about your network';
  return (
    <section ref={ref} className="card card-pad space-y-4" aria-labelledby="glance-heading">
      <div>
        <h2 id="glance-heading" className="section-title">Your network at a glance</h2>
        <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-slate-700" data-testid="readout">
          {/* Every source chip turned off leaves nobody to describe: say why instead of an empty paragraph. */}
          {allHidden ? 'All sources are hidden. Turn one back on to see your network.' : (profile.parts || profile.sentences).map((s, i) => (
            <React.Fragment key={i}>{i > 0 && ' '}<Sentence parts={s} /></React.Fragment>
          ))}
        </p>
      </div>
      {!allHidden && <Shortcuts
        everyone={profile.everyone}
        shortcuts={profile.shortcuts}
        more={profile.more}
        pressedId={pressedId}
        onToggle={onToggle}
        onEveryone={onEveryone}
        everyoneActive={everyoneActive}
      />}
      <div>
        <form onSubmit={(e) => { e.preventDefault(); onAsk(); }} className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <HiOutlineMagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" style={{ width: 16, height: 16 }} />
            <input
              type="text"
              value={question}
              onChange={(e) => onQuestion(e.target.value)}
              placeholder={placeholder}
              aria-label="Ask your network"
              maxLength={500}
              className="input pl-9"
            />
          </div>
          <button type="submit" disabled={asking || !question.trim()} className="btn-primary sm:px-5">
            <HiOutlineSparkles style={{ width: 15, height: 15 }} /> {asking ? 'Searching…' : 'Ask'}
          </button>
        </form>
        {examples.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Example questions">
            <span className="text-xs text-muted">Try</span>
            {examples.map((q) => (
              <button key={q.text} type="button" onClick={() => onExample(q.text)} disabled={asking} className="chip min-h-9 hover:text-ink disabled:opacity-50 sm:min-h-0">
                {q.text} <span className="text-muted">{fmt(q.count)}</span>
              </button>
            ))}
          </div>
        )}
        {askError && <p role="alert" className="mt-2 text-sm text-rose-600">{askError}</p>}
      </div>
    </section>
  );
});

export default AtAGlance;
