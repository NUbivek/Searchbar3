import { getEnvDiagnostics } from '../../../utils/envValidation';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const diagnostics = getEnvDiagnostics(process.env);

  // Never expose secret values; only names and status
  return res.status(200).json({
    timestamp: new Date().toISOString(),
    diagnostics
  });
}
