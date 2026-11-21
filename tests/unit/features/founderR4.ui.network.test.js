/** @jest-environment jsdom */
/**
 * Round 4 (ui): the Network Map's "Checked" chip never reads as a clean result while serious records are
 * held "if this is the right person".
 */
jest.mock('next/link', () => function Link({ children, href, ...props }) { return <a href={href} {...props}>{children}</a>; });
jest.mock('next/head', () => function Head({ children }) { return <>{children}</>; });
jest.mock('next/router', () => ({ useRouter: jest.fn() }));
jest.mock('next-auth/react', () => ({ useSession: jest.fn() }));
jest.mock('../../../src/components/account/AccountMenu', () => function AccountMenu() { return null; });
jest.mock('../../../src/components/network/NetworkGraph', () => ({ __esModule: true, default: () => null, SOURCE_COLORS: {} }));

// eslint-disable-next-line import/first
import { checkChip } from '../../../src/pages/network';

test('serious records held "if this is the right person" make the chip amber and are said', () => {
  const chip = checkChip({ id: 'j', name: 'Trevor Milton', redFlags: 0, ifRightPerson: 3, date: '2026-11-20T10:00:00Z' });
  expect(chip.className).toBe('chip chip-warn');
  expect(chip.text).toBe('Checked · 3 serious if right person');
});

test('red flags stay red; a plain zero stays neutral, never green', () => {
  expect(checkChip({ redFlags: 2, ifRightPerson: 1 }).className).toBe('chip chip-bad');
  expect(checkChip({ redFlags: 2 }).text).toBe('Checked · 2 red flags');
  expect(checkChip({ redFlags: 0 }).className).toBe('chip');
  expect(checkChip({ redFlags: 0 }).text).toBe('Checked');
});
