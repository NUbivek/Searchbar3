import { getEnvDiagnostics } from '../../../utils/envValidation';
import { getUserId } from '../../../server/auth';

/**
 * GET /api/debug/env-check -> which env variables are set (names and status
 * only, never values). Open in development; in production it requires a
 * signed-in session so the deployment's configuration is not public.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (process.env.NODE_ENV === 'production') {
    const userId = await getUserId(req, res);
    if (!userId) {
      return res.status(401).json({ error: 'Sign in to view environment diagnostics.' });
    }
  }

  const diagnostics = getEnvDiagnostics(process.env);

  // Never expose secret values; only names and status
  return res.status(200).json({
    timestamp: new Date().toISOString(),
    diagnostics
  });
}
