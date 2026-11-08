/** @jest-environment jsdom */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OpenSearch from '../../src/components/OpenSearch';

jest.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: {} }) }));
jest.mock('next-auth/react', () => ({ useSession: () => ({ status: 'unauthenticated' }) }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ href, children }) => <a href={href}>{children}</a> }));

jest.mock('../../src/components/ModelSelector', () => function MockModelSelector() {
  return <div data-testid="model-selector">model-selector</div>;
});

jest.mock('../../src/components/SourceSelector', () => function MockSourceSelector(props) {
  const { onCustomSourceAdd, onFileUpload } = props;

  return (
    <div data-testid="source-selector">
      <button type="button" onClick={() => onCustomSourceAdd('https://example.com')}>
        add-custom
      </button>
      <button
        type="button"
        onClick={() => onFileUpload([{ name: 'brief.pdf', content: 'brief body' }])}
      >
        add-file
      </button>
    </div>
  );
});

jest.mock('../../src/components/search/results/SimplifiedLLMResults', () => {
  const MockSimplifiedLLMResults = ({ results }) => (
    <div data-testid="llm-results">{Array.isArray(results) ? `array:${results.length}` : `answer:${String(results.content).slice(0, 20)}`}</div>
  );

  return {
    __esModule: true,
    default: MockSimplifiedLLMResults,
    FollowUpChat: function MockFollowUpChat() {
      return null;
    },
  };
});

const jsonResponse = (data, status = 200) => ({
  ok: status < 400,
  status,
  headers: { get: () => 'application/json' },
  json: async () => data,
  text: async () => JSON.stringify(data),
});

const searchCalls = () => global.fetch.mock.calls.filter(([url]) => url === '/api/search/open');
const lastBody = () => new URLSearchParams(searchCalls().slice(-1)[0][1].body);

describe('OpenSearch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.HTMLElement.prototype.scrollIntoView = jest.fn();
    global.fetch = jest.fn(async (url) => (url === '/api/search/open' ? jsonResponse({ results: [], status: 'fail-soft' }) : jsonResponse({})));
  });
  afterEach(() => { delete global.fetch; });

  const search = (text) => {
    fireEvent.change(screen.getByPlaceholderText('Ask about a company, founder or market…'), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  };

  it('shows the fail-soft message and suggestions from the API on a no-result search, never the raw payload', async () => {
    global.fetch.mockImplementation(async (url) => (url === '/api/search/open'
      ? jsonResponse({
        status: 'fail-soft', results: [], content: null, categories: [], degradedSources: [], answerInfo: null,
        sourceStatuses: [{ source: 'curated', status: 'empty' }, { source: 'web', status: 'not_configured', error: 'Web search is off' }],
        queryPlan: { entity: null, mode: 'topic', intents: [] },
        failSoftContent: { message: 'No source returned results about "asdkjhasd".', suggestions: ['Check the spelling of the company or person', 'Try fewer words'] },
      })
      : jsonResponse({})));

    render(<OpenSearch selectedModel="auto" setSelectedModel={jest.fn()} />);
    search('asdkjhasd');

    await waitFor(() => expect(searchCalls()).toHaveLength(1));
    expect(lastBody().get('query')).toBe('asdkjhasd');
    expect(lastBody().get('useLLM')).toBe('true');
    expect(await screen.findByText('No direct results yet')).toBeTruthy();
    expect(screen.getByText('No source returned results about "asdkjhasd".')).toBeTruthy();
    expect(screen.getByText('Try fewer words')).toBeTruthy();
    expect(screen.getByTestId('llm-results').textContent).toBe('array:0');
    expect(screen.getByTestId('not-configured-note')).toBeTruthy();
    expect(screen.queryByText('Some sources unavailable')).toBeNull();
    expect(screen.queryByText(/Quoted from sources/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/"status":/);
  });

  it('passes a real answer through as the answer object with its provenance line', async () => {
    global.fetch.mockImplementation(async (url) => (url === '/api/search/open'
      ? jsonResponse({
        status: 'ok', results: [{ title: 'OpenAI raises $11B', url: 'https://a.test' }], content: '## SUMMARY\nOpenAI raised $11B [Source 1].',
        answerInfo: { mode: 'quoted', reason: 'AI answers are not enabled on this deployment' }, queryPlan: { entity: 'OpenAI', mode: 'entity', intents: ['funding'], droppedForRelevance: 2 },
        sourceStatuses: [{ source: 'curated', status: 'ok' }], degradedSources: [], olderThanFilter: 3,
      })
      : jsonResponse({})));

    render(<OpenSearch selectedModel="auto" setSelectedModel={jest.fn()} />);
    search('open ai latest funding');

    expect((await screen.findByTestId('llm-results')).textContent).toBe('answer:## SUMMARY\nOpenAI ra');
    expect(screen.getByText(/Quoted from sources/)).toBeTruthy();
    expect(screen.getByText(/3 results were older than the filter/)).toBeTruthy();
    expect(screen.queryByText('No direct results yet')).toBeNull();
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('includes custom urls and uploaded files in open search requests', async () => {
    render(<OpenSearch selectedModel="gpt-4" setSelectedModel={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'add-custom' }));
    fireEvent.click(screen.getByRole('button', { name: 'add-file' }));
    search('operator sourcing');

    await waitFor(() => expect(searchCalls()).toHaveLength(1));
    const body = lastBody();
    expect(body.get('query')).toBe('operator sourcing');
    expect(body.get('mode')).toBe('open');
    expect(body.get('model')).toBe('gpt-4');
    expect(body.getAll('sources')).toEqual(['Curated', 'Web']);
    expect(body.getAll('customUrls')).toEqual(['https://example.com']);
    expect(body.getAll('files')).toEqual([JSON.stringify({ name: 'brief.pdf', content: 'brief body' })]);
  });

  it('does not scroll while typing, and re-runs the search when the date filter changes', async () => {
    render(<OpenSearch selectedModel="auto" setSelectedModel={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Ask about a company, founder or market…'), { target: { value: 'typing' } });
    expect(window.HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Published/), { target: { value: '365' } });
    expect(searchCalls()).toHaveLength(0); // no search yet, nothing to re-run

    search('Ramp');
    await waitFor(() => expect(searchCalls()).toHaveLength(1));
    expect(lastBody().get('maxAgeDays')).toBe('365');

    fireEvent.change(screen.getByLabelText(/Published/), { target: { value: '30' } });
    await waitFor(() => expect(searchCalls()).toHaveLength(2));
    expect(lastBody().get('maxAgeDays')).toBe('30');
  });

  it('shows the service error message when the API fails soft with an error', async () => {
    global.fetch.mockImplementation(async (url) => (url === '/api/search/open'
      ? jsonResponse({ status: 'fail-soft', results: [], content: null, error: 'An error occurred during search', message: 'boom', degradedSources: ['open-search'] })
      : jsonResponse({})));
    render(<OpenSearch selectedModel="auto" setSelectedModel={jest.fn()} />);
    search('Ramp');
    expect(await screen.findByText('boom')).toBeTruthy();
    expect(screen.getByTestId('llm-results').textContent).toBe('array:0');
    expect(screen.getByText('Some sources unavailable')).toBeTruthy();
  });
});
