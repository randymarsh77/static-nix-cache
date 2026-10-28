'use strict';

const express = require('express');
const { requireUploadSecret } = require('../middleware/auth');
const { signNarinfo } = require('../signing');

/**
 * Build the Express router for the Nix binary cache HTTP API.
 *
 * Endpoints implemented:
 *   GET  /nix-cache-info              - cache metadata
 *   HEAD /:hash.narinfo               - check presence of a store path
 *   GET  /:hash.narinfo               - fetch narinfo for a store path
 *   PUT  /:hash.narinfo               - upload narinfo
 *   GET  /nar/:filename               - download NAR file
 *   PUT  /nar/:filename               - upload NAR file
 *
 * @param {object} storage - storage backend instance
 * @param {object} config  - application config
 * @returns {express.Router}
 */
function createCacheRouter(storage, config) {
  const router = express.Router();
  const authMiddleware = requireUploadSecret(config.uploadSecret);

  // Answer recursive nix-copy presence checks using trusted upstream caches.
  // Returning their metadata skips dependencies, not just the requested roots.
  const upstreamResults = new Map();
  async function lookupNarinfo(hash) {
    const local = await storage.getNarinfo(hash);
    if (local !== null) return local;
    if (upstreamResults.has(hash)) return upstreamResults.get(hash);
    for (const upstream of config.upstreamCaches || []) {
      const base = upstream.replace(/\/$/, '') + '/';
      const response = await fetch(`${base}${encodeURIComponent(hash)}.narinfo`, {
        signal: AbortSignal.timeout(30000),
      });
      if (response.status === 404) continue;
      if (!response.ok) throw new Error(`Upstream cache returned ${response.status}`);
      const content = (await response.text()).replace(/^URL: (.+)$/m,
        (_, url) => `URL: ${new URL(url.trim(), base).href}`);
      upstreamResults.set(hash, content);
      return content;
    }
    upstreamResults.set(hash, null);
    return null;
  }

  // ---------------------------------------------------------------------------
  // GET /nix-cache-info
  // ---------------------------------------------------------------------------
  router.get('/nix-cache-info', (req, res) => {
    res.type('text/plain');
    res.send(
      `StoreDir: ${config.storeDir}\n` +
      `WantMassQuery: 1\n` +
      `Priority: ${config.priority}\n`
    );
  });

  // ---------------------------------------------------------------------------
  // HEAD /:hash.narinfo  – used by Nix to check cache presence
  // ---------------------------------------------------------------------------
  router.head('/:hash.narinfo', async (req, res) => {
    try {
      const exists = (await lookupNarinfo(req.params.hash)) !== null;
      res.sendStatus(exists ? 200 : 404);
    } catch (err) {
      res.sendStatus(500);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /:hash.narinfo
  // ---------------------------------------------------------------------------
  router.get('/:hash.narinfo', async (req, res) => {
    try {
      const content = await lookupNarinfo(req.params.hash);
      if (content === null) {
        return res.sendStatus(404);
      }
      res.type('text/x-nix-narinfo');
      res.send(content);
    } catch (err) {
      res.sendStatus(500);
    }
  });

  // ---------------------------------------------------------------------------
  // PUT /:hash.narinfo  – upload narinfo (optionally re-sign with our key)
  // ---------------------------------------------------------------------------
  router.put('/:hash.narinfo', authMiddleware, express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
    try {
      let content = req.body;
      if (typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ error: 'Empty body' });
      }

      if (config.signingKey) {
        content = addSignature(content, config.signingKey);
      }

      await storage.putNarinfo(req.params.hash, content);
      res.sendStatus(200);
    } catch (err) {
      res.sendStatus(500);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /nar/:filename  – download a NAR file
  // ---------------------------------------------------------------------------
  router.get('/nar/:filename', async (req, res) => {
    try {
      const narStream = await storage.getNarStream(req.params.filename);
      if (narStream === null) {
        return res.sendStatus(404);
      }
      res.type('application/x-nix-nar');
      narStream.pipe(res);
      narStream.on('error', () => res.destroy());
    } catch (err) {
      res.sendStatus(500);
    }
  });

  // ---------------------------------------------------------------------------
  // PUT /nar/:filename  – upload a NAR file
  // ---------------------------------------------------------------------------
  router.put('/nar/:filename', authMiddleware, async (req, res) => {
    try {
      await storage.putNarStream(req.params.filename, req);
      res.sendStatus(200);
    } catch (err) {
      res.sendStatus(500);
    }
  });

  return router;
}

/**
 * Parse a narinfo text body into an object for signing.
 * @param {string} text
 * @returns {object}
 */
function parseNarinfo(text) {
  const obj = {};
  const references = [];
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === 'StorePath') obj.storePath = value;
    else if (key === 'NarHash') obj.narHash = value;
    else if (key === 'NarSize') obj.narSize = parseInt(value, 10);
    else if (key === 'References') {
      references.push(...value.split(/\s+/).filter(Boolean));
    }
  }
  // narinfo serializes reference basenames; Nix signs full store paths.
  const storeDir = obj.storePath?.slice(0, obj.storePath.lastIndexOf('/')) || '/nix/store';
  obj.references = references.map(ref => ref.startsWith('/') ? ref : `${storeDir}/${ref}`).sort();
  return obj;
}

/**
 * Add (or replace) our signature in a narinfo text.
 * @param {string} content      - raw narinfo text
 * @param {string} signingKey   - "<keyname>:<base64-private-key>"
 * @returns {string}
 */
function addSignature(content, signingKey) {
  const narinfo = parseNarinfo(content);
  const sig = signNarinfo(narinfo, signingKey);

  // Remove any existing Sig lines, then append ours
  const lines = content.split('\n').filter(l => !l.startsWith('Sig:'));
  // Ensure no trailing blank line before we add ours
  const trimmed = lines.join('\n').trimEnd();
  return `${trimmed}\nSig: ${sig}\n`;
}

module.exports = { createCacheRouter };
