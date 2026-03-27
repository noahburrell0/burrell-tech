(function () {
  var article = document.querySelector('article');
  if (!article) return;

  var headings = article.querySelectorAll('h2[id], h3[id]');
  if (headings.length < 3) return;

  // Build the TOC element
  var nav = document.createElement('nav');
  nav.className = 'toc';
  var details = document.createElement('details');
  var summary = document.createElement('summary');
  summary.className = 'toc-toggle';
  summary.textContent = 'Table of Contents';
  details.appendChild(summary);

  var list = document.createElement('ol');
  list.className = 'toc-list';
  var currentH2Item = null;

  for (var i = 0; i < headings.length; i++) {
    var h = headings[i];
    var li = document.createElement('li');
    var a = document.createElement('a');
    a.href = '#' + h.id;
    a.textContent = h.textContent;

    if (h.tagName === 'H2') {
      li.appendChild(a);
      list.appendChild(li);
      currentH2Item = li;
    } else if (h.tagName === 'H3' && currentH2Item) {
      var subList = currentH2Item.querySelector('ol');
      if (!subList) {
        subList = document.createElement('ol');
        currentH2Item.appendChild(subList);
      }
      li.appendChild(a);
      subList.appendChild(li);
    }
  }

  details.appendChild(list);
  nav.appendChild(details);

  // Insert after the hero image, or at the top of the article
  var hero = article.querySelector('.blog-hero');
  if (hero) {
    hero.after(nav);
  } else {
    article.prepend(nav);
  }
})();
