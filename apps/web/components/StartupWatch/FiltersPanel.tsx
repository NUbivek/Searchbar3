import React from 'react';
import { Disclosure } from '@headlessui/react';
import StageFilter from './Filters/StageFilter';
import GeoFilter from './Filters/GeoFilter';
import FundingRangeFilter from './Filters/FundingRangeFilter';
import ThesisTagFilter from './Filters/ThesisTagFilter';
import SourceFilter from './Filters/SourceFilter';
import ConfidenceFilter from './Filters/ConfidenceFilter';
import StatusFilter from './Filters/StatusFilter';

const stages = ['stealth','pre-seed','seed','series-a','series-b','series-c','unknown'];

export function FiltersPanel({ filters = {}, onFilterChange }: any) {
  return (
    <aside className="w-80 bg-white border rounded p-3 text-sm overflow-y-auto max-h-[75vh]">
      <div className="font-semibold mb-2">Filters</div>

      <Disclosure defaultOpen>
        <Disclosure.Button className="w-full text-left font-medium py-1">A) Company + Stage</Disclosure.Button>
        <Disclosure.Panel>
          <StageFilter title="Stage">
            <div className="grid grid-cols-2 gap-1">
              {stages.map((s) => (
                <label key={s} className="text-xs flex gap-1 items-center">
                  <input type="checkbox" checked={(filters.stage || []).includes(s)} onChange={(e) => {
                    const curr = new Set(filters.stage || []);
                    e.target.checked ? curr.add(s) : curr.delete(s);
                    onFilterChange('stage', Array.from(curr));
                  }} /> {s}
                </label>
              ))}
            </div>
          </StageFilter>
        </Disclosure.Panel>
      </Disclosure>

      <Disclosure>
        <Disclosure.Button className="w-full text-left font-medium py-1">B) Geography</Disclosure.Button>
        <Disclosure.Panel><GeoFilter title="HQ Country"><input className="border rounded px-2 py-1 w-full" placeholder="US, CA..." onBlur={(e)=>onFilterChange('hq_country', e.target.value ? [e.target.value] : [])}/></GeoFilter></Disclosure.Panel>
      </Disclosure>

      <Disclosure>
        <Disclosure.Button className="w-full text-left font-medium py-1">C) Funding & Traction</Disclosure.Button>
        <Disclosure.Panel><FundingRangeFilter title="Funding"><div className="grid grid-cols-2 gap-2"><input type="number" className="border rounded px-2 py-1" placeholder="min" onBlur={(e)=>onFilterChange('min_funding', e.target.value ? Number(e.target.value) : undefined)}/><input type="number" className="border rounded px-2 py-1" placeholder="max" onBlur={(e)=>onFilterChange('max_funding', e.target.value ? Number(e.target.value) : undefined)}/></div></FundingRangeFilter></Disclosure.Panel>
      </Disclosure>

      <Disclosure>
        <Disclosure.Button className="w-full text-left font-medium py-1">D) Thesis / Tags</Disclosure.Button>
        <Disclosure.Panel><ThesisTagFilter title="Tags"><input className="border rounded px-2 py-1 w-full" placeholder="agtech" onBlur={(e)=>onFilterChange('tags', e.target.value ? [e.target.value] : [])}/></ThesisTagFilter></Disclosure.Panel>
      </Disclosure>

      <Disclosure>
        <Disclosure.Button className="w-full text-left font-medium py-1">E) Source / Quality</Disclosure.Button>
        <Disclosure.Panel>
          <SourceFilter title="Source key"><input className="border rounded px-2 py-1 w-full" placeholder="techcrunch" onBlur={(e)=>onFilterChange('source_key', e.target.value ? [e.target.value] : [])}/></SourceFilter>
          <ConfidenceFilter title="Min confidence"><input type="range" min="0" max="1" step="0.05" defaultValue={filters.min_confidence || 0} onChange={(e)=>onFilterChange('min_confidence', Number(e.target.value))} /></ConfidenceFilter>
        </Disclosure.Panel>
      </Disclosure>

      <Disclosure>
        <Disclosure.Button className="w-full text-left font-medium py-1">F) Workflow Status</Disclosure.Button>
        <Disclosure.Panel><StatusFilter title="Status"><select className="border rounded px-2 py-1 w-full" onChange={(e)=>onFilterChange('status', e.target.value ? [e.target.value] : [])}><option value="">Any</option><option value="new">new</option><option value="reviewed">reviewed</option><option value="shortlisted">shortlisted</option><option value="rejected">rejected</option><option value="contacted">contacted</option></select></StatusFilter></Disclosure.Panel>
      </Disclosure>
    </aside>
  );
}
