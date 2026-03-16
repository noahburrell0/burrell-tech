(function () {
  var s = localStorage.getItem('theme');
  if (s === 'dark' || (s === null && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }
}());
