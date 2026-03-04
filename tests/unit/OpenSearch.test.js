/** @jest-environment jsdom */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import axios from 'axios';
import OpenSearch from '../../src/components/OpenSearch';

jest.mock('axios', () => ({
  post: jest.fn(),
}));

jest.mock('../../src/components/ModelSelector', () => function MockModelSelector() {
  return <div data-testid="model-selector">model-selector</div>;
});

jest.mock('../../src/components/SourceSelector', () => function MockSourceSelector() {
  return <div data-testid="source-selector">source-selector</div>;
});

jest.mock('../../src/components/search/results/SimplifiedLLMResults', () => {
  const MockSimplifiedLLMResults = ({ results }) => (
    <div data-testid="llm-results">{Array.isArray(results) ? results.length : 'llm'}</div>
  );

  return {
    __esModule: true,
    default: MockSimplifiedLLMResults,
    FollowUpChat: function MockFollowUpChat() {
      return null;
    },
  };
});

jest.mock('../../src/utils/isLLMResult', () => ({
  isLLMResult: jest.fn(() => false),
}));

describe('OpenSearch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.HTMLElement.prototype.scrollIntoView = jest.fn();
  });

  it('renders degraded banner and fail-soft empty state after a degraded empty response', async () => {
    axios.post.mockResolvedValue({
      data: {
        status: 'degraded',
        degradedSources: ['Web', 'Custom URL'],
        results: [],
        failSoftContent: {
          exampleQueries: ['Example query one', 'Example query two'],
        },
      },
    });

    render(
      <OpenSearch
        selectedModel="gpt-4"
        setSelectedModel={jest.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Search across sources...'), {
      target: { value: 'operator workflows' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledWith('/api/search', expect.objectContaining({
        query: 'operator workflows',
        mode: 'open',
        useLLM: true,
      }));
    });

    expect(await screen.findByText('Degraded mode active')).toBeTruthy();
    expect(screen.getByText('No direct results yet')).toBeTruthy();
    expect(screen.getByText('Example query one')).toBeTruthy();
    expect(screen.getByTestId('llm-results')).toBeTruthy();
  });
});
