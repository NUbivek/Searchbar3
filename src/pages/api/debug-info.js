export default function handler(req, res) {
  res.status(200).json({
    status: 'ok',
    env: process.env.NODE_ENV,
    timestamp: new Date().toISOString(),
    headers: req.headers,
    method: req.method
  });
} 