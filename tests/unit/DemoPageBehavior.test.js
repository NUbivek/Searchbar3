/** @jest-environment jsdom */

import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';

jest.mock('next/head', () => ({
  __esModule: true,
  default: ({ children }) => <>{children}</>,
}));

jest.mock('../../src/components/demo', () => ({
  __esModule: true,
  IntelligentSearchDemo: function MockIntelligentSearchDemo() {
    return <div data-testid="intelligent-search-demo" />;
  },
}));

import DemoPage from '../../src/pages/demo';

describe('DemoPage', () => {
  it('renders the demo shell and footer copy', () => {
    render(<DemoPage />);

    expect(screen.getByTestId('intelligent-search-demo')).toBeInTheDocument();
    expect(
      screen.getByText('Intelligent Search Results Platform - Demo')
    ).toBeInTheDocument();
  });
});
