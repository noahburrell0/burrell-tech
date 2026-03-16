(function () {
  var GA_ID = 'G-BCFH7EJYP0';
  var CONSENT_KEY = 'cookie_consent';

  function loadGA() {
    if (document.getElementById('ga-script')) return;
    var s = document.createElement('script');
    s.id = 'ga-script';
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    window.gtag = gtag;
    gtag('js', new Date());
    gtag('config', GA_ID);
  }

  // If user has already accepted, load GA immediately
  var consent = localStorage.getItem(CONSENT_KEY);
  if (consent === 'accepted') {
    loadGA();
  }

  // Expose for the consent banner to call
  window._loadGA = loadGA;
})();
