/**
 * Who the person is, laid out like a résumé, and what the records say of
 * their company. Every line shows the records it came from.
 *
 * "To confirm with the person" holds leads: things a record suggests but
 * does not tie to them (a name-only record naming an employer their own bio
 * gives, say). They are questions for the call, never facts, so they sit
 * apart from the résumé under their own heading.
 */
import React from 'react';
import { Block, Cites, ExternalLink } from './parts';
import { yearsOf, sortRoles } from './resumeText';

export { yearsOf };

const PLATFORM_LABEL = { linkedin: 'LinkedIn', x: 'X', github: 'GitHub', crunchbase: 'Crunchbase', wikipedia: 'Wikipedia', substack: 'Substack', wellfound: 'Wellfound', indeed: 'Indeed', medium: 'Medium', youtube: 'YouTube' };

/** The roles to show: the profile's own list, or (a report saved before roles were read) the headline and earlier employers. */
function rolesOf(profile) {
  if (Array.isArray(profile.roles)) return sortRoles(profile.roles);
  const now = profile.headline ? [{ org: profile.company || '', title: profile.headline, current: true, cites: profile.headlineCites, whole: true }] : [];
  return [...now, ...(profile.earlier || []).map((e) => ({ org: e.org, title: e.role, current: false, cites: e.cites }))];
}

function Line({ main, detail = null, when = '', cites, extra = null }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-1.5">
      <span className="font-medium text-ink">{main}</span>
      {detail ? <span className="text-slate-700">· {detail}</span> : null}
      {when ? <span className="text-xs text-muted">{when}</span> : null}
      {extra}
      <Cites ns={cites} />
    </li>
  );
}

function Row({ label, id, children }) {
  return (
    <div id={id} className="grid scroll-mt-24 gap-1 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[9rem_1fr]">
      <dt className="eyebrow pt-0.5">{label}</dt>
      <dd className="text-sm text-slate-700">{children}</dd>
    </div>
  );
}

const list = (items, render) => <ul className="space-y-1.5">{items.map(render)}</ul>;
const has = (x) => Array.isArray(x) && x.length > 0;

