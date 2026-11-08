/** @jest-environment jsdom */

import React from 'react';
import { render, screen } from '@testing-library/react';
import MyApp from '../../src/pages/_app';

jest.mock('@vercel/analytics/react', () => ({
  Analytics: function MockAnalytics() {
    return <div data-testid="analytics" />;
  },
}));

// The real SessionProvider fetches /api/auth/session on mount, which has no
// fetch in jsdom and crashes the Jest worker.
jest.mock('next-auth/react', () => ({
  SessionProvider: function MockSessionProvider({ children }) {
    return <div data-testid="session-provider">{children}</div>;
  },
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

describe('App shell', () => {
  it('renders the page component inside the session provider with analytics', () => {
    function MockPage(props) {
      return <div data-testid="page-component">page:{props.label}</div>;
    }

    render(<MyApp Component={MockPage} pageProps={{ label: 'ready' }} />);

    expect(screen.getByTestId('session-provider')).toBeTruthy();
    expect(screen.getByTestId('page-component').textContent).toBe('page:ready');
    expect(screen.getByTestId('analytics')).toBeTruthy();
  });

  it('does not pass the session object down to the page', () => {
    const seen = [];
    function MockPage(props) {
      seen.push(props);
      return null;
    }

    render(<MyApp Component={MockPage} pageProps={{ session: { user: { id: 'u1' } }, label: 'x' }} />);

    expect(seen[0]).toEqual({ label: 'x' });
  });
});
