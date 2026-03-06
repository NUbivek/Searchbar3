import React from 'react';
import StageBadge from '../../components/StartupWatch/Cells/StageBadge';
import SourceBadge from '../../components/StartupWatch/Cells/SourceBadge';
import ConfidenceBar from '../../components/StartupWatch/Cells/ConfidenceBar';
import ThesisTagChips from '../../components/StartupWatch/Cells/ThesisTagChips';

export default function Demo() {
  return <main className="p-6 space-y-4"><h1>Startup Watch Components Demo</h1><div className="flex gap-2">{['stealth','pre-seed','seed','series-a','series-b','series-c','unknown'].map(s=><StageBadge key={s} stage={s}/> )}</div><SourceBadge sourceKey="techcrunch" tier={2}/><ConfidenceBar confidence={0.3}/><ConfidenceBar confidence={0.6}/><ConfidenceBar confidence={0.85}/><ThesisTagChips tags={['agtech','robotics','supply-chain','ml','ops']} /></main>
}
