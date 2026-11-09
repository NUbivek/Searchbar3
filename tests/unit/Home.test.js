/** @jest-environment jsdom */

import React from 'react';
import { render, screen } from '@testing-library/react';
import Home from '../../src/pages/index';

jest.mock('../../src/components/account/AccountMenu', () => function MockAccountMenu() {
  return <a href="/signin">Sign in</a>;
});

jest.mock('next/router', () => ({ useRouter: () => ({ pathname: '/', query: {}, isReady: true, push: jest.fn() }) }));

jest.mock('next/head', () => function MockHead({ children }) {
  return <>{children}</>;
});

jest.mock('next/link', () => function MockLink({ href, className, children }) {
  return (
    <a href={href} className={className}>
      {children}
    </a>
  );
});

jest.mock('@headlessui/react', () => {
  function MockTab({ children, className }) {
    const resolvedClassName = typeof className === 'function'
      ? className({ selected: false })
      : className;

    return <button className={resolvedClassName}>{children}</button>;
  }

  MockTab.Group = function MockTabGroup({ children }) {
    return <div data-testid="tab-group">{children}</div>;
  };

  MockTab.List = function MockTabList({ children, className }) {
    return <div className={className}>{children}</div>;
  };

  MockTab.Panels = function MockTabPanels({ children, className }) {
    return <div className={className}>{children}</div>;
  };

  MockTab.Panel = function MockTabPanel({ children }) {
    return <div>{children}</div>;
  };

  return { Tab: MockTab };
});

jest.mock('../../src/components/OpenSearch', () => function MockOpenSearch(props) {
  return (
    <div data-testid="open-search">
      model:{props.selectedModel}
      setter:{typeof props.setSelectedModel}
    </div>
  );
});

describe('Home page', () => {
  it('renders the app shell and wires OpenSearch with the default model', () => {
    render(<Home />);

    const networkLink = screen.getAllByText('Network Map')[0].closest('a');
    const openSearch = screen.getByTestId('open-search');

    expect(screen.getByRole('heading', { name: 'Research any company, founder or market' })).toBeTruthy();
    expect(screen.getByText(/written from cited sources/)).toBeTruthy();
    expect(screen.getByText('Research Hub', { selector: 'span' }).closest('a').getAttribute('href')).toBe('/');
    expect(networkLink?.getAttribute('href')).toBe('/network');
    expect(screen.getAllByText('Founder Check')[0].closest('a').getAttribute('href')).toBe('/founder');
    expect(openSearch.textContent).toContain('model:auto'); // best available free model
    expect(openSearch.textContent).toContain('setter:function');
  });
});
