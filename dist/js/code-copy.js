(function () {
  var copyIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

  var blocks = document.querySelectorAll('article pre');
  for (var i = 0; i < blocks.length; i++) {
    var pre = blocks[i];
    pre.style.position = 'relative';
    var btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.setAttribute('aria-label', 'Copy code');
    btn.innerHTML = copyIcon;
    btn.addEventListener('click', (function (block) {
      return function () {
        var code = block.querySelector('code');
        var text = (code || block).textContent;
        navigator.clipboard.writeText(text).then(function () {
          var tooltip = document.createElement('span');
          tooltip.className = 'code-copy-tooltip';
          tooltip.textContent = 'Copied!';
          block.appendChild(tooltip);
          setTimeout(function () {
            tooltip.remove();
          }, 1500);
        });
      };
    })(pre));
    pre.appendChild(btn);
  }
})();
