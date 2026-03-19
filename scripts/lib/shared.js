var path = require('path');

var SITE_URL = 'https://burrell.tech';
var POSTS_DIR = path.join(__dirname, '..', '..', 'blog', 'posts');

function parseFrontmatter(content) {
  var match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  var data = {};
  match[1].split('\n').forEach(function (line) {
    var idx = line.indexOf(':');
    if (idx > 0) {
      var key = line.slice(0, idx).trim();
      var val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      data[key] = val;
    }
  });
  return data;
}

module.exports = { SITE_URL: SITE_URL, POSTS_DIR: POSTS_DIR, parseFrontmatter: parseFrontmatter };
