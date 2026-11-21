/** @jest-environment jsdom */
/**
 * The deep report's "Your network" section says when a lookup did not finish (never "none of your
 * contacts"), and the Network Map's "Checked" chip reopens the finished check by its id.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('next/link', () => function Link({ children, href, ...props }) { return <a href={href} {...props}>{children}</a>; });
jest.mock('next/head', () => function Head({ children }) { return <>{children}</>; });
jest.mock('next/router', () => ({ useRouter: jest.fn() }));
jest.mock('next-auth/react', () => ({ useSession: jest.fn() }));
jest.mock('../../../src/components/account/AccountMenu', () => function AccountMenu() { return null; });
jest.mock('../../../src/components/network/NetworkGraph', () => ({ __esModule: true, default: () => null, SOURCE_COLORS: {} }));

// eslint-disable-next-line import/first
import NetworkLinks from '../../../src/components/founder/NetworkLinks';
// eslint-disable-next-line import/first
import { checkHref } from '../../../src/pages/network';

const base = { available: true, checked: 40, self: null, sameNameContacts: [], groups: [], references: [], counts: { people: 0 }, notes: [], companiesChecked: ['Acme'], investorsChecked: ['Kappa Fund'] };

test('a company lookup that failed is not shown as "none of your contacts"', () => {
  render(<NetworkLinks network={{ ...base, failed: { companies: true, self: true } }} name="Pat Example" />);
  expect(screen.queryByText(/None of your contacts work at/)).toBeNull();
  expect(screen.queryByText(/is not one of your contacts/)).toBeNull();
  expect(screen.getByText('People you know at their companies could not be read just now. Open the report again in a moment.')).toBeTruthy();
  expect(screen.getByText('Whether Pat Example is one of your contacts could not be read just now.')).toBeTruthy();
});

test('when the lookups answered, "none" is said; a failed investor lookup is not counted in it', () => {
  render(<NetworkLinks network={{ ...base, failed: { investors: true } }} name="Pat Example" />);
  expect(screen.getByText('None of your contacts work at Acme.')).toBeTruthy();
});

test('groups say how many more were not listed, people carry their years, references their reason', () => {
  const p = { name: 'Ann Old', company: 'Upfit Labs', position: 'Engineer', relationship: 'direct', years: '2015 – 2017', why: 'Worked at Upfit Labs' };
  render(<NetworkLinks network={{ ...base, seededCompany: 'Acme', groups: [{ key: 'earlier', title: 'At companies they worked at before', total: 9, more: 8, people: [p] }], references: [{ ...p, reason: 'Former colleague', ask: 'Ask how they worked.' }], counts: { people: 9 } }} name="Pat Example" />);
  expect(screen.getByText('8 more not listed; the most senior are shown first.')).toBeTruthy();
  expect(screen.getAllByText(/2015 – 2017/).length).toBeGreaterThan(0);
  expect(screen.getByText('Former colleague')).toBeTruthy();
  expect(screen.getByText(/which you confirmed/)).toBeTruthy();
});

test('the Checked chip links to the finished check itself', () => {
  expect(checkHref({ id: 'job-7', name: 'Pat Example', company: 'Acme' })).toBe('/founder?name=Pat+Example&company=Acme&job=job-7');
  expect(checkHref({ id: 'job-8', name: 'Pat Example', company: '', seededCompany: 'Acme' })).toBe('/founder?name=Pat+Example&company=Acme&job=job-8');
  expect(checkHref({ name: 'Pat Example', company: '' })).toBe('/founder?name=Pat+Example');
});
