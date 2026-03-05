/** @jest-environment jsdom */
import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import DemoPage from '../../src/pages/demo';

jest.mock('next/head', () => ({
  __esModule: true,
  default: ({ children }) => <>{children}</>,
}));

jest.mock('../../src/components/demo', () => ({
  IntelligentSearchDemo: () => <div data-testid="intelligent-search-demo">Mock Demo</div>,
}));

describe('DemoPage', () => {
  it('renders the demo component', () => {
    render(<DemoPage />);

    expect(screen.getByTestId('intelligent-search-demo')).toBeInTheDocument();
    expect(screen.getByText('Mock Demo')).toBeInTheDocument();
  });

  it('renders the page title and footer copy', () => {
    render(<DemoPage />);

    expect(screen.getByText('Intelligent Search Demo')).toBeInTheDocument();
    expect(screen.getByText('Intelligent Search Results Platform - Demo')).toBeInTheDocument();
  });
});
