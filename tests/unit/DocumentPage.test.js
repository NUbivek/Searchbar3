/** @jest-environment jsdom */

import React from 'react';
import { render, screen } from '@testing-library/react';
import Document from '../../src/pages/_document';

jest.mock('next/document', () => ({
  Html: ({ children, lang }) => (
    <div data-testid="html" data-lang={lang}>
      {children}
    </div>
  ),
  Head: ({ children }) => <div data-testid="head">{children}</div>,
  Main: () => <div data-testid="main" />,
  NextScript: () => <div data-testid="next-script" />,
}));

describe('Custom Document', () => {
  it('renders the document shell with lang and Next primitives', () => {
    render(<Document />);

    expect(screen.getByTestId('html').getAttribute('data-lang')).toBe('en');
    expect(screen.getByTestId('head')).not.toBeNull();
    expect(screen.getByTestId('main')).not.toBeNull();
    expect(screen.getByTestId('next-script')).not.toBeNull();
  });
});
