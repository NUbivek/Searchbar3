'use client';

class NetworkMonitor {
  constructor() {
    this.requestCounts = new Map();
    this.rateLimit = 5;
    this.rateLimitWindow = 10000; // 10 seconds
  }

  isRateLimited(ip) {
    const now = Date.now();
    const windowStart = now - this.rateLimitWindow;
    
    // Clean up old entries
    for (const [key, { timestamp }] of this.requestCounts.entries()) {
      if (timestamp < windowStart) {
        this.requestCounts.delete(key);
      }
    }

    // Get or create request count for IP
    const entry = this.requestCounts.get(ip) || { count: 0, timestamp: now };
    
    if (entry.count >= this.rateLimit) {
      return true;
    }

    // Update count
    entry.count += 1;
    entry.timestamp = now;
    this.requestCounts.set(ip, entry);
    
    return false;
  }

  logRequest(req, res, startTime) {
    const endTime = Date.now();
    const duration = endTime - startTime;
    const statusCode = res.statusCode;
    const method = req.method;
    const url = req.url;
    const ip = req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const logEntry = {
      timestamp: new Date().toISOString(),
      method,
      url,
      statusCode,
      duration,
      ip,
      userAgent,
      headers: this.sanitizeHeaders(req.headers)
    };

    // Log to console in development
    if (process.env.NODE_ENV === 'development') {
      // Removed console.log statement
    }

    return logEntry;
  }

  sanitizeHeaders(headers = {}) {
    // Remove sensitive information from headers
    const sanitized = { ...headers };
    const sensitiveKeys = ['authorization', 'cookie', 'x-api-key'];
    
    sensitiveKeys.forEach(key => {
      if (sanitized[key]) {
        sanitized[key] = '[REDACTED]';
      }
    });

    return sanitized;
  }

  async handleRequest(req, res) {
    const startTime = Date.now();
    const ip = req.socket.remoteAddress;

    // Check rate limit
    if (this.isRateLimited(ip)) {
      res.status(429).json({ error: 'Too Many Requests' });
      return;
    }

    try {
      // Log the request after it's complete
      res.on('finish', () => {
        this.logRequest(req, res, startTime);
      });

      // Continue with request processing
      return true;
    } catch (error) {
      console.error('Error handling request:', error);
      res.status(200).json({
        status: 'fail-soft',
        error: 'Internal Server Error',
        degradedSources: ['network-monitor']
      });
      return false;
    }
  }
}

// Export singleton instance
const networkMonitor = new NetworkMonitor();
export default networkMonitor;
