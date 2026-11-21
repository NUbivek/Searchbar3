import { getEnvDiagnostics } from '../../../utils/envValidation';
import { debugAccess, parseAllowList, allowListActive } from '../../../server/auth';

/**
 * GET /api/debug/env-check -> which groups of settings are set up (never values).
 *
 * Who may call it is decided by debugAccess (src/server/auth.js): open in
 * development; on a preview deployment open behind the host's own sign-in but
 * limited per hour; in production any signed-in account (the allow-list applies
 * when set), and 401 with a sign-in prompt for a signed-out caller.
 *
 * In development the answer lists the names of the settings present and missing,
 * which helps set up a machine, and how many entries of the sign-in allow-list
 * were read or ignored (counts only). On a deployment it says only whether each group
 * is set up: the names would tell a stranger which outside services the site uses.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!(await debugAccess(req, res, { route: 'env-check' }))) return undefined;
  res.setHeader('Cache-Control', 'no-store');

  const diagnostics = getEnvDiagnostics(process.env);
  if (process.env.NODE_ENV !== 'production') {
    // Whether the sign-in allow-list is in force and how much of it could be read: counts only, never an address
    const list = parseAllowList();
    const ignored = list.warnings.filter((w) => !/^nothing in the list/.test(w)).length;
    const allowList = { active: allowListActive(list), emails: list.emails.length, domains: list.domains.length, ignored };
    return res.status(200).json({ timestamp: new Date().toISOString(), diagnostics, allowList });
  }
  const providers = Object.fromEntries(Object.entries(diagnostics.providers || {}).map(([group, p]) => [group, { configured: Boolean(p?.configured) }]));
  return res.status(200).json({
    timestamp: new Date().toISOString(),
    diagnostics: { ok: Boolean(diagnostics.ok), providers },
  });
}
