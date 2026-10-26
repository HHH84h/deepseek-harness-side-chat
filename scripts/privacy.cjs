#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const ROOT_FILES = new Set(['README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json', '.gitignore', 'release-manifest.json', 'update-source.json', '检查更新.command', '安装或更新.command', '检查安装.command', '回退上一版.command', '卸载.command', '迁移旧版.command', '恢复旧版.command']);
const ROOT_DIRS = new Set(['plugin', 'tools', 'vendor', 'scripts', 'test', 'docs', '.github']);
const FORBIDDEN = /(^|\/)(?:node_modules|sessions|storages|reports|\.dsh|\.side-[^/]*|\.git|\.env(?:\.[^/]*)?)(?:\/|$)|(?:\.bak-|\.jsonl(?:\.|$)|\.log$|\.DS_Store$)/i;
const patterns = [
  ['private-user-path', /\/(?:Users|home)\/[^\s/"'<>]+\//g],
  ['windows-user-path', /[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\\\s]+\\/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['provider-key', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9_]{25,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/g],
  ['cloud-access-id', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['jwt-value', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/g],
  ['credential-url', /[?&](?:token|api_key|access_token|auth)=[A-Za-z0-9_%.-]{20,}/gi],
  ['bearer-value', /\bBearer\s+[A-Za-z0-9_.~-]{24,}/g],
  ['credential-assignment', /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[=:]\s*["'][A-Za-z0-9_+\/-]{24,}["']/gi]
];
function scan(root, options = {}) {
  const findings = [], files = [];
  const user = os.userInfo().username;
  const privateName = user && !['root', 'runner', 'test', 'user'].includes(user) ? new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') : null;
  function walk(dir, rel = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      // Developer checkouts contain Git metadata. Archives remain strict unless
      // this option is explicitly requested for the source working directory.
      if (!rel && name === '.git' && options.sourceCheckout === true) continue;
      const next = path.posix.join(rel, name), file = path.join(dir, name), st = fs.lstatSync(file);
      if (!rel && !(options.native ? new Set(['package.json','lib','cordis.patch.yml','update-source.json','README.md','LICENSE']).has(name) : ROOT_FILES.has(name) || ROOT_DIRS.has(name))) findings.push({ file: next, category: 'not-in-allowlist' });
      if (FORBIDDEN.test(next)) findings.push({ file: next, category: 'excluded-path' });
      if (st.isSymbolicLink()) { findings.push({ file: next, category: 'symlink-not-allowed' }); continue; }
      if (st.isDirectory()) { walk(file, next); continue; }
      files.push({ file: next, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
      const text = fs.readFileSync(file, 'utf8');
      for (const [category, re] of patterns) { re.lastIndex = 0; if (re.test(text)) findings.push({ file: next, category }); }
      if (privateName?.test(text) && !next.startsWith('vendor/')) findings.push({ file: next, category: 'local-user-name' });
      // Public third-party attribution is intentionally preserved; project files use no personal email.
      if (!next.startsWith('vendor/')) {
        const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
        if (emails.some(e => !e.endsWith('@users.noreply.github.com') && !e.endsWith('@example.invalid'))) findings.push({ file: next, category: 'personal-email-review' });
      }
    }
  }
  walk(path.resolve(root));
  return { passed: findings.length === 0, fileCount: files.length, findings, files };
}
module.exports = { scan };
if (require.main === module) {
  const result = scan(process.argv[2] ?? '.', { sourceCheckout: process.argv.includes('--source-checkout') });
  console.log(JSON.stringify({ passed: result.passed, fileCount: result.fileCount, findings: result.findings }, null, 2));
  if (!result.passed) process.exitCode = 1;
}
