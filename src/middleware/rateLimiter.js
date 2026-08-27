// Rate Limiter Middleware for External API Protection
const requestMap = new Map();

/**
 * Throttles requests per IP address to prevent brute-force attacks and points scraping
 * @param {number} maxRequests - Max requests allowed per window
 * @param {number} windowMs - Window duration in milliseconds
 */
export const externalApiRateLimiter = (maxRequests = 30, windowMs = 60 * 1000) => {
  return (req, res, next) => {
    const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'global-client';
    const now = Date.now();

    if (!requestMap.has(clientIp)) {
      requestMap.set(clientIp, []);
    }

    const timestamps = requestMap.get(clientIp).filter(ts => now - ts < windowMs);
    timestamps.push(now);
    requestMap.set(clientIp, timestamps);

    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - timestamps.length));

    if (timestamps.length > maxRequests) {
      return res.status(429).json({
        success: false,
        error: 'Too Many Requests',
        message: `Rate limit exceeded. External verification API permits maximum ${maxRequests} requests per minute per client IP.`,
      });
    }

    next();
  };
};
