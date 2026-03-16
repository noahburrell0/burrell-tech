#!/usr/bin/env node
/**
 * Build script for multi-language static site generation.
 *
 * Reads HTML templates from templates/ and translation JSON from i18n/,
 * then generates language-specific HTML files into dist/:
 *   - English (default): output to dist/
 *   - Spanish: output to dist/es/
 *
 * Usage:  node scripts/build-i18n.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const TEMPLATES = path.join(ROOT, 'templates');
const I18N = path.join(ROOT, 'i18n');
const SITE = 'https://burrell.tech';

const LANGS = [
  { code: 'en', dir: DIST },
  { code: 'es', dir: path.join(DIST, 'es') }
];

const PAGES = [
  { file: 'index.html', slug: '/' },
  { file: 'services.html', slug: '/services' },
  { file: 'about.html', slug: '/about' },
  { file: 'contact.html', slug: '/contact' },
  { file: 'privacy.html', slug: '/privacy' }
];

function hreflang(slug) {
  return LANGS.map(function (l) {
    var prefix = l.code === 'en' ? '' : '/' + l.code;
    return '  <link rel="alternate" hreflang="' + l.code + '" href="' + SITE + prefix + slug + '">';
  }).concat([
    '  <link rel="alternate" hreflang="x-default" href="' + SITE + slug + '">'
  ]).join('\n');
}

var missing = [];

for (var i = 0; i < LANGS.length; i++) {
  var lang = LANGS[i];
  var i18nPath = path.join(I18N, lang.code + '.json');
  if (!fs.existsSync(i18nPath)) {
    console.log('Skipping ' + lang.code + ': no translation file');
    continue;
  }

  var strings = JSON.parse(fs.readFileSync(i18nPath, 'utf8'));

  fs.mkdirSync(lang.dir, { recursive: true });

  for (var j = 0; j < PAGES.length; j++) {
    var page = PAGES[j];
    var tplPath = path.join(TEMPLATES, page.file);
    if (!fs.existsSync(tplPath)) continue;

    var html = fs.readFileSync(tplPath, 'utf8');

    // Built-in variables
    var prefix = lang.code === 'en' ? '' : '/' + lang.code;
    var vars = Object.assign({}, strings, {
      _lang: lang.code,
      _base: prefix,
      _canonical: SITE + prefix + page.slug,
      _hreflang: hreflang(page.slug)
    });

    html = html.replace(/\{\{([^}]+)\}\}/g, function (match, key) {
      var k = key.trim();
      if (vars[k] !== undefined) return vars[k];
      missing.push(lang.code + '/' + page.file + ': ' + k);
      return match;
    });

    fs.writeFileSync(path.join(lang.dir, page.file), html, 'utf8');
    console.log('  ' + lang.code + '/' + page.file);
  }
}

if (missing.length) {
  console.warn('\nMissing keys:');
  missing.forEach(function (m) { console.warn('  ' + m); });
  process.exit(1);
}

console.log('\ni18n build complete');
