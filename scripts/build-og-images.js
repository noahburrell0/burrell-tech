var fs = require('fs');
var path = require('path');
var sharp = require('sharp');

var POSTS_DIR = path.join(__dirname, '..', 'blog', 'posts');
var IMAGES_DIR = path.join(__dirname, '..', 'blog', 'posts', 'images');
var OUT_DIR = path.join(__dirname, '..', 'dist', 'blog', 'og');

var WIDTH = 1200;
var HEIGHT = 630;
// Image can fill up to this fraction of the canvas (leaves padding around edges)
var MAX_WIDTH = Math.round(WIDTH * 0.6);   // 720
var MAX_HEIGHT = Math.round(HEIGHT * 0.7); // 441

var GRADIENTS = {
  dark: [
    { offset: '0%', color: '#1a1a2e' },
    { offset: '50%', color: '#16213e' },
    { offset: '100%', color: '#0f3460' }
  ],
  light: [
    { offset: '0%', color: '#e2e8f0' },
    { offset: '50%', color: '#cbd5e1' },
    { offset: '100%', color: '#94a3b8' }
  ]
};

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

async function buildOgImage(postFile) {
  var content = fs.readFileSync(path.join(POSTS_DIR, postFile), 'utf8');
  var data = parseFrontmatter(content);

  if (!data.image) return null;

  var slug = postFile.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
  var outPath = path.join(OUT_DIR, slug + '.png');

  // Resolve the hero image path
  var imageName = path.basename(data.image);
  var imagePath = path.join(IMAGES_DIR, imageName);

  if (!fs.existsSync(imagePath)) {
    console.log('  SKIP ' + slug + ' (image not found: ' + imageName + ')');
    return null;
  }

  // Select gradient based on ogBackground frontmatter (default: dark)
  var variant = data.ogBackground === 'light' ? 'light' : 'dark';
  var stops = GRADIENTS[variant];

  var gradientSvg = Buffer.from(
    '<svg width="' + WIDTH + '" height="' + HEIGHT + '">' +
    '<defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">' +
    stops.map(function (s) {
      return '<stop offset="' + s.offset + '" style="stop-color:' + s.color + '"/>';
    }).join('') +
    '</linearGradient></defs>' +
    '<rect width="' + WIDTH + '" height="' + HEIGHT + '" fill="url(#g)"/>' +
    '</svg>'
  );

  // Resize the hero image to fill available space while keeping padding
  var heroBuffer = await sharp(imagePath)
    .resize(MAX_WIDTH, MAX_HEIGHT, { fit: 'inside', withoutEnlargement: true })
    .toBuffer();

  var heroMeta = await sharp(heroBuffer).metadata();

  // Center the hero image
  var left = Math.round((WIDTH - heroMeta.width) / 2);
  var top = Math.round((HEIGHT - heroMeta.height) / 2);

  await sharp(gradientSvg)
    .composite([{ input: heroBuffer, left: left, top: top }])
    .png()
    .toFile(outPath);

  console.log('  ' + slug + '.png');
  return slug;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  var posts = fs.readdirSync(POSTS_DIR).filter(function (f) {
    return f.endsWith('.md');
  });

  console.log('Generating OG images...');
  for (var i = 0; i < posts.length; i++) {
    await buildOgImage(posts[i]);
  }
  console.log('OG image generation complete');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
