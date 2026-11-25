'use strict';

// Secrets in store paths about to be published. A cache serves whatever it is given to
// anyone who can read it, and once fetched a path cannot be taken back, so a credential a
// build baked into its output (a token in a config file, a key copied in from the build
// machine) must be stopped before it is uploaded.
//
// The rules only match what is almost certainly a live secret: a token in a format a service
// issues, or a private key with its body, not a parser's header string. Each finding names
// the rule and where it is, never the text matched, since the log may be public too.

/** @type {{name: string, re: RegExp, ignore?: RegExp}[]} */
const RULES = [
  { name: '1password-service-account-token', re: /ops_eyJ[A-Za-z0-9_-]{40,}/g },
  { name: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, ignore: /EXAMPLE/ },
  {
    name: 'aws-secret-access-key',
    re: /aws_secret_access_key\s*[=:]\s*["']?[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/gi,
    ignore: /EXAMPLE/,
  },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g },
  { name: 'github-fine-grained-token', re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
  { name: 'slack-token', re: /\bxox[abprs]-[0-9]{6,}-[0-9A-Za-z-]{10,}/g },
  {
    // A header alone is what parsers carry; a key has a body of base64 after it.
    name: 'private-key',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----\r?\n(?:[A-Za-z0-9-]+: [^\n]*\r?\n)*\r?\n?[A-Za-z0-9+/=]{64}/g,
  },
  {
    // A Nix signing key is name:base64 of 64 bytes; a public key is 32 bytes, so shorter.
    name: 'nix-signing-key',
    re: /(?<![A-Za-z0-9+/=._-])[A-Za-z0-9._-]+:[A-Za-z0-9+/]{86}==(?![A-Za-z0-9+/=])/g,
    ignore: /^(?:sha|blake|md)\d*:/i,
  },
];

/** Rules from user-given patterns, one regular expression each. */
function customRules(patterns) {
  return patterns.map((source, i) => {
    try {
      return { name: `custom-${i + 1}`, re: new RegExp(source, 'g') };
    } catch (err) {
      throw new Error(`secret pattern ${i + 1} is not a valid regular expression: ${err.message}`);
    }
  });
}

/**
 * Where a buffer holds a secret: each rule that matched, with the offset of its first match.
 * Read as latin1, so that a secret inside a binary is found as well as one in text.
 * @returns {{rule: string, offset: number}[]}
 */
function scanBuffer(buf, rules = RULES) {
  const text = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf);
  const found = [];
  for (const { name, re, ignore } of rules) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (ignore && ignore.test(m[0])) continue;
      found.push({ rule: name, offset: m.index });
      break;
    }
  }
  return found;
}

/** A glob as a regular expression: `**` is anything, `*` and `?` stay within a name. */
function globRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      out += '.*';
      i++;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * Whether a file is allowed to match. Entries are globs over `<name>/<file>`, where <name> is
 * the store path's name without its hash, such as `openssl-3.0.15/share/**`; an entry with no
 * `/` allows a whole store path.
 */
function allowMatcher(globs) {
  const res = globs.map(g => globRegExp(g.includes('/') ? g : `${g}/**`));
  return (name, rel) => res.some(re => re.test(`${name}/${rel}`));
}

module.exports = { RULES, customRules, scanBuffer, globRegExp, allowMatcher };
