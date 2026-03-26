var fs = require('fs');
var path = require('path');
var sharp = require('sharp');

var SIZE = 2500;
var CENTER_X = 850;
var CENTER_Y = Math.round(SIZE * 0.42);
var OUT = path.join(__dirname, '..', 'static', 'auth-background.png');

// Colors
var BG_TOP_LEFT = [3, 7, 18];       // #030712
var BG_BOT_RIGHT = [12, 26, 61];    // #0c1a3d
var BLUE_RGB = [37, 99, 235];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

async function main() {
  console.log('Generating auth background...');

  // Build raw pixel buffer with gradient + dithering + radial glows
  var pixels = Buffer.alloc(SIZE * SIZE * 3);

  for (var y = 0; y < SIZE; y++) {
    for (var x = 0; x < SIZE; x++) {
      var t = (x / SIZE + y / SIZE) / 2;

      var r = lerp(BG_TOP_LEFT[0], BG_BOT_RIGHT[0], t);
      var g = lerp(BG_TOP_LEFT[1], BG_BOT_RIGHT[1], t);
      var b = lerp(BG_TOP_LEFT[2], BG_BOT_RIGHT[2], t);

      // Blue radial glow (offset upper-right from logo)
      var dx1 = (x - (CENTER_X + 400)) / SIZE;
      var dy1 = (y - (CENTER_Y - 350)) / SIZE;
      var dist1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
      var glow1 = Math.max(0, 1 - dist1 / 0.5) * 0.15;
      r += BLUE_RGB[0] * glow1;
      g += BLUE_RGB[1] * glow1;
      b += BLUE_RGB[2] * glow1;

      // Indigo radial glow at bottom-left
      var dx2 = x / SIZE;
      var dy2 = (y - SIZE) / SIZE;
      var dist2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
      var glow2 = Math.max(0, 1 - dist2 / 0.7) * 0.08;
      r += 55 * glow2;
      g += 48 * glow2;
      b += 163 * glow2;

      // Dithering noise to prevent banding
      var noise = (Math.random() - 0.5) * 2.5;
      r = clamp(Math.round(r + noise), 0, 255);
      g = clamp(Math.round(g + noise), 0, 255);
      b = clamp(Math.round(b + noise), 0, 255);

      var idx = (y * SIZE + x) * 3;
      pixels[idx] = r;
      pixels[idx + 1] = g;
      pixels[idx + 2] = b;
    }
  }

  var bgBuffer = await sharp(pixels, { raw: { width: SIZE, height: SIZE, channels: 3 } })
    .png()
    .toBuffer();

  // Read logo SVG and convert to base64 PNG for embedding
  var logoSrc = path.join(__dirname, '..', 'static', 'logo.svg');
  var LOGO_W = 240;
  var logoPng = await sharp(logoSrc, { density: 72, limitInputPixels: false })
    .resize(LOGO_W, LOGO_W, { fit: 'inside', kernel: 'lanczos3' })
    .png()
    .toBuffer();
  var logoMeta = await sharp(logoPng).metadata();
  var LOGO_H = logoMeta.height;
  var logoBase64 = 'data:image/png;base64,' + logoPng.toString('base64');

  // Build SVG overlay with geometry, logo, and text
  var textTop = CENTER_Y + LOGO_H / 2 + 70;
  var svg = [
    '<svg width="' + SIZE + '" height="' + SIZE + '" xmlns="http://www.w3.org/2000/svg">',

    // Hexagonal rings (shifted up-left, scaled 1.5x)
    hexagon(CENTER_X - 350, CENTER_Y - 410, 300, 'rgba(37,99,235,0.08)', 3),
    hexagon(CENTER_X - 350, CENTER_Y - 410, 230, 'rgba(37,99,235,0.06)', 2.5),
    hexagon(CENTER_X + 150, CENTER_Y + 170, 210, 'rgba(37,99,235,0.06)', 2.5),
    hexagon(CENTER_X - 700, CENTER_Y - 530, 165, 'rgba(37,99,235,0.05)', 2.5),

    // Constellation dots with connecting lines
    constellationGroup(CENTER_X - 500, CENTER_Y - 450, [
      [0, 0], [135, -100], [300, -33], [405, -168], [570, -68]
    ], 'rgba(37,99,235,0.10)', 'rgba(37,99,235,0.05)'),

    constellationGroup(CENTER_X - 100, CENTER_Y + 70, [
      [0, 0], [168, 68], [270, -50], [435, 33], [540, 135]
    ], 'rgba(37,99,235,0.08)', 'rgba(37,99,235,0.04)'),

    constellationGroup(CENTER_X - 680, CENTER_Y - 30, [
      [0, 0], [112, 135], [270, 85], [372, 200], [507, 117], [675, 185]
    ], 'rgba(37,99,235,0.07)', 'rgba(37,99,235,0.03)'),

    constellationGroup(CENTER_X + 80, CENTER_Y - 470, [
      [0, 0], [150, -85], [338, -117], [472, -33], [627, -135]
    ], 'rgba(37,99,235,0.07)', 'rgba(37,99,235,0.03)'),

    constellationGroup(CENTER_X - 380, CENTER_Y + 320, [
      [0, 0], [200, -68], [372, 33], [540, -50]
    ], 'rgba(37,99,235,0.06)', 'rgba(37,99,235,0.03)'),

    // Angled lines
    '<line x1="' + (CENTER_X - 700) + '" y1="' + (CENTER_Y - 70) + '" x2="' + (CENTER_X - 400) + '" y2="' + (CENTER_Y - 210) + '" stroke="rgba(37,99,235,0.06)" stroke-width="2"/>',
    '<line x1="' + (CENTER_X - 60) + '" y1="' + (CENTER_Y - 60) + '" x2="' + (CENTER_X + 260) + '" y2="' + (CENTER_Y - 190) + '" stroke="rgba(37,99,235,0.05)" stroke-width="2"/>',
    '<line x1="' + (CENTER_X - 820) + '" y1="' + (CENTER_Y + 90) + '" x2="' + (CENTER_X - 500) + '" y2="' + (CENTER_Y + 250) + '" stroke="rgba(37,99,235,0.05)" stroke-width="2"/>',
    '<line x1="' + (CENTER_X + 60) + '" y1="' + (CENTER_Y - 550) + '" x2="' + (CENTER_X + 360) + '" y2="' + (CENTER_Y - 410) + '" stroke="rgba(37,99,235,0.04)" stroke-width="2"/>',
    '<line x1="' + (CENTER_X - 180) + '" y1="' + (CENTER_Y + 240) + '" x2="' + (CENTER_X + 140) + '" y2="' + (CENTER_Y + 330) + '" stroke="rgba(37,99,235,0.04)" stroke-width="2"/>',
    '<line x1="' + (CENTER_X - 880) + '" y1="' + (CENTER_Y - 390) + '" x2="' + (CENTER_X - 600) + '" y2="' + (CENTER_Y - 500) + '" stroke="rgba(37,99,235,0.03)" stroke-width="2"/>',

    // Circle arcs
    '<circle cx="' + (CENTER_X - 400) + '" cy="' + (CENTER_Y + 170) + '" r="360" fill="none" stroke="rgba(37,99,235,0.05)" stroke-width="2" stroke-dasharray="18,26"/>',
    '<circle cx="' + (CENTER_X + 20) + '" cy="' + (CENTER_Y - 320) + '" r="255" fill="none" stroke="rgba(37,99,235,0.04)" stroke-width="2" stroke-dasharray="15,22"/>',
    '<circle cx="' + (CENTER_X + 200) + '" cy="' + (CENTER_Y - 90) + '" r="400" fill="none" stroke="rgba(37,99,235,0.04)" stroke-width="2" stroke-dasharray="20,28"/>',
    '<circle cx="' + (CENTER_X - 650) + '" cy="' + (CENTER_Y - 420) + '" r="315" fill="none" stroke="rgba(37,99,235,0.03)" stroke-width="2" stroke-dasharray="15,22"/>',
    '<circle cx="' + (CENTER_X - 550) + '" cy="' + (CENTER_Y + 320) + '" r="225" fill="none" stroke="rgba(37,99,235,0.03)" stroke-width="2" stroke-dasharray="12,20"/>',
    '<circle cx="' + (CENTER_X + 280) + '" cy="' + (CENTER_Y - 570) + '" r="270" fill="none" stroke="rgba(37,99,235,0.03)" stroke-width="2" stroke-dasharray="15,24"/>',

    // Logo (no glow filter)
    '<image href="' + logoBase64 + '" x="' + (CENTER_X - LOGO_W / 2) + '" y="' + (CENTER_Y - LOGO_H / 2) + '" width="' + LOGO_W + '" height="' + LOGO_H + '"/>',

    // Company name
    '<text x="' + CENTER_X + '" y="' + textTop + '" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="48" font-weight="700" fill="white" opacity="0.95">Burrell Technology Services</text>',

    // Tagline
    '<text x="' + CENTER_X + '" y="' + (textTop + 56) + '" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="26" fill="white" opacity="0.55">Expert Kubernetes &amp; GitOps Consulting</text>',

    '</svg>'
  ].join('\n');

  var svgBuffer = Buffer.from(svg);

  // Composite SVG overlay onto gradient background
  await sharp(bgBuffer)
    .composite([{ input: svgBuffer, top: 0, left: 0 }])
    .png()
    .toFile(OUT);

  console.log('Auth background saved to ' + OUT);
}

function hexagon(cx, cy, r, stroke, strokeWidth) {
  var pts = [];
  for (var i = 0; i < 6; i++) {
    var angle = (Math.PI / 3) * i - Math.PI / 2;
    pts.push(Math.round(cx + r * Math.cos(angle)) + ',' + Math.round(cy + r * Math.sin(angle)));
  }
  return '<polygon points="' + pts.join(' ') + '" fill="none" stroke="' + stroke + '" stroke-width="' + strokeWidth + '"/>';
}

function constellationGroup(ox, oy, points, dotColor, lineColor) {
  var parts = [];
  for (var i = 0; i < points.length - 1; i++) {
    parts.push('<line x1="' + (ox + points[i][0]) + '" y1="' + (oy + points[i][1]) + '" x2="' + (ox + points[i + 1][0]) + '" y2="' + (oy + points[i + 1][1]) + '" stroke="' + lineColor + '" stroke-width="2"/>');
  }
  for (var i = 0; i < points.length; i++) {
    parts.push('<circle cx="' + (ox + points[i][0]) + '" cy="' + (oy + points[i][1]) + '" r="2.5" fill="' + dotColor + '"/>');
  }
  return parts.join('\n');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
