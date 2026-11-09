/** @jest-environment jsdom */
/**
 * Network Map page: shell, empty states, sign-in notice, no sample data.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import NetworkPage from '../../src/pages/network';

jest.mock('next/head', () => function Head({ children }) { return <>{children}</>; });
jest.mock('next/link', () => function Link({ children, href, ...props }) { return <a href={href} {...props}>{children}</a>; });
jest.mock('next/router', () => ({ useRouter: jest.fn() }));
jest.mock('next-auth/react', () => ({ useSession: jest.fn() }));
jest.mock('../../src/components/account/AccountMenu', () => function AccountMenu() { return <div>account</div>; });
jest.mock('../../src/components/network/NetworkGraph', () => ({
  __esModule: true,
  default: function NetworkGraphMock() { return <div data-testid="graph" />; },
  SOURCE_COLORS: { linkedin: '#0077B5', x: '#000', csv: '#6B7280' },
}));

const { useRouter } = require('next/router');
const { useSession } = require('next-auth/react');

describe('NetworkPage', () => {
  beforeEach(() => {
    // PageShell's TopBar reads router.pathname to mark the active section.
    useRouter.mockReturnValue({ isReady: true, pathname: '/network', query: {}, replace: jest.fn() });
    global.fetch = jest.fn(async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes('linkedin') ? { isAuthenticated: false } : { authenticated: false }),
    }));
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete global.fetch;
  });

  it('signed out: shell, import options, sign-in notice and empty states', async () => {
    useSession.mockReturnValue({ data: null, status: 'unauthenticated' });
    render(<NetworkPage />);
    expect(screen.getByRole('heading', { name: 'Network Map' })).toBeTruthy();
    // The shell: the three-flow switch and the quiet secondary links
    expect(screen.getAllByText('Open Research')[0].closest('a').getAttribute('href')).toBe('/');
    expect(screen.getAllByText('Founder Check')[0].closest('a').getAttribute('href')).toBe('/founder');
    expect(screen.getByText('Workspaces').closest('a').getAttribute('href')).toBe('/workspaces');
    expect(screen.getByText('Watchlist').closest('a').getAttribute('href')).toBe('/watchlist');
    expect(screen.queryByText('Research')).toBeNull();
    expect(screen.getByText('Connect LinkedIn')).toBeTruthy();
    expect(screen.getByText('Connect X')).toBeTruthy();
    expect(screen.getByText('Upload LinkedIn Connections.csv')).toBeTruthy();
    expect(screen.getByText('Upload CSV/XLSX contacts')).toBeTruthy();
    expect(screen.getByText('Sign in to save your network')).toBeTruthy();
    expect(screen.getByText('No contacts yet')).toBeTruthy();
    expect(screen.getByPlaceholderText('Search your network...')).toBeTruthy();
    expect(screen.queryByTestId('graph')).toBeNull();
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/auth/linkedin/token'));
    expect(global.fetch).not.toHaveBeenCalledWith('/api/network/contacts');
  });

  it('signed in: loads saved contacts and draws the graph', async () => {
    useSession.mockReturnValue({ data: { user: { name: 'Test User' } }, status: 'authenticated' });
    global.fetch = jest.fn(async (url) => ({
      ok: true,
      status: 200,
      json: async () => {
        if (url === '/api/network/contacts') {
          return {
            contacts: [{ name: 'Ana Synthetic', company: 'Stripe', position: 'Engineer', source: 'linkedin', tags: [] }],
            stats: { total: 1, bySource: { linkedin: 1, csv: 0, x: 0 }, lastImportAt: null, lastImportBySource: {} },
          };
        }
        return {};
      },
    }));
    render(<NetworkPage />);
    await waitFor(() => expect(screen.getByTestId('graph')).toBeTruthy());
    expect(screen.getByText('Saved to your account')).toBeTruthy();
    expect(screen.getByText('Remove all my network data')).toBeTruthy();
  });

  it('offers Connect LinkedIn / Connect X even when not configured: an inline note, no redirect', async () => {
    useSession.mockReturnValue({ data: null, status: 'unauthenticated' });
    global.fetch = jest.fn(async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes('linkedin')
        ? { isAuthenticated: false, configured: false }
        : { authenticated: false, configured: false }),
    }));
    render(<NetworkPage />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/auth/twitter/token'));
    fireEvent.click(screen.getByText('Connect LinkedIn'));
    fireEvent.click(screen.getByText('Connect X'));
    expect(screen.getByText("LinkedIn connection isn't available on this deployment yet.")).toBeTruthy();
    expect(screen.getByText("X connection isn't available on this deployment yet.")).toBeTruthy();
    expect(screen.queryByText(/paid|tier|API/)).toBeNull();
  });
});
