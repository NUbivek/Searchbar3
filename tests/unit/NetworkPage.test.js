/** @jest-environment jsdom */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import NetworkPage from '../../src/pages/network';

jest.mock('next/head', () => {
  return function Head({ children }) {
    return <>{children}</>;
  };
});

jest.mock('next/link', () => {
  return function Link({ children, href, ...props }) {
    return <a href={href} {...props}>{children}</a>;
  };
});

jest.mock('next/router', () => ({
  useRouter: jest.fn()
}));

jest.mock('@headlessui/react', () => ({
  Tab: Object.assign(
    ({ children, className }) => {
      const resolvedClassName = typeof className === 'function'
        ? className({ selected: true })
        : className;
      return <button className={resolvedClassName}>{children}</button>;
    },
    {
      Group: ({ children }) => <div>{children}</div>,
      List: ({ children, className }) => <div className={className}>{children}</div>
    }
  )
}));

jest.mock('axios');
jest.mock('../../src/components/NetworkDebug', () => {
  return function NetworkDebugMock() {
    return <div data-testid="network-debug">Network Debug</div>;
  };
});

const { useRouter } = require('next/router');

describe('NetworkPage', () => {
  beforeEach(() => {
    useRouter.mockReturnValue({
      query: {},
      replace: jest.fn()
    });

    axios.get.mockImplementation((url) => {
      if (url === '/api/auth/linkedin/token') {
        return Promise.resolve({ data: { isAuthenticated: false } });
      }

      if (url === '/api/auth/twitter/token') {
        return Promise.resolve({
          status: 200,
          data: { authenticated: false }
        });
      }

      return Promise.resolve({ data: {} });
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the network shell with disconnected auth state', async () => {
    render(<NetworkPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Research Hub' })).toBeTruthy();
      expect(screen.getByPlaceholderText('Search your network...')).toBeTruthy();
      expect(screen.getByRole('heading', { name: 'Network Visualization' })).toBeTruthy();
      expect(screen.getByText('Connect to your accounts using the buttons at the top right to visualize your network')).toBeTruthy();
      expect(screen.getByText('Statistics')).toBeTruthy();
      expect(screen.getByTestId('network-debug')).toBeTruthy();
      expect(axios.get).toHaveBeenCalledWith('/api/auth/linkedin/token');
      expect(axios.get).toHaveBeenCalledWith(
        '/api/auth/twitter/token',
        expect.objectContaining({
          validateStatus: false,
          params: expect.objectContaining({ retry: 0 })
        })
      );
    });

    expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: '' }).hasAttribute('disabled')).toBe(true);
  });
});
