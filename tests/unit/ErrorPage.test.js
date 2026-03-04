/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import ErrorPage from '../../src/pages/_error';

describe('ErrorPage', () => {
  it('renders the server error state and reloads the page', () => {
    const reload = jest.fn();
    const originalLocation = window.location;

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { reload }
    });

    try {
      render(<ErrorPage statusCode={500} />);

      expect(screen.getByRole('heading', { name: 'An error 500 occurred on server' })).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Reload Page' }));

      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation
      });
    }
  });

  it('renders the client error state when no status code is provided', () => {
    render(<ErrorPage />);

    expect(screen.getByRole('heading', { name: 'An error occurred on client' })).toBeTruthy();
  });

  it('derives the status code from next error context', () => {
    expect(ErrorPage.getInitialProps({ res: { statusCode: 503 } })).toEqual({ statusCode: 503 });
    expect(ErrorPage.getInitialProps({ err: { statusCode: 418 } })).toEqual({ statusCode: 418 });
    expect(ErrorPage.getInitialProps({})).toEqual({ statusCode: 404 });
  });
});
