'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/**
 * Generate a static Nix binary cache site from locally stored narinfo files.
 *
 * The generated directory can be deployed to any static hosting provider
 * (Cloudflare Pages, GitHub Pages, Netlify, etc.) and will serve as a
 * Nix binary cache substituter.
 *
 * NAR binary files are expected to be hosted on GitHub Releases. The
 * generated narinfo uses absolute download URLs, including release shard tags.
 * A `_redirects` file is retained for legacy Cloudflare clients.
 *
 * @param {object} options
 * @param {string} options.narinfoDirPath   - path to the directory containing narinfo files
 * @param {string} options.outputDir        - directory to write generated static files
 * @param {string} options.storeDir         - Nix store directory (default: /nix/store)
 * @param {number} options.priority         - cache priority (default: 30)
 * @param {string} options.githubOwner      - GitHub repo owner
 * @param {string} options.githubRepo       - GitHub repo name
 * @param {string} options.githubReleaseTag - GitHub release tag name
 */
async function generateStaticSite(options) {
  const {
    narinfoDirPath,
    outputDir,
    storeDir = '/nix/store',
    priority = 30,
    githubOwner,
    githubRepo,
    githubReleaseTag,
  } = options;

  // Create output directory
  await fsp.mkdir(outputDir, { recursive: true });

  // 1. Generate nix-cache-info
  const cacheInfo =
    `StoreDir: ${storeDir}\n` +
    `WantMassQuery: 1\n` +
    `Priority: ${priority}\n`;
  await fsp.writeFile(path.join(outputDir, 'nix-cache-info'), cacheInfo, 'utf8');

  const narBaseUrl = `https://github.com/${githubOwner}/${githubRepo}/releases/download/${encodeURIComponent(githubReleaseTag)}`;

  // Absolute URLs work on GitHub Pages as well as redirect-aware hosts.
  // Sharded metadata already carries its own URL; retain it unchanged.
  // 2. Copy narinfo files to output directory
  const narinfoDir = narinfoDirPath;
  let entries;
  try {
    entries = await fsp.readdir(narinfoDir);
  } catch {
    entries = [];
  }

  const narinfoFiles = entries.filter(f => f.endsWith('.narinfo'));
  for (const filename of narinfoFiles) {
    const content = await fsp.readFile(path.join(narinfoDir, filename), 'utf8');
    const published = content.replace(/^URL: nar\/(.+)$/m, (_, name) =>
      `URL: ${narBaseUrl}/${encodeURIComponent(name.trim())}`);
    await fsp.writeFile(path.join(outputDir, filename), published, 'utf8');
  }

  // 3. Generate _redirects file for Cloudflare Pages
  // This redirects NAR download requests to GitHub Releases
  const redirects = `/nar/:filename ${narBaseUrl}/:filename 302\n`;
  await fsp.writeFile(path.join(outputDir, '_redirects'), redirects, 'utf8');

  await fsp.writeFile(path.join(outputDir, '.nojekyll'), '');

  return {
    narinfoCount: narinfoFiles.length,
    outputDir,
    narBaseUrl,
  };
}

module.exports = { generateStaticSite };
