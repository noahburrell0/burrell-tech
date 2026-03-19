#!/bin/sh
# Shared rebuild steps used by both `make build` and `scripts/watch.js`.
# Copies assets, rebuilds i18n pages, generates OG images, and updates the sitemap.
cp css/custom.css dist/css/
cp js/*.js dist/js/
find static -maxdepth 1 -type f ! -name '*.png' ! -name '*.jpg' ! -name '*.jpeg' -exec cp {} dist/ \;
node scripts/build-i18n.js
node scripts/build-images.js
node scripts/build-og-images.js
node scripts/build-sitemap.js
