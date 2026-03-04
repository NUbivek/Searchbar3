export function withErrorHandler(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      console.error('API Error:', error);
      if (res.headersSent) {
        return;
      }

      res.status(200).json({
        status: 'fail-soft',
        error: 'Internal server error',
        message: error.message,
        degradedSources: ['middleware']
      });
    }
  };
}
