/**
 * Shared helpers for signed-in API routes.
 */
import { requireUser } from './auth';
import { PersistenceUnavailableError } from './db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value) => UUID_RE.test(String(value || ''));

/**
 * Wrap a handler: enforces allowed methods and sign-in, and turns database
 * errors into clean JSON responses.
 */
export function withUser(methods, handler) {
  return async function wrapped(req, res) {
    if (!methods.includes(req.method)) {
      res.setHeader('Allow', methods.join(', '));
      return res.status(405).json({ error: 'Method not allowed' });
    }
    const userId = await requireUser(req, res);
    if (!userId) return undefined;
    try {
      return await handler(req, res, userId);
    } catch (error) {
      if (error instanceof PersistenceUnavailableError) {
        return res.status(503).json({ error: error.message });
      }
      console.error(`API error ${req.method} ${req.url}:`, error);
      return res.status(500).json({
        error: 'Something went wrong. Please try again.',
        // Underlying message only in local development, never in production
        ...(process.env.NODE_ENV === 'development' ? { detail: String(error.message || error) } : {})
      });
    }
  };
}

export const clampText = (value, max) => String(value ?? '').trim().slice(0, max);
