/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./templates/*.html', './js/*.js', './blog/**/*.njk'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
}
