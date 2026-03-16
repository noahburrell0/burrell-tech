#!/usr/bin/env node
/**
 * Development watcher. Runs three things in parallel:
 *   1. Tailwind CSS in watch mode (handles css/input.css -> dist/css/tailwind.css)
 *   2. Eleventy in watch mode (handles blog/ -> dist/blog/)
 *   3. fs.watch on templates/, i18n/, js/, static/, css/custom.css
 *      -> copies assets + rebuilds i18n on change
 *
 * Usage: node scripts/watch.js
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// --- 1. Tailwind CSS watch ---
const tw = spawn('npx', [
  'tailwindcss', '-i', 'css/input.css', '-o', 'dist/css/tailwind.css', '--watch'
], { cwd: ROOT, stdio: 'inherit', shell: true });

// --- 2. Eleventy watch ---
const el = spawn('npx', [
  '@11ty/eleventy', '--watch', '--quiet'
], { cwd: ROOT, stdio: 'inherit', shell: true });

// --- 3. File watcher for everything else ---
let timer = null;

function rebuild(label) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(function () {
    console.log('\n[watch] ' + label + ' changed, rebuilding...');
    try {
      execSync(
        'cp css/custom.css dist/css/ && cp js/*.js dist/js/ && cp static/* dist/ && node scripts/build-i18n.js',
        { cwd: ROOT, stdio: 'inherit' }
      );
      console.log('[watch] Done.\n');
    } catch (e) {
      console.error('[watch] Rebuild failed.\n');
    }
  }, 300);
}

var watchTargets = [
  { dir: 'templates', label: 'templates' },
  { dir: 'i18n',      label: 'i18n' },
  { dir: 'js',        label: 'js' },
  { dir: 'static',    label: 'static' }
];

for (var i = 0; i < watchTargets.length; i++) {
  var target = watchTargets[i];
  var fullPath = path.join(ROOT, target.dir);
  if (fs.existsSync(fullPath)) {
    // fs.watch with recursive works on macOS and Windows
    (function (lbl) {
      fs.watch(fullPath, { recursive: true }, function (event, filename) {
        rebuild(lbl + '/' + (filename || ''));
      });
    })(target.label);
  }
}

// Watch css/custom.css specifically (tailwind handles input.css)
var customCssPath = path.join(ROOT, 'css', 'custom.css');
if (fs.existsSync(customCssPath)) {
  fs.watch(customCssPath, function () {
    rebuild('css/custom.css');
  });
}

console.log('[watch] Watching templates, i18n, js, static, css, and blog for changes...');
console.log('[watch] Press Ctrl+C to stop.\n');

// Clean up child processes on exit
function cleanup() {
  tw.kill();
  el.kill();
  process.exit();
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
