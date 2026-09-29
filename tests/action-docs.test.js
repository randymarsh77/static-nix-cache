'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const documents = ['README.md', 'docs/getting-started.md', 'docs/github-actions.md'];
const references = documents.flatMap(document => {
  const content = fs.readFileSync(path.join(root, document), 'utf8');
  const matches = [...content.matchAll(/uses:\s+randymarsh77\/static-nix-cache\/([\w-]+)@([^\s]+)/g)];
  return matches.map(([, action, revision]) => ({ document, action, revision }));
});

describe('documented action versions', () => {
  test.each(documents)('%s uses the supported floating major tag', document => {
    const examples = references.filter(reference => reference.document === document);
    expect(examples.length).toBeGreaterThan(0);
    for (const { revision } of examples) {
      expect(revision).toBe('v1');
    }
  });

  test('setup, save and deploy examples use one major version', () => {
    expect(new Set(references.map(({ revision }) => revision)).size).toBe(1);
    expect(new Set(references.map(({ action }) => action))).toEqual(new Set(['setup', 'save', 'deploy']));
  });

  const targets = [...new Set(references.map(({ action, revision }) => `${revision}:${action}/action.yml`))];
  test.each(targets)('%s exists in the referenced tree, not just the checkout', target => {
    const manifest = execFileSync('git', ['show', target], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(manifest).toMatch(/using: composite/);
  });
});