/** Profile (résumé) card. */
export function ProfileCard({ profile }) {
  if (!profile) return null;
  const roles = rolesOf(profile);
  const education = profile.education || [];
  const patternsOnly = profile.readBy && profile.readBy !== 'model';
  const note = (
    <div className="mb-3 space-y-1 text-xs text-muted">
      <p>Read from public pages tied to this person. Each line links to the record it came from; a line no record states is left out.</p>
      {patternsOnly && (
        <p data-testid="profile-patterns-note">
          Read by text patterns only; some earlier roles, degrees or board seats may be missing. Check the records below.
        </p>
      )}
    </div>
  );
  return (
    <Block title="Profile" id="profile" open note={note}>
      {(profile.headline || profile.basedIn) && (
        <div className="mb-3">
          {profile.headline && <p className="text-base font-semibold text-ink">{profile.headline}<Cites ns={profile.headlineCites} /></p>}
          {profile.basedIn && <p className="text-xs text-muted">Based in {profile.basedIn.text}<Cites ns={profile.basedIn.cites} /></p>}
        </div>
      )}
      <dl className="divide-y divide-line">
        {roles.length > 0 && (
          <Row label="Experience" id="profile-career">
            {list(roles, (r, i) => (
              r.whole
                ? <Line key={`now-${i}`} main={r.title} when="present" cites={r.cites} />
                : <Line key={`${r.org}-${r.title || ''}-${i}`} main={r.org} detail={r.title} when={yearsOf(r)} cites={r.cites} extra={r.current && !yearsOf(r) ? <span className="text-xs text-muted">current</span> : null} />
            ))}
          </Row>
        )}
        {education.length > 0 && (
          <Row label="Education" id="profile-education">
            {list(education, (e, i) => (
              // "left without a degree" is shown: a school alone reads as a degree earned
              <Line key={`${e.school}-${i}`} main={e.school} detail={[e.degree, e.field, e.note].filter(Boolean).join(', ') || null} when={yearsOf(e)} cites={e.cites} />
            ))}
          </Row>
        )}
        {has(profile.founded) && (
          <Row label="Founded">
            {list(profile.founded, (e, i) => (
              <Line
                key={`${e.org}-${i}`}
                main={e.org}
                detail={[e.program, has(e.with) ? `with ${e.with.join(', ')}` : null, e.outcome].filter(Boolean).join(' · ') || null}
                when={e.year ? String(e.year) : ''}
                cites={e.cites}
              />
            ))}
          </Row>
        )}
        {has(profile.boards) && (
          <Row label="Boards and advisory">
            {list(profile.boards, (e, i) => <Line key={`${e.org}-${i}`} main={e.org} detail={e.role} when={yearsOf(e)} cites={e.cites} />)}
          </Row>
        )}
        {has(profile.investments) && (
          <Row label="Investments">
            {list(profile.investments, (e, i) => <Line key={`${e.org || e.text}-${i}`} main={e.org || e.text} detail={e.org && e.text && e.text !== e.org ? e.text : null} cites={e.cites} />)}
          </Row>
        )}
        {has(profile.recognition) && (
          <Row label="Recognition">
            {list(profile.recognition, (e, i) => <Line key={`${e.text || e.title}-${i}`} main={e.text || e.title} when={e.year ? String(e.year) : ''} cites={e.cites} />)}
          </Row>
        )}
        {has(profile.about) && (
          <Row label="Background">
            <ul className="space-y-2">{profile.about.map((a, i) => <li key={`${a.text}-${i}`}>“{a.text}”<Cites ns={a.cites} /></li>)}</ul>
          </Row>
        )}
        {has(profile.links) && (
          <Row label="Public profiles">
            <span className="flex flex-wrap gap-1.5">
              {profile.links.map((l) => (
                <ExternalLink key={l.url} href={l.url} className="chip" title={l.also ? 'Also found: may be an older or second account' : undefined}>
                  {PLATFORM_LABEL[l.platform] || l.platform}{l.also ? ' (also found)' : ''}
                </ExternalLink>
              ))}
            </span>
          </Row>
        )}
      </dl>
      {has(profile.leads) && (
        <div className="mt-4 rounded-xl border border-line bg-slate-50 px-3.5 py-3" data-testid="profile-leads">
          <h3 className="eyebrow mb-1">To confirm with the person</h3>
          <p className="mb-2 text-xs text-muted">Leads, not facts: a record suggests these but does not tie them to this person. Ask about them.</p>
          <ul className="space-y-1.5 text-sm text-slate-700">
            {profile.leads.map((l, i) => (
              <li key={`${l.text}-${i}`}>
                <span className="text-ink">{l.text}</span>
                {l.why && <span className="block text-xs text-muted">{l.why}</span>}
                <Cites ns={l.cites} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Block>
  );
}

/** What the records say of the company: legal names, founded, funding rounds, investors, standing. */
export function CompanyCard({ facts, company }) {
  if (!facts) return null;
  const legal = facts.legalNames || [];
  const domains = facts.domains || [];
  const funding = facts.funding || [];
  const investors = facts.investors || [];
  const standing = facts.standing || [];
  if (!legal.length && !domains.length && !facts.founded && !funding.length && !investors.length && !standing.length) return null;
  return (
    <Block
      title={company ? `Company: ${company}` : 'Company'}
      id="company"
      open
      note={<p className="muted mb-3 text-xs">What the records found say about the company. Each line links to the record it came from.</p>}
    >
      <dl className="divide-y divide-line">
        {legal.length > 0 && <Row label="Legal names">{list(legal, (x, i) => <Line key={`${x.name}-${i}`} main={x.name} cites={x.cites} />)}</Row>}
        {domains.length > 0 && <Row label="Websites">{list(domains, (x, i) => <Line key={`${x.domain}-${i}`} main={x.domain} cites={x.cites} />)}</Row>}
        {facts.founded && <Row label="Founded"><span className="font-medium text-ink">{facts.founded.year}</span><Cites ns={facts.founded.cites} /></Row>}
        {funding.length > 0 && (
          <Row label="Funding">
            {list(funding, (x, i) => (
              <li key={`${x.round}-${x.date}-${i}`} className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="font-medium text-ink">{[x.round, x.amount].filter(Boolean).join(', ') || 'Funding round'}</span>
                {x.date && <span className="text-xs text-muted">{x.date}</span>}
                {x.lead && <span className="text-slate-700">· led by {x.lead}</span>}
                {has(x.investors) && <span className="text-slate-700">· with {x.investors.join(', ')}</span>}
                <Cites ns={x.cites} />
              </li>
            ))}
          </Row>
        )}
        {investors.length > 0 && (
          <Row label="Investors">
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              {investors.map((x, i) => <span key={`${x.name}-${i}`}><span className="text-ink">{x.name}</span><Cites ns={x.cites} /></span>)}
            </span>
          </Row>
        )}
        {standing.length > 0 && <Row label="Standing">{list(standing, (x, i) => <Line key={`${x.text}-${i}`} main={x.text} cites={x.cites} />)}</Row>}
      </dl>
    </Block>
  );
}
