import { useState } from 'react';
import axios from 'axios';

export default function useSourcing101Integration() {
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const runSync = async ({ profile = 'github', mock = true } = {}) => {
    setIsRunning(true);
    setError('');

    try {
      const response = await axios.post('/api/integration/sourcing101', {
        profile,
        runId: `ui-${Date.now()}`,
        mock
      });
      setResult(response.data || null);
      return response.data;
    } catch (e) {
      const message = e?.response?.data?.error || e.message || 'Failed to run sourcing sync';
      setError(message);
      setResult(null);
      return null;
    } finally {
      setIsRunning(false);
    }
  };

  return { isRunning, result, error, runSync };
}
