/** @jest-environment jsdom */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import axios from 'axios';
import VerifiedSearch from '../../src/components/VerifiedSearch';

jest.mock('axios', () => ({
  post: jest.fn(),
}));

jest.mock('../../src/utils/search-legacy', () => ({
  processWithLLM: jest.fn(),
}));

jest.mock('../../src/components/SourceSelector', () => function MockSourceSelector(props) {
  const { onSourceToggle, onCustomSourceAdd, onFileUpload } = props;

  return (
    <div data-testid="source-selector">
      <button type="button" onClick={() => onSourceToggle('linkedin')}>
        toggle-linkedin
      </button>
      <button type="button" onClick={() => onSourceToggle('github')}>
        toggle-github
      </button>
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

jest.mock('../../src/components/search/results', () => ({
  IntelligentSearchResults: function MockIntelligentSearchResults() {
    return null;
  },
  SimpleLLMResults: function MockSimpleLLMResults({ results }) {
    return (
      <div data-testid="simple-llm-results">
        {results.map((item, index) => (
          <div key={index}>
            {typeof item.content === 'string' ? item.content : JSON.stringify(item.content)}
          </div>
        ))}
      </div>
    );
  },
}));

describe('VerifiedSearch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.HTMLElement.prototype.scrollIntoView = jest.fn();
  });

  it('submits verified searches and renders LLM results from the API', async () => {
    axios.post.mockResolvedValue({
      data: {
        llmResults: {
          summary: 'Verified operator summary',
        },
      },
    });

    render(
      <VerifiedSearch
        selectedModel="gpt-4"
        setSelectedModel={jest.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'add-custom' }));
    fireEvent.click(screen.getByRole('button', { name: 'add-file' }));

    fireEvent.change(screen.getByPlaceholderText('Search verified sources...'), {
      target: { value: 'operator diligence' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledWith(
        '/api/search',
        expect.objectContaining({
          query: 'operator diligence',
          mode: 'verified',
          useLLM: true,
          model: 'gpt-4',
          sources: ['linkedin', 'twitter', 'reddit'],
          customUrls: ['https://example.com'],
          files: [{ name: 'brief.pdf', content: 'brief body' }],
        }),
        expect.objectContaining({
          timeout: 120000,
        })
      );
    });

    expect(await screen.findByText('operator diligence')).toBeTruthy();
    expect(screen.getByText(JSON.stringify({ summary: 'Verified operator summary' }))).toBeTruthy();
  });

  it('renders API error messages in the follow-up results area', async () => {
    axios.post.mockRejectedValue({
      response: {
        data: {
          error: 'Verified search backend failed',
        },
      },
    });

    render(
      <VerifiedSearch
        selectedModel="gpt-4"
        setSelectedModel={jest.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Search verified sources...'), {
      target: { value: 'failing query' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    expect(await screen.findByText('Verified search backend failed')).toBeTruthy();
  });

  it('updates the network map when sources are toggled', async () => {
    render(
      <VerifiedSearch
        isNetworkMapMode={true}
        selectedModel="gpt-4"
        setSelectedModel={jest.fn()}
      />
    );

    expect(screen.getByText('linkedin')).toBeTruthy();
    expect(screen.queryByText('github')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'toggle-github' }));

    expect(await screen.findByText('github')).toBeTruthy();
  });
});
