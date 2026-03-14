// Theme toggle
function toggleTheme() {
  var html = document.documentElement;
  if (html.classList.contains('dark')) {
    html.classList.remove('dark');
    localStorage.setItem('theme', 'light');
  } else {
    html.classList.add('dark');
    localStorage.setItem('theme', 'dark');
  }
}

// Copyright year
document.addEventListener('DOMContentLoaded', function () {
  const el = document.getElementById('copyright-year');
  if (el) el.textContent = new Date().getFullYear();

  // Contact form handler
  const form = document.getElementById('contact-form');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      handleContactForm(form);
    });
  }
});

function handleContactForm(form) {
  const submitBtn = document.getElementById('submit-btn');
  const submitText = document.getElementById('submit-text');
  const submitSpinner = document.getElementById('submit-spinner');
  const successEl = document.getElementById('form-success');
  const errorEl = document.getElementById('form-error');
  const errorMsg = document.getElementById('form-error-msg');

  // Validate required fields
  const name = form.querySelector('#name').value.trim();
  const email = form.querySelector('#email').value.trim();
  const subject = form.querySelector('#subject').value.trim();
  const message = form.querySelector('#message').value.trim();

  if (!name || !email || !subject || !message) {
    showError(errorEl, errorMsg, 'Please fill in all required fields.');
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showError(errorEl, errorMsg, 'Please enter a valid email address.');
    return;
  }

  // Hide previous messages
  successEl.classList.add('hidden');
  errorEl.classList.add('hidden');

  // Show loading state
  submitBtn.disabled = true;
  submitText.textContent = 'Sending...';
  submitSpinner.classList.remove('hidden');

  const formData = new FormData(form);

  fetch('https://api.burrell.tech/contact', {
    method: 'POST',
    body: formData
  })
    .then(function (response) {
      if (response.status === 201) {
        successEl.classList.remove('hidden');
        form.reset();
      } else if (response.status === 429) {
        showError(errorEl, errorMsg, 'Too many requests. Please wait a moment and try again.');
      } else {
        showError(errorEl, errorMsg, 'There was an error sending your message. Please try again or email me directly at noah@burrell.tech.');
      }
    })
    .catch(function () {
      showError(errorEl, errorMsg, 'Could not reach the server. Please email me directly at noah@burrell.tech.');
    })
    .finally(function () {
      submitBtn.disabled = false;
      submitText.textContent = 'Send Message';
      submitSpinner.classList.add('hidden');
    });
}

function showError(errorEl, errorMsg, message) {
  errorMsg.textContent = message;
  errorEl.classList.remove('hidden');
  errorEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
