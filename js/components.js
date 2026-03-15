/**
 * Shared site components: nav, footer, social links, and CTA section.
 * Injected into placeholder divs before Alpine.js initializes.
 *
 * Placeholders:
 *   <div id="nav-placeholder" data-active-page="home|services|about|contact"></div>
 *   <div id="footer-placeholder"></div>
 *   <div id="social-links-placeholder"></div>
 *   <div id="cta-placeholder"
 *        data-heading="..."
 *        data-body="..."
 *        data-variant="full|simple">
 *   </div>
 *   full   = Get in Touch + View Services & Pricing buttons
 *   simple = Get in Touch button only
 */
(function () {
  // --- SVG Sprite (injected once; referenced via <use href="#icon-check">) ---
  document.body.insertAdjacentHTML('afterbegin',
    '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:none">' +
      '<symbol id="icon-check" viewBox="0 0 20 20">' +
        '<path fill="currentColor" fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>' +
      '</symbol>' +
    '</svg>'
  );

  // --- Shared constants ---
  var LINKEDIN_URL = 'https://www.linkedin.com/in/noahburrell/';
  var GITHUB_URL   = 'https://github.com/noahburrell0';

  var SVG_LINKEDIN = '<svg class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>';
  var SVG_GITHUB   = '<svg class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>';

  // --- Navigation ---
  var navPlaceholder = document.getElementById('nav-placeholder');
  var activePage = navPlaceholder ? (navPlaceholder.getAttribute('data-active-page') || '') : '';

  function desktopLink(page, href, label) {
    return activePage === page
      ? '<a href="' + href + '" class="text-sm font-semibold text-blue-600 dark:text-blue-400">' + label + '</a>'
      : '<a href="' + href + '" class="text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">' + label + '</a>';
  }

  function mobileLink(page, href, label) {
    return activePage === page
      ? '<a href="' + href + '" class="block text-sm font-semibold text-blue-600 dark:text-blue-400">' + label + '</a>'
      : '<a href="' + href + '" class="block text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white">' + label + '</a>';
  }

  var navHTML = [
    '<header x-data="{ open: false }" class="sticky top-0 z-50 bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm border-b border-gray-200 dark:border-gray-800">',
      '<div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">',
        '<div class="flex items-center justify-between h-16">',
          '<a href="/" class="flex items-center gap-2.5 font-bold text-gray-900 dark:text-white text-lg tracking-tight">',
            '<img src="logo.png" alt="Burrell Technology Services home" class="h-8 w-8 rounded-lg">',
            'Burrell Technology Services',
          '</a>',
          '<nav class="hidden md:flex items-center gap-8">',
            desktopLink('home', '/', 'Home'),
            desktopLink('services', 'services', 'Services'),
            desktopLink('about', 'about', 'About'),
            '<a href="contact" class="text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition-colors">Get in Touch</a>',
          '</nav>',
          '<div class="flex items-center gap-2">',
            '<button onclick="toggleTheme()" class="p-2 rounded-md text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors" aria-label="Toggle theme">',
              '<svg class="block dark:hidden h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>',
              '<svg class="hidden dark:block h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>',
            '</button>',
            '<button @click="open = !open" class="md:hidden p-2 rounded-md text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors" aria-label="Toggle navigation">',
            '<svg x-show="!open" class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>',
            '<svg x-show="open" class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="display:none"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>',
          '</button>',
          '</div>',
        '</div>',
      '</div>',
      '<div x-show="open" x-transition class="md:hidden border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-4 space-y-3" style="display:none">',
        mobileLink('home', '/', 'Home'),
        mobileLink('services', 'services', 'Services'),
        mobileLink('about', 'about', 'About'),
        mobileLink('contact', 'contact', 'Contact'),
      '</div>',
    '</header>'
  ].join('');

  if (navPlaceholder) {
    navPlaceholder.outerHTML = navHTML;
  }

  // --- Footer ---
  var footerPlaceholder = document.getElementById('footer-placeholder');

  var footerHTML = [
    '<footer class="bg-gray-900 dark:bg-black/60 text-gray-400 py-8">',
      '<div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">',
        '<div class="grid sm:grid-cols-3 gap-8">',

          // Col 1: Brand + socials
          '<div>',
            '<p class="text-white font-semibold">Burrell Technology Services S.A.</p>',
            '<p class="mt-2 text-sm leading-relaxed">Expert Kubernetes &amp; GitOps consulting.</p>',
            '<div class="mt-4 flex items-center gap-4">',
              '<a href="' + LINKEDIN_URL + '" target="_blank" rel="noopener noreferrer" class="hover:text-white transition-colors" aria-label="LinkedIn">',
                SVG_LINKEDIN,
              '</a>',
              '<a href="' + GITHUB_URL + '" target="_blank" rel="noopener noreferrer" class="hover:text-white transition-colors" aria-label="GitHub">',
                SVG_GITHUB,
              '</a>',
            '</div>',
          '</div>',

          // Col 2: Contact info
          '<div>',
            '<p class="text-white font-semibold text-sm">Contact</p>',
            '<div class="mt-3 space-y-2 text-sm">',
              '<a href="mailto:noah@burrell.tech" class="flex items-center gap-2 hover:text-white transition-colors">',
                '<svg class="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>',
                'noah@burrell.tech',
              '</a>',
              '<a href="tel:+16135811896" class="flex items-center gap-2 hover:text-white transition-colors">',
                '<svg class="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.948V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg>',
                '+1 (613) 581-1896',
              '</a>',
              '<a href="tel:+50764310559" class="flex items-center gap-2 hover:text-white transition-colors">',
                '<svg class="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.948V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg>',
                '+507 6431-0559',
              '</a>',
            '</div>',
          '</div>',

          // Col 3: Nav links
          '<div>',
            '<p class="text-white font-semibold text-sm">Navigation</p>',
            '<div class="mt-3 space-y-2 text-sm">',
              '<a href="/" class="block hover:text-white transition-colors">Home</a>',
              '<a href="services" class="block hover:text-white transition-colors">Services &amp; Pricing</a>',
              '<a href="about" class="block hover:text-white transition-colors">About</a>',
              '<a href="contact" class="block hover:text-white transition-colors">Contact</a>',
            '</div>',
          '</div>',

        '</div>',
        '<div class="mt-8 pt-8 border-t border-gray-800 text-sm text-center">',
          '<p>&copy; <span id="copyright-year"></span> Burrell Technology Services S.A. All rights reserved.</p>',
        '</div>',
      '</div>',
    '</footer>'
  ].join('');

  if (footerPlaceholder) {
    footerPlaceholder.outerHTML = footerHTML;
  }

  // --- Social Links (contact page Connect section) ---
  var socialLinksPlaceholder = document.getElementById('social-links-placeholder');
  if (socialLinksPlaceholder) {
    var socialHTML = [
      '<div>',
        '<h2 class="text-lg font-semibold text-gray-900 dark:text-white mb-4">Connect</h2>',
        '<div class="flex items-center gap-4">',
          '<a href="' + LINKEDIN_URL + '" target="_blank" rel="noopener noreferrer" class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors font-medium">',
            SVG_LINKEDIN,
            'LinkedIn',
          '</a>',
          '<a href="' + GITHUB_URL + '" target="_blank" rel="noopener noreferrer" class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors font-medium">',
            SVG_GITHUB,
            'GitHub',
          '</a>',
        '</div>',
      '</div>'
    ].join('');
    socialLinksPlaceholder.outerHTML = socialHTML;
  }

  // --- Retainer Terms ---
  //   <div class="retainer-terms-placeholder"></div>
  var retainerTermsHTML =
    '<p class="mt-8 text-gray-400 dark:text-gray-500" style="font-size: 0.6rem;">' +
      '<span class="font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Retainer Terms:</span> ' +
      'Monthly retainers are a non-refundable minimum commitment. Unused hours do not roll over. ' +
      'Hours beyond the monthly minimum are billed at your retainer\u2019s hourly rate. ' +
      '<a href="contact" class="hover:underline">Get in touch</a> to discuss fit before committing.' +
    '</p>';

  document.querySelectorAll('.retainer-terms-placeholder').forEach(function (el) {
    el.outerHTML = retainerTermsHTML;
  });

  // --- CTA Section ---
  var ctaPlaceholder = document.getElementById('cta-placeholder');
  if (ctaPlaceholder) {
    var ctaHeading = ctaPlaceholder.getAttribute('data-heading') || '';
    var ctaBody    = ctaPlaceholder.getAttribute('data-body') || '';
    var ctaVariant = ctaPlaceholder.getAttribute('data-variant') || 'simple';

    var ctaBtnWrap = ctaVariant === 'full'
      ? 'mt-8 flex flex-wrap justify-center gap-4'
      : 'mt-8';
    var ctaButtons = '<a href="contact" class="inline-flex items-center gap-2 bg-white text-blue-600 font-semibold px-6 py-3 rounded-lg hover:bg-blue-50 transition-colors shadow-sm">Get in Touch</a>';
    if (ctaVariant === 'full') {
      ctaButtons += '<a href="services" class="inline-flex items-center gap-2 border border-blue-400 text-white font-semibold px-6 py-3 rounded-lg hover:bg-blue-500 transition-colors">View Services &amp; Pricing</a>';
    }

    var ctaHTML = [
      '<section class="bg-blue-600 dark:bg-blue-700 py-16 sm:py-20">',
        '<div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 text-center">',
          '<h2 class="text-3xl sm:text-4xl font-bold text-white">' + ctaHeading + '</h2>',
          '<p class="mt-4 text-lg text-blue-100 max-w-2xl mx-auto">' + ctaBody + '</p>',
          '<div class="' + ctaBtnWrap + '">',
            ctaButtons,
          '</div>',
        '</div>',
      '</section>'
    ].join('');
    ctaPlaceholder.outerHTML = ctaHTML;
  }
})();
