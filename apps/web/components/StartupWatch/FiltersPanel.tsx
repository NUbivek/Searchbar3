import React from 'react';
import { Disclosure } from '@headlessui/react';
import StageFilter from './Filters/StageFilter';
import GeoFilter from './Filters/GeoFilter';
import FundingRangeFilter from './Filters/FundingRangeFilter';
import ThesisTagFilter from './Filters/ThesisTagFilter';
import SourceFilter from './Filters/SourceFilter';
import ConfidenceFilter from './Filters/ConfidenceFilter';
import StatusFilter from './Filters/StatusFilter';

const stages = ['stealth', 'pre-seed', 'seed', 'series-a', 'series-b', 'series-c', 'unknown'];

const sectionButton = 'w-full rounded-lg px-2 py-2 text-left text-sm font-semibold text-slate-700 transition hover:bg-slate-100';
const inputCls = 'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none ring-blue-500/50 focus:ring';

export function FiltersPanel({ filters = {}, onFilterChange }: any) {
  return (
    <aside className="w-80 max-h-[75vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-3 text-sm shadow-sm">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Filters</div>

      <Disclosure defaultOpen>
        <Disclosure.Button className={sectionButton}>A) Company + Stage</Disclosure.Button>
        <Disclosure.Panel className="px-1 pb-2">
          <StageFilter title="Stage">
            <div className="grid grid-cols-2 gap-2">
              {stages.map((s) => (
                <label key={s} className="flex items-center gap-2 rounded-lg border border-slate-100 px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-50">
                  <input
                    type="checkbox"
                    checked={(filters.stage || []).includes(s)}
                    onChange={(e) => {
                      const curr = new Set(filters.stage || []);
                      e.target.checked ? curr.add(s) : curr.delete(s);
                      onFilterChange('stage', Array.from(curr));
                    }}
                  />
                  <span>{s}</span>
                </label>
              ))}
            </div>
          </StageFilter>
        </Disclosure.Panel>
      </Disclosure>

      <Disclosure>
        <Disclosure.Button className={sectionButton}>B) Geography</Disclosure.Button>
        <Disclosure.Panel className="px-1 pb-2">
          <GeoFilter title="HQ Country">
            <input className={inputCls} placeholder="US, CA..." onBlur={(e) => onFilterChange('hq_country', e.target.value ? [e.target.value] : [])} />
          </GeoFilter>
        </Disclosure.Panel>
      </Disclosure>

      <Disclosure>
        <Disclosure.Button className={sectionButton}>C) Funding & Traction</Disclosure.Button>
        <Disclosure.Panel className="px-1 pb-2">
          <FundingRangeFilter title="Funding">
            <div className="grid grid-cols-2 gap-2">
              <input type="number" className={inputCls} placeholder="min" onBlur={(e) => onFilterChange('min_funding', e.target.value ? Number(e.target.value) : undefined)} />
              <input type="number" className={inputCls} placeholder="max" onBlur={(e) => onFilterChange('max_funding', e.target.value ? Number(e.target.value) : undefined)} />
            </div>
          </FundingRangeFilter>
        </Disclosure.Panel>
      </Disclosure>

      <Disclosure>
        <Disclosure.Button className={sectionButton}>D) Thesis / Tags</Disclosure.Button>
        <Disclosure.Panel className="px-1 pb-2">
          <ThesisTagFilter title="Tags">
            <input className={inputCls} placeholder="agtech" onBlur={(e) => onFilterChange('tags', e.target.value ? [e.target.value] : [])} />
          </ThesisTagFilter>
        </Disclosure.Panel>
      </Disclosure>

      <Disclosure>
        <Disclosure.Button className={sectionButton}>E) Source / Quality</Disclosure.Button>
        <Disclosure.Panel className="space-y-2 px-1 pb-2">
          <SourceFilter title="Source key">
            <input className={inputCls} placeholder="techcrunch" onBlur={(e) => onFilterChange('source_key', e.target.value ? [e.target.value] : [])} />
          </SourceFilter>
          <ConfidenceFilter title="Min confidence">
            <input type="range" min="0" max="1" step="0.05" defaultValue={filters.min_confidence || 0} onChange={(e) => onFilterChange('min_confidence', Number(e.target.value))} />
          </ConfidenceFilter>
        </Disclosure.Panel>
      </Disclosure>

      <Disclosure>
        <Disclosure.Button className={sectionButton}>F) Workflow Status</Disclosure.Button>
        <Disclosure.Panel className="px-1 pb-2">
          <StatusFilter title="Status">
            <select className={inputCls} onChange={(e) => onFilterChange('status', e.target.value ? [e.target.value] : [])}>
              <option value="">Any</option>
              <option value="new">new</option>
              <option value="reviewed">reviewed</option>
              <option value="shortlisted">shortlisted</option>
              <option value="rejected">rejected</option>
              <option value="contacted">contacted</option>
            </select>
          </StatusFilter>
        </Disclosure.Panel>
      </Disclosure>
    </aside>
  );
}
