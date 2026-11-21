'use strict';

module.exports = {
  host: process.env.HOST || '0.0.0.0',
  port: parseInt(process.env.PORT || '8080', 10),

  storeDir: process.env.STORE_DIR || '/nix/store',

  priority: parseInt(process.env.CACHE_PRIORITY || '30', 10),

  // Storage backend: 'local', 's3', 'r2', or 'github-releases'
  storageBackend: process.env.STORAGE_BACKEND || 'local',

  // Local storage path
  localStoragePath: process.env.LOCAL_STORAGE_PATH || './cache',

  // S3-compatible storage config
  s3: {
    bucket: process.env.S3_BUCKET || '',
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT || undefined,
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    // Set to true to force path-style URLs (needed for some S3-compatible stores)
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    // 'legacy' keeps narinfo under narinfo/; 'nix' is the layout Nix's s3:// store reads
    layout: process.env.S3_LAYOUT || 'legacy',
  },

  // Cloudflare R2 config (used by 'r2' storage backend; always the 'nix' layout)
  r2: {
    accountId: process.env.R2_ACCOUNT_ID || '',
    bucket: process.env.R2_BUCKET || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    // Override for jurisdictional endpoints, e.g. https://<account>.eu.r2.cloudflarestorage.com
    endpoint: process.env.R2_ENDPOINT || undefined,
  },

  // GitHub Releases config (used by 'github-releases' storage backend)
  github: {
    token: process.env.GITHUB_TOKEN || '',
    owner: process.env.GITHUB_OWNER || '',
    repo: process.env.GITHUB_REPO || '',
    releaseTag: process.env.GITHUB_RELEASE_TAG || 'nix-cache',
    pruneRetentionDays: parseInt(process.env.GITHUB_PRUNE_RETENTION_DAYS || '0', 10),
  },

  // Trusted caches whose paths should not be mirrored into this cache.
  upstreamCaches: (process.env.UPSTREAM_CACHES || '').split(/\s+/).filter(Boolean),

  // Signing key: '<keyname>:<base64-encoded-ed25519-private-key>'
  // Generate with: nix-store --generate-binary-cache-key <keyname> private.pem public.pem
  signingKey: process.env.SIGNING_KEY || '',

  // Upload secret token for write operations (PUT/POST)
  uploadSecret: process.env.UPLOAD_SECRET || '',
};
