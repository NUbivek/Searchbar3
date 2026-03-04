/** @jest-environment jsdom */

import React from 'react';
import { render, screen } from '@testing-library/react';
import DemoPage from '../../src/pages/demo';

jest.mock('next/head', () => function MockHead({ children }) {
  return <>{children}</>;
});

jest.mock('../../src/components/demo', () => ({
  IntelligentSearchDemo: function MockIntelligentSearchDemo() {
    return <div data-testid="intelligent-search-demo">demo-body</div>;
  }
}));

describe('Demo page', () => {
  it('renders the demo shell around the intelligent search demo component', () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    render(<DemoPage />);

    expect(screen.getByTestId('intelligent-search-demo').textContent).toContain('demo-body');
    expect(screen.getByText('Intelligent Search Results Platform - Demo')).toBeTruthy();

    consoleErrorSpy.mockRestore();
  });
});
