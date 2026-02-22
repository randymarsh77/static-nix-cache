'use strict';

/**
 * Middleware that requires a valid upload secret in the Authorization header.
 *
 * Clients must send:  Authorization: Bearer <secret>
 *
 * If no upload secret is configured, all write requests are allowed (useful
 * for private deployments behind a firewall).
 */
function requireUploadSecret(secret) {
  return (req, res, next) => {
    if (!secret) {
      return next();
    }
    const authHeader = req.headers['authorization'] || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match || match[1] !== secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

module.exports = { requireUploadSecret };
