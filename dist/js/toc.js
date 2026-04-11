(function () {
  var article = document.querySelector('article');
  if (!article) return;

  var headings = article.querySelectorAll('h2[id], h3[id]');
  if (headings.length < 3) return;

  // Build the inline TOC (used at all widths, visible below 1900px)
  var nav = document.createElement('nav');
  nav.className = 'toc toc-inline';
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

  // --- Desktop sidebar TOC (1900px+) ---
  var slot = document.getElementById('toc-sidebar-slot');
  if (!slot) return;

  var sidebar = document.createElement('nav');
  sidebar.className = 'toc toc-sidebar';
  sidebar.setAttribute('aria-label', 'Table of Contents');

  var sidebarHeader = document.createElement('div');
  sidebarHeader.className = 'toc-sidebar-header';

  var sidebarTitle = document.createElement('span');
  sidebarTitle.className = 'toc-sidebar-title';
  sidebarTitle.textContent = 'On this page';
  sidebarHeader.appendChild(sidebarTitle);

  var expandAllBtn = document.createElement('button');
  expandAllBtn.className = 'toc-expand-all';
  expandAllBtn.type = 'button';
  expandAllBtn.textContent = '[Expand all]';
  sidebarHeader.appendChild(expandAllBtn);

  sidebar.appendChild(sidebarHeader);

  var sidebarList = list.cloneNode(true);

  // For H2 items that have sub-lists, replace the <a> with a toggle button
  var topItems = sidebarList.querySelectorAll('.toc-list > li');
  for (var t = 0; t < topItems.length; t++) {
    var sub = topItems[t].querySelector('ol');
    if (!sub) continue;

    sub.classList.add('toc-collapsed');

    var originalLink = topItems[t].querySelector(':scope > a');
    var btn = document.createElement('button');
    btn.className = 'toc-section-toggle';
    btn.type = 'button';
    btn.innerHTML =
      '<span class="toc-section-label">' + originalLink.textContent + '</span>' +
      '<span class="toc-chevron"></span>';
    originalLink.replaceWith(btn);

    // Click toggles the sub-list
    (function (olEl, btnEl) {
      btnEl.addEventListener('click', function () {
        var isCollapsed = olEl.classList.toggle('toc-collapsed');
        btnEl.classList.toggle('toc-expanded', !isCollapsed);
      });
    })(sub, btn);
  }

  sidebar.appendChild(sidebarList);
  slot.appendChild(sidebar);

  // Hide expand/collapse button when there are no sub-sections (no H3s)
  if (sidebarList.querySelectorAll('.toc-list > li > ol').length === 0) {
    expandAllBtn.style.display = 'none';
  }

  // --- Expand/Collapse all toggle ---
  var allExpanded = false;
  expandAllBtn.addEventListener('click', function () {
    allExpanded = !allExpanded;
    var allSubs = sidebarList.querySelectorAll('.toc-list > li > ol');
    var allToggles = sidebarList.querySelectorAll('.toc-section-toggle');
    for (var e = 0; e < allSubs.length; e++) {
      allSubs[e].classList.toggle('toc-collapsed', !allExpanded);
    }
    for (var f = 0; f < allToggles.length; f++) {
      allToggles[f].classList.toggle('toc-expanded', allExpanded);
    }
    expandAllBtn.textContent = allExpanded ? '[Collapse all]' : '[Expand all]';
  });

  // --- Auto expand/collapse based on scroll position ---
  // Suppress during smooth scroll (TOC clicks or page load with hash)
  var isScrollingToTarget = !!window.location.hash;
  var scrollStopTimer = null;

  sidebar.addEventListener('click', function (e) {
    if (e.target.closest('a')) {
      isScrollingToTarget = true;
    }
  });
  // Also suppress for heading anchor clicks within the article
  article.addEventListener('click', function (e) {
    var link = e.target.closest('a.heading-anchor');
    if (link) isScrollingToTarget = true;
  });

  function updateExpanded() {
    if (isScrollingToTarget) return;

    var active = null;

    for (var k = 0; k < headings.length; k++) {
      if (headings[k].getBoundingClientRect().top <= 100) {
        active = headings[k].id;
      }
    }

    // Find which top-level li contains the active heading
    var sidebarLinks = sidebarList.querySelectorAll('a');
    var activeParentLi = null;
    for (var m = 0; m < sidebarLinks.length; m++) {
      if (sidebarLinks[m].getAttribute('href') === '#' + active) {
        activeParentLi = sidebarLinks[m].closest('.toc-list > li');
        break;
      }
    }

    var refreshedTopItems = sidebarList.querySelectorAll('.toc-list > li');
    for (var n = 0; n < refreshedTopItems.length; n++) {
      var toggle = refreshedTopItems[n].querySelector('.toc-section-toggle');
      var subOl = refreshedTopItems[n].querySelector('ol');
      if (!subOl) continue;

      if (refreshedTopItems[n] === activeParentLi) {
        subOl.classList.remove('toc-collapsed');
        if (toggle) toggle.classList.add('toc-expanded');
      } else {
        subOl.classList.add('toc-collapsed');
        if (toggle) toggle.classList.remove('toc-expanded');
      }
    }
  }

  var ticking = false;
  window.addEventListener('scroll', function () {
    if (isScrollingToTarget) {
      clearTimeout(scrollStopTimer);
      scrollStopTimer = setTimeout(function () {
        isScrollingToTarget = false;
        updateExpanded();
      }, 150);
    }
    if (!ticking) {
      requestAnimationFrame(function () {
        updateExpanded();
        ticking = false;
      });
      ticking = true;
    }
  });
  updateExpanded();
})();
