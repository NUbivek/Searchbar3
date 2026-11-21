/** @jest-environment jsdom */
/**
 * Round 6, the page's contact note: it names exactly the sites given the signed-in person's name and email,
 * as the server reports them ('account', 'account-sec', 'account-site'), and says nothing for 'operator' or 'none'.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('next/link', () => function MockLink({ href, children, ...props }) { return <a href={href} {...props}>{children}</a>; });
jest.mock('next-auth/react', () => ({ useSession: () => ({ status: 'authenticated', data: {} }) }));

// eslint-disable-next-line import/first
import { ContactNote } from '../../../src/components/founder/DeepCheck';

const note = (contact) => {
  const { unmount } = render(<ContactNote contact={contact} />);
  const el = screen.queryByTestId('contact-note');
  const text = el ? el.textContent : null;
  unmount();
  return text;
};

describe('the contact note', () => {
  test('all three sites: the SEC, the FTC and crates.io are named', () => {
    const t = note('account');
    expect(t).toMatch(/SEC/);
    expect(t).toMatch(/FTC/);
    expect(t).toMatch(/crates\.io/);
  });

  test('the SEC only (the operator names itself to the FTC and crates.io): neither of those is named', () => {
    const t = note('account-sec');
    expect(t).toMatch(/SEC/);
    expect(t).not.toMatch(/FTC|crates/);
  });

  test('the FTC and crates.io only (the operator names itself to the SEC): the SEC is not named', () => {
    const t = note('account-site');
    expect(t).toMatch(/FTC/);
    expect(t).toMatch(/crates\.io/);
    expect(t).not.toMatch(/SEC/);
  });

  test('no note for the operator\'s contact or none, and no banned words in any note', () => {
    expect(note('operator')).toBeNull();
    expect(note('none')).toBeNull();
    expect(note('')).toBeNull();
    expect(note('toString')).toBeNull();
    for (const c of ['account', 'account-sec', 'account-site']) expect(note(c)).not.toMatch(/\b(API|key|token|free|paid|tier|quota)\b/i);
  });
});
