# burrell-tech

Static website for [Burrell Technology Services](https://burrell.tech). Built with Tailwind CSS, a custom i18n build system, and Eleventy for the blog. Supports English and Spanish.

## Stack

- **Tailwind CSS v4** -- utility-first CSS framework, compiled from `css/input.css` with the `@tailwindcss/typography` plugin for blog prose styling
- **Eleventy (11ty) v3** -- static site generator used exclusively for the blog (`blog/` directory). Renders Markdown posts into `dist/blog/`
- **Custom i18n build script** -- Node.js script (`scripts/build-i18n.js`) that injects translations from JSON files into HTML templates, generating English and Spanish versions of each page
- **Alpine.js** -- lightweight JS framework loaded from CDN for interactive UI components (mobile nav toggle, etc.)
- **Inter** -- self-hosted variable font via `@fontsource-variable/inter`
- **Nginx** (Docker) -- local dev server with clean URL support

## Repository Structure

```
burrell-tech/
|-- blog/                    # Eleventy source (blog only)
|   |-- _data/
|   |   |-- site.json        # Global blog data (site URL, author)
|   |-- _includes/
|   |   |-- layouts/
|   |       |-- blog.njk     # Blog listing page layout
|   |       |-- post.njk     # Individual blog post layout
|   |-- posts/
|   |   |-- posts.json       # Default frontmatter for all posts
|   |   |-- *.md             # Blog posts (Markdown with frontmatter)
|   |-- blog.njk             # Blog index page entry point
|-- css/
|   |-- custom.css           # Hand-written CSS (sticky footer, scrollbar, etc.)
|   |-- input.css            # Tailwind CSS entry point
|-- dist/                    # Build output
|-- i18n/
|   |-- en.json              # English translation strings
|   |-- es.json              # Spanish translation strings
|-- js/
|   |-- analytics.js         # Analytics script
|   |-- components.js        # Shared nav, footer, and CTA components
|   |-- main.js              # Dark mode toggle and other utilities
|   |-- theme.js             # Blocking script to prevent dark mode flash
|-- scripts/
|   |-- build-i18n.js        # i18n template build script
|   |-- watch.js              # Development file watcher
|-- static/
|   |-- favicon.ico
|   |-- logo.png
|   |-- robots.txt
|   |-- sitemap.xml
|-- templates/               # HTML page templates with {{placeholder}} tokens
|   |-- index.html
|   |-- services.html
|   |-- about.html
|   |-- contact.html
|   |-- privacy.html
|-- .eleventy.js             # Eleventy configuration
|-- Makefile                 # Build and dev server commands
|-- package.json
|-- tailwind.config.js       # Tailwind content paths and theme config
```

## Prerequisites

- Node.js (v18+)
- npm
- Docker (for local dev server only)

## Development

### Build the site

```sh
make build
```

This runs the full build pipeline:

1. `npm install` -- install dependencies
2. Tailwind CSS compilation -- `css/input.css` to `dist/css/tailwind.css` (minified)
3. Copy static assets -- `custom.css`, JS files, fonts, favicons, sitemap, robots.txt
4. i18n build -- generates English pages in `dist/` and Spanish pages in `dist/es/` from templates and translation files
5. Eleventy build -- generates blog pages in `dist/blog/` from Markdown posts

### Operate the local dev server

```sh
make start
```

Runs an Nginx container serving `dist/` on `http://localhost:8080` with clean URL rewrites (e.g., `/about` serves `about.html`).

Optionally change the port from `8080` with `PORT=3000 make start`.

```sh
make stop
```

Stops and removes the dev container.

### Watch mode

```sh
make watch
```

Runs three watchers in parallel:

1. **Tailwind CSS** -- recompiles `dist/css/tailwind.css` when CSS or template classes change
2. **Eleventy** -- rebuilds blog pages when Markdown posts or Nunjucks layouts change
3. **Asset watcher** -- copies JS, static files, and rebuilds i18n when templates, translations, or scripts change

Run `make build` once first to populate `dist/`, then use `make watch` for incremental rebuilds during development.

### Clean

```sh
make clean
```

Removes all files in `dist/`.

## How It Works

### Main site pages

HTML templates in `templates/` contain `{{placeholder}}` tokens. The i18n build script reads `i18n/en.json` and `i18n/es.json`, replaces all tokens with the corresponding translation strings, and writes the output to `dist/` (English) and `dist/es/` (Spanish). The script also injects `hreflang` link tags for SEO.

Shared UI components (nav, footer, CTA section) are rendered client-side by `js/components.js`. This script detects the current language from the URL path, loads inline translations for component text, and injects the HTML into placeholder `<div>` elements.

### Blog

Blog posts are Markdown files in `blog/posts/` with YAML frontmatter:

```yaml
---
title: "Post Title"
date: 2026-03-16
description: "Short description for meta tags and listing cards."
tags: [kubernetes, argo-cd]
---
```

Eleventy processes these into `dist/blog/<slug>/index.html` using the Nunjucks layouts in `blog/_includes/layouts/`. The blog listing page at `dist/blog/index.html` shows all posts sorted by date (newest first). Blog content is English-only.

### Dark mode

Dark mode is toggled via a `.dark` class on the `<html>` element. `js/theme.js` runs as a blocking script in the `<head>` to apply the stored theme preference (or system preference) before the page renders, preventing a white flash.

### Internationalization

The site supports English and Spanish. Language is determined by URL path (`/es/` prefix for Spanish). The language switcher in the nav allows users to toggle between languages. On blog pages, where content is English-only, the switcher stores the preference in `localStorage` for use when navigating back to translated pages.

To add or update translations, edit the JSON files in `i18n/`. Keys in the JSON files correspond directly to `{{placeholder}}` tokens in the HTML templates.
