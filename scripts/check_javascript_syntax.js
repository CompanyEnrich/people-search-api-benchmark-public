#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const IGNORED_DIRECTORIES = new Set([
  '.git',
  'cache',
  'comparison',
  'node_modules',
  'results',
  'runs',
]);

function listJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJavaScriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(entryPath);
    }
  }
  return files;
}

const files = listJavaScriptFiles(PROJECT_ROOT).sort();
let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || result.error?.message || `Syntax check failed: ${file}\n`);
  }
}

if (failed) process.exit(1);
console.log(`Syntax checked ${files.length} JavaScript files.`);
