var fs = require('fs');
var path = require('path');
var sharp = require('sharp');

var IMAGES_DIR = path.join(__dirname, '..', 'blog', 'posts', 'images');
var STATIC_DIR = path.join(__dirname, '..', 'static');
var OUT_BLOG = path.join(__dirname, '..', 'dist', 'blog', 'images');
var OUT_ROOT = path.join(__dirname, '..', 'dist');

// Logo displayed at h-10 (40px) with auto width; 2x for retina
var LOGO_MAX_HEIGHT = 80;

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
        .webp({ quality: 100, lossless: true })
        .toFile(path.join(OUT_BLOG, outName));
      console.log('  ' + file + ' -> ' + outName);
    }
  }

  // Convert headshot (displayed at ~192px on about page; keep high quality)
  var headshotSrc = path.join(STATIC_DIR, 'headshot.png');
  if (fs.existsSync(headshotSrc)) {
    await sharp(headshotSrc)
      .resize(384, 384, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90 })
      .toFile(path.join(OUT_ROOT, 'headshot.webp'));
    console.log('  headshot.png -> headshot.webp');
  }

  // Convert auth background
  var authBgSrc = path.join(STATIC_DIR, 'auth-background.png');
  if (fs.existsSync(authBgSrc)) {
    await sharp(authBgSrc)
      .webp({ quality: 100, lossless: true })
      .toFile(path.join(OUT_ROOT, 'auth-background.webp'));
    console.log('  auth-background.png -> auth-background.webp');
  }

  // Convert static logo and generate favicon
  var logoSrc = path.join(STATIC_DIR, 'logo.svg');
  if (fs.existsSync(logoSrc)) {
    await sharp(logoSrc, { density: 72 })
      .resize({ height: LOGO_MAX_HEIGHT, withoutEnlargement: true })
      .webp({ quality: 90 })
      .toFile(path.join(OUT_ROOT, 'logo.webp'));
    console.log('  logo.svg -> logo.webp');

    // Generate favicon.ico (32x32 + 64x64) from dedicated favicon SVG
    var faviconSrc = path.join(STATIC_DIR, 'favicon.svg');
    var faviconSizes = [32, 64];
    var pngBuffers = [];

    for (var s = 0; s < faviconSizes.length; s++) {
      var size = faviconSizes[s];
      var pngBuf = await sharp(faviconSrc, { density: 72 })
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
      pngBuffers.push({ size: size, data: pngBuf });
    }

    // ICO format: header + directory entries + PNG data
    var imageCount = pngBuffers.length;
    var headerSize = 6;
    var entrySize = 16;
    var dataOffset = headerSize + entrySize * imageCount;

    var header = Buffer.alloc(headerSize);
    header.writeUInt16LE(0, 0);      // reserved
    header.writeUInt16LE(1, 2);      // ICO type
    header.writeUInt16LE(imageCount, 4);

    var entries = [];
    var offset = dataOffset;
    for (var s = 0; s < pngBuffers.length; s++) {
      var entry = Buffer.alloc(entrySize);
      var dim = pngBuffers[s].size === 256 ? 0 : pngBuffers[s].size;
      entry.writeUInt8(dim, 0);          // width
      entry.writeUInt8(dim, 1);          // height
      entry.writeUInt8(0, 2);            // color palette
      entry.writeUInt8(0, 3);            // reserved
      entry.writeUInt16LE(1, 4);         // color planes
      entry.writeUInt16LE(32, 6);        // bits per pixel
      entry.writeUInt32LE(pngBuffers[s].data.length, 8);
      entry.writeUInt32LE(offset, 12);
      entries.push(entry);
      offset += pngBuffers[s].data.length;
    }

    var ico = Buffer.concat([header].concat(entries).concat(pngBuffers.map(function (p) { return p.data; })));
    fs.writeFileSync(path.join(OUT_ROOT, 'favicon.ico'), ico);
    console.log('  logo.svg -> favicon.ico (32x32 + 64x64)');
  }

  console.log('Image conversion complete');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
