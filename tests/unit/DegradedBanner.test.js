/** @jest-environment jsdom */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import DegradedBanner from '../../src/components/search/DegradedBanner';

describe('DegradedBanner', () => {
  it('renders nothing when degraded sources are missing', () => {
    const { container } = render(<DegradedBanner degradedSources={[]} status="degraded" />);

    expect(container.firstChild).toBeNull();
  });

  it('renders status and toggles source details', () => {
    render(<DegradedBanner degradedSources={['Web', 'Custom URL']} status="degraded" />);

    expect(screen.getByText('Degraded mode active')).toBeTruthy();
    expect(screen.getByText(/status: degraded/)).toBeTruthy();
    expect(screen.queryByText('Web')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));

    expect(screen.getByText('Web')).toBeTruthy();
    expect(screen.getByText('Custom URL')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }));

    expect(screen.queryByText('Web')).toBeNull();
  });
});
