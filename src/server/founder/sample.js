/**
 * A small, entirely fictional check (invented person, company and records)
 * used to try the report writer and the second reader against real models
 * without sending anything about a real person. See /api/debug/llm-check.
 */
import { startState } from './deepCheck';
import { restoreSubject } from './identity';
import { makeFinding } from './finding';

export function sampleState() {
  const state = startState({ name: 'Jordan Quillfeather', company: 'Lumenfold Robotics' });
  state.threads['company|lumenfold'] = { kind: 'company', value: 'Lumenfold Robotics', trusted: true, pulled: true, depth: 1, support: 3, tie: 'primary', why: 'the company given' };
  const subject = restoreSubject(state);
  const f = (o) => makeFinding(subject, { source: 'sample', url: `https://records.example/${encodeURIComponent(o.title.slice(0, 40))}`, ...o });
  state.findings = [
    f({ sourceLabel: 'Sample court register', category: 'litigation', severity: 'medium', date: '2019-04-02', title: 'Brightwater Capital v. Jordan Quillfeather and Lumenfold Robotics', quote: 'Brightwater Capital sued Jordan Quillfeather and Lumenfold Robotics for breach of a convertible note. The case settled in November 2019 on undisclosed terms.' }),
    f({ sourceLabel: 'Sample regulator', category: 'regulatory', severity: 'high', date: '2016-09-14', title: 'Regulator bars Jordan Quillfeather from acting as a director for three years', quote: 'Jordan Quillfeather, then chief executive of Tidewater Drones, accepted a three-year director disqualification after Tidewater Drones failed to file accounts. Lumenfold Robotics was founded after the bar ended.' }),
    f({ sourceLabel: 'Sample news', category: 'press', date: '2023-02-10', title: 'Lumenfold Robotics founder Jordan Quillfeather on warehouse automation', quote: 'Before Lumenfold Robotics, Jordan Quillfeather ran Tidewater Drones and studied mechanical engineering at Harrowgate Institute of Technology. Her brother, Casey Quillfeather, the chief financial officer of Lumenfold Robotics, joined in 2021.' }),
    f({ sourceLabel: 'Sample web archive', category: 'archive', severity: 'medium', date: '2022-06-01', title: 'Profile: degree changed from "MSc Mechanical Engineering, Harrowgate Institute of Technology" to "Coursework, Harrowgate Institute of Technology" between 2018-03 and 2022-06', quote: 'Before (2018-03-11): "MSc Mechanical Engineering, Harrowgate Institute of Technology" After (2022-06-01): "Coursework, Harrowgate Institute of Technology". Profile of Jordan Quillfeather, Lumenfold Robotics.', data: { kind: 'change', field: 'education', change: 'changed' } }),
    f({ sourceLabel: 'Sample company register', category: 'corporate', date: '2020-01-15', title: 'Lumenfold Robotics Ltd: Jordan Quillfeather appointed director', quote: 'Jordan Quillfeather was appointed a director of Lumenfold Robotics Ltd on 15 January 2020. Co-director: Morgan Ashdown.' }),
    f({ sourceLabel: 'Sample patent office', category: 'ip', date: '2021-08-20', title: 'Patent: Gripper with compliant fingers', quote: 'Inventor Jordan Quillfeather; assignee Lumenfold Robotics; filed 20 August 2021.' }),
    f({ sourceLabel: 'Sample court register', category: 'litigation', severity: 'medium', date: '2012-05-05', title: 'State v. Jordan Quillfeather', quote: 'Jordan Quillfeather of Dayton was charged with driving without insurance.' }),
  ].filter(Boolean);
  state.sources = {
    sample: { label: 'Sample registers', runs: 9, findings: state.findings.length, errors: 0 },
    off: { label: 'Sample dockets', runs: 0, findings: 0, errors: 0, off: true, lastError: 'Not enabled on this deployment.' },
  };
  state.tasksRun = 9;
  state.step = 2;
  state.phase = 'report';
  return state;
}
