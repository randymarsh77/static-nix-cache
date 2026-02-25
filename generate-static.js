#!/usr/bin/env node
'use strict';

const path = require('path');
const { generateStaticSite } = require('./src/generate-static');
const config = require('./src/config');

async function main() {
  const outputDir = process.env.OUTPUT_DIR || './static-cache';
  const localStoragePath = config.localStoragePath;
  const narinfoDirPath = path.join(localStoragePath, 'narinfo');

  const { owner, repo, releaseTag, token } = config.github;

  if (!owner || !repo) {
    console.error('Error: GITHUB_OWNER and GITHUB_REPO must be set.');
    console.error('');
    console.error('Usage:');
    console.error('  GITHUB_OWNER=<owner> GITHUB_REPO=<repo> node generate-static.js');
    console.error('');
    console.error('Environment variables:');
    console.error('  GITHUB_OWNER         GitHub repository owner (required)');
    console.error('  GITHUB_REPO          GitHub repository name (required)');
    console.error('  GITHUB_RELEASE_TAG   Release tag for NAR files (default: nix-cache)');
    console.error('  LOCAL_STORAGE_PATH   Path to static-nix-cache local storage (default: ./cache)');
    console.error('  OUTPUT_DIR           Output directory for static site (default: ./static-cache)');
    console.error('  STORE_DIR            Nix store directory (default: /nix/store)');
    console.error('  CACHE_PRIORITY       Cache priority (default: 30)');
    process.exit(1);
  }

  // When using the github-releases backend, fetch all narinfo from the release
  // so the generated site includes paths from all previous deploys (including
  // other matrix jobs).
  if (config.storageBackend === 'github-releases' && token) {
    const GitHubReleasesStorage = require('./src/storage/github-releases');
    const storage = new GitHubReleasesStorage({
      token,
      owner,
      repo,
      releaseTag,
      localPath: localStoragePath,
    });
    await storage.fetchAllNarinfo();
  }

  console.log('Generating static Nix binary cache site...');
  console.log(`  Source narinfo dir: ${narinfoDirPath}`);
  console.log(`  Output dir:        ${outputDir}`);
  console.log(`  GitHub:            ${owner}/${repo} @ ${releaseTag}`);

  const result = await generateStaticSite({
    narinfoDirPath,
    outputDir,
    storeDir: config.storeDir,
    priority: config.priority,
    githubOwner: owner,
    githubRepo: repo,
    githubReleaseTag: releaseTag,
  });

  console.log('');
  console.log(`Generated ${result.narinfoCount} narinfo file(s)`);
  console.log(`NAR redirects point to: ${result.narBaseUrl}`);
  console.log(`Static site ready at: ${result.outputDir}`);
  console.log('');
  console.log('Deploy this directory to your static hosting provider.');
  console.log('For Cloudflare Pages: npx wrangler pages deploy ' + result.outputDir);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
