/** @jest-environment jsdom */

import React from 'react';
import { render, screen } from '@testing-library/react';
import MyApp from '../../src/pages/_app';

jest.mock('@vercel/analytics/react', () => ({
  Analytics: function MockAnalytics() {
    return <div data-testid="analytics" />;
  },
}));

describe('App shell', () => {
  it('renders the page component and analytics wrapper', () => {
    function MockPage(props) {
      return <div data-testid="page-component">page:{props.label}</div>;
    }

    render(<MyApp Component={MockPage} pageProps={{ label: 'ready' }} />);

    expect(screen.getByTestId('page-component').textContent).toBe('page:ready');
    expect(screen.getByTestId('analytics')).toBeTruthy();
  });
});
