export default function errorHandler(error, req, res, next) {
  console.error('API Error:', error);

  if (error.name === 'RateLimitError') {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      source: error.source,
      retryAfter: error.retryAfter
    });
  }

  if (error.name === 'APIError') {
    const status = error.status || 500;
    if (status >= 500) {
      return res.status(200).json({
        status: 'fail-soft',
        error: error.message,
        source: error.source,
        degradedSources: [error.source || 'api']
      });
    }

    return res.status(status).json({
      error: error.message,
      source: error.source
    });
  }

  // Default error response
  res.status(200).json({
    status: 'fail-soft',
    error: 'An unexpected error occurred',
    message: process.env.NODE_ENV === 'development' ? error.message : undefined,
    degradedSources: ['api']
  });
}
