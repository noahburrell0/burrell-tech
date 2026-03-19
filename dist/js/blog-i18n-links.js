// Rewrite internal links in blog posts to respect stored language preference
(function () {
  var lang = localStorage.getItem('lang');
  if (lang !== 'es') return;
  var links = document.querySelectorAll('article a[href]');
  for (var i = 0; i < links.length; i++) {
    var href = links[i].getAttribute('href');
    if (href && href.charAt(0) === '/' && !href.match(/^\/blog(\/|$)/) && !href.match(/^\/(css|js|fonts)\//)) {
      links[i].setAttribute('href', '/es' + href);
    }
  }
})();
