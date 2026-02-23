'use strict';

/**
 * Request logging middleware.
 *
 * Logs every HTTP request with method, URL, status code, and duration.
 * Useful for debugging cache operations in CI.
 *
 * @returns {Function} Express middleware
 */
function requestLogger() {
  return (req, res, next) => {
    const start = Date.now();
    const { method, url } = req;

    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`${method} ${url} ${res.statusCode} ${duration}ms`);
    });

    next();
  };
}

module.exports = { requestLogger };
