/**
 * Heading anchor links for blog posts.
 * Wraps each heading's content in a clickable anchor that copies the
 * full URL (with hash) to the clipboard. The link icon and text act
 * as a single hoverable/clickable unit.
 */
(function () {
  var article = document.querySelector('article.prose');
  if (!article) return;

  var headings = article.querySelectorAll('h2[id], h3[id], h4[id], h5[id], h6[id]');

  headings.forEach(function (heading) {
    var link = document.createElement('a');
    link.href = '#' + heading.id;
    link.className = 'heading-anchor';
    link.setAttribute('aria-label', 'Copy link to this section');

    // Move all existing children into the link
    while (heading.firstChild) {
      link.appendChild(heading.firstChild);
    }

    // Append the icon inside the link, after the text
    var svgNS = 'http://www.w3.org/2000/svg';
    var icon = document.createElementNS(svgNS, 'svg');
    icon.setAttribute('class', 'heading-anchor-icon');
    var use = document.createElementNS(svgNS, 'use');
    use.setAttribute('href', '#icon-link');
    icon.appendChild(use);
    link.appendChild(icon);

    // Place the link inside the heading
    heading.appendChild(link);

    link.addEventListener('click', function (e) {
      e.preventDefault();
      var url = window.location.origin + window.location.pathname + '#' + heading.id;
      navigator.clipboard.writeText(url).then(function () {
        var tooltip = document.createElement('span');
        tooltip.className = 'heading-anchor-tooltip';
        tooltip.textContent = 'Copied!';
        link.appendChild(tooltip);
        setTimeout(function () { tooltip.remove(); }, 1500);
      });
      history.replaceState(null, '', '#' + heading.id);
    });
  });
})();
