var fs = require('fs');
var path = require('path');
var shared = require('./lib/shared');

var POSTS_DIR = shared.POSTS_DIR;
var STATIC_SITEMAP = path.join(__dirname, '..', 'static', 'sitemap.xml');
var OUT_SITEMAP = path.join(__dirname, '..', 'dist', 'sitemap.xml');
var SITE_URL = shared.SITE_URL;

function main() {
  // Read the base sitemap
  var sitemap = fs.readFileSync(STATIC_SITEMAP, 'utf8');

  // Collect blog post entries
  var posts = fs.readdirSync(POSTS_DIR)
    .filter(function (f) { return f.endsWith('.md'); })
    .map(function (f) {
      var content = fs.readFileSync(path.join(POSTS_DIR, f), 'utf8');
      var data = shared.parseFrontmatter(content);
      var slug = f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
      return { slug: slug, date: data.date || '' };
    })
    .sort(function (a, b) { return b.date.localeCompare(a.date); });

  // Build XML entries for each post
  var entries = posts.map(function (post) {
    return '  <url>\n' +
      '    <loc>' + SITE_URL + '/blog/' + post.slug + '/</loc>\n' +
      '    <lastmod>' + post.date + '</lastmod>\n' +
      '    <changefreq>monthly</changefreq>\n' +
      '    <priority>0.6</priority>\n' +
      '  </url>';
  }).join('\n');

  // Insert before closing </urlset>
  sitemap = sitemap.replace('</urlset>', entries + '\n</urlset>');

  fs.writeFileSync(OUT_SITEMAP, sitemap, 'utf8');

  console.log('Sitemap updated with ' + posts.length + ' blog post(s)');
}

main();
