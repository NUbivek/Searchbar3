/**
 * Evidence tab: what the sources actually say, for diligence.
 *
 * Replaces the old "Key Insights" view, which showed fixed placeholder
 * scores (Relevance 85%, Accuracy 82%, Credibility 88%, every source 95%).
 * Everything here is quoted from a source and linked; no scores are invented.
 */
import React from 'react';
import { FUNDING_RE, FACT_RE, cleanText, resultDate, sourceLabel, sourceType, extractMatching } from '../../../utils/evidence';

const card = { border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 16px', marginBottom: 16, background: '#fff' };
const h3 = { fontSize: 15, fontWeight: 600, margin: '0 0 8px' };
const muted = { color: '#6b7280', fontSize: 13 };

function sourcesFrom(data) {
  if (Array.isArray(data)) return data.filter((r) => r && typeof r === 'object' && (r.url || r.link));
  if (data && Array.isArray(data.results)) return data.results.filter((r) => r && (r.url || r.link));
  return [];
}

function Quote({ item }) {
  const { sentence, index, result } = item;
  const date = resultDate(result);
  return (
    <li style={{ marginBottom: 6 }}>
      {sentence}{' '}
      <a href={result.url || result.link} target="_blank" rel="noopener noreferrer" style={muted}>
        ({sourceLabel(result)}{date ? `, ${date}` : ''}) [{index + 1}]
      </a>
    </li>
  );
}

export default function EvidencePanel({ data }) {
  const sources = sourcesFrom(data);
  if (sources.length === 0) {
    return <p style={muted}>No sources to show for this search.</p>;
  }

  const dates = sources.map(resultDate).filter(Boolean).sort();
  const curated = sources.filter((s) => s.source === 'curated').length;
  const portfolio = sources.filter((s) => s.type === 'portfolio_listing');
  const funding = extractMatching(sources, FUNDING_RE, 8);
  const facts = extractMatching(sources, FACT_RE, 10).filter((f) => !funding.some((x) => x.sentence === f.sentence));

  return (
    <div>
      <div style={card}>
        <h3 style={h3}>Coverage</h3>
        <p style={{ margin: 0 }}>
          {sources.length} source{sources.length === 1 ? '' : 's'}
          {curated ? `, ${curated} from your curated sources` : ''}
          {dates.length ? `, dated ${dates[0]} to ${dates[dates.length - 1]}` : ''}.
        </p>
        <p style={{ ...muted, margin: '6px 0 0' }}>
          Quotes below are taken word for word from the sources. Check the original before relying on a figure.
        </p>
      </div>

      {funding.length > 0 && (
        <div style={card}>
          <h3 style={h3}>Funding and investor mentions</h3>
          <ul style={{ paddingLeft: 18, margin: 0 }}>{funding.map((f) => <Quote key={f.sentence} item={f} />)}</ul>
        </div>
      )}

      {portfolio.length > 0 && (
        <div style={card}>
          <h3 style={h3}>Investor portfolio listings</h3>
          <ul style={{ paddingLeft: 18, margin: 0 }}>
            {portfolio.map((p) => (
              <li key={p.url} style={{ marginBottom: 4 }}>
                <a href={p.url} target="_blank" rel="noopener noreferrer">{cleanText(p.title)}</a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {facts.length > 0 && (
        <div style={card}>
          <h3 style={h3}>Figures and facts</h3>
          <ul style={{ paddingLeft: 18, margin: 0 }}>{facts.map((f) => <Quote key={f.sentence} item={f} />)}</ul>
        </div>
      )}

      <div style={card}>
        <h3 style={h3}>Sources</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#6b7280' }}>
              <th style={{ padding: '4px 6px' }}>#</th>
              <th style={{ padding: '4px 6px' }}>Title</th>
              <th style={{ padding: '4px 6px' }}>Source</th>
              <th style={{ padding: '4px 6px' }}>Type</th>
              <th style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>Date</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s, i) => (
              <tr key={`${s.url || s.link}-${i}`} style={{ borderTop: '1px solid #f3f4f6', verticalAlign: 'top' }}>
                <td style={{ padding: '4px 6px' }}>{i + 1}</td>
                <td style={{ padding: '4px 6px' }}>
                  {(s.url || s.link) && (s.url || s.link) !== '#'
                    ? <a href={s.url || s.link} target="_blank" rel="noopener noreferrer">{cleanText(s.title).slice(0, 120)}</a>
                    : cleanText(s.title).slice(0, 120)}
                </td>
                <td style={{ padding: '4px 6px' }}>{sourceLabel(s)}</td>
                <td style={{ padding: '4px 6px' }}>{sourceType(s)}</td>
                <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>{resultDate(s) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
