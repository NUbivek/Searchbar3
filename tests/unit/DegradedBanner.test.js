/** @jest-environment jsdom */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import DegradedBanner from '../../src/components/search/DegradedBanner';

describe('DegradedBanner', () => {
  it('renders nothing when degraded sources are missing', () => {
    const { container } = render(<DegradedBanner degradedSources={[]} status="degraded" />);

    expect(container.firstChild).toBeNull();
  });

  it('names unavailable sources and shows the reason for each on demand', () => {
    render(<DegradedBanner degradedSources={['web', 'custom']} status="degraded" sourceStatuses={[{ source: 'web', status: 'error', error: 'No SERPER_API_KEY or TAVILY_API_KEY configured' }]} />);

    expect(screen.getByText('Some sources unavailable')).toBeTruthy();
    expect(screen.getByText(/Web, Your URLs are unavailable for this search/)).toBeTruthy();
    expect(screen.queryByText(/No SERPER_API_KEY/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));

    expect(screen.getByText(/No SERPER_API_KEY or TAVILY_API_KEY configured/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }));

    expect(screen.queryByText(/No SERPER_API_KEY/)).toBeNull();
  });
});
