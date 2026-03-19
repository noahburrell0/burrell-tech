#!/bin/sh
# Shared rebuild steps used by both `make build` and `scripts/watch.js`.
# Copies assets, rebuilds i18n pages, generates OG images, and updates the sitemap.
cp css/custom.css dist/css/
cp js/*.js dist/js/
cp static/* dist/
node scripts/build-i18n.js
node scripts/build-og-images.js
node scripts/build-sitemap.js
