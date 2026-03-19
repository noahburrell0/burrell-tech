var fs = require('fs');
var path = require('path');
var sharp = require('sharp');

var IMAGES_DIR = path.join(__dirname, '..', 'blog', 'posts', 'images');
var STATIC_DIR = path.join(__dirname, '..', 'static');
var OUT_BLOG = path.join(__dirname, '..', 'dist', 'blog', 'images');
var OUT_ROOT = path.join(__dirname, '..', 'dist');

// Max displayed size on blog cards is 100px (sm:max-h-[100px]); 2x for retina
var BLOG_IMAGE_MAX = 200;
// Logo displayed at 32x32 (h-8 w-8); 2x for retina
var LOGO_MAX = 64;

async function main() {
  fs.mkdirSync(OUT_BLOG, { recursive: true });

  console.log('Converting images to WebP...');

  // Convert blog post images
  var files = fs.readdirSync(IMAGES_DIR);
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var ext = path.extname(file).toLowerCase();
    var src = path.join(IMAGES_DIR, file);

    if (ext === '.svg') {
      // Copy SVGs as-is
      fs.copyFileSync(src, path.join(OUT_BLOG, file));
      console.log('  ' + file + ' (copied)');
    } else if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
      var outName = file.replace(/\.(png|jpe?g)$/i, '.webp');
      await sharp(src)
        .resize(BLOG_IMAGE_MAX, BLOG_IMAGE_MAX, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toFile(path.join(OUT_BLOG, outName));
      console.log('  ' + file + ' -> ' + outName);
    }
  }

  // Convert static logo
  var logoSrc = path.join(STATIC_DIR, 'logo.png');
  if (fs.existsSync(logoSrc)) {
    await sharp(logoSrc)
      .resize(LOGO_MAX, LOGO_MAX, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90 })
      .toFile(path.join(OUT_ROOT, 'logo.webp'));
    console.log('  logo.png -> logo.webp');
  }

  console.log('Image conversion complete');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
