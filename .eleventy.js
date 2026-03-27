var markdownIt = require('markdown-it');
var markdownItAnchor = require('markdown-it-anchor');

module.exports = function (eleventyConfig) {
  // Customize Markdown: open links in new tab
  var md = markdownIt({ html: true, linkify: true });
  md.use(markdownItAnchor, { permalink: false });
  var defaultRender = md.renderer.rules.link_open || function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener');
    return defaultRender(tokens, idx, options, env, self);
  };
  // Wrap tables in a scrollable div
  var defaultTableOpen = md.renderer.rules.table_open || function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.table_open = function (tokens, idx, options, env, self) {
    return '<div class="table-wrap">' + defaultTableOpen(tokens, idx, options, env, self);
  };
  var defaultTableClose = md.renderer.rules.table_close || function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.table_close = function (tokens, idx, options, env, self) {
    return defaultTableClose(tokens, idx, options, env, self) + '</div>';
  };
  eleventyConfig.setLibrary('md', md);
  // Posts collection sorted by date descending
  eleventyConfig.addCollection('posts', function (collectionApi) {
    return collectionApi.getFilteredByGlob('blog/posts/*.md').sort(function (a, b) {
      return b.date - a.date;
    });
  });

  // Date formatting filter (UTC to avoid timezone shift)
  eleventyConfig.addFilter('readableDate', function (date) {
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC'
    });
  });

  // ISO date filter for structured data
  eleventyConfig.addFilter('isoDate', function (date) {
    return new Date(date).toISOString().split('T')[0];
  });

  // Reading time filter (words per minute)
  eleventyConfig.addFilter('readingTime', function (content) {
    var text = (content || '').replace(/<[^>]*>/g, '');
    var words = text.trim().split(/\s+/).length;
    var minutes = Math.ceil(words / 225);
    return minutes + ' min read';
  });

  // Slug from input path (strips date prefix and extension)
  eleventyConfig.addFilter('postSlug', function (inputPath) {
    var basename = inputPath.split('/').pop();
    return basename.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
  });

  return {
    dir: {
      input: 'blog',
      output: 'dist',
      includes: '_includes',
      data: '_data'
    },
    markdownTemplateEngine: 'njk',
    htmlTemplateEngine: 'njk'
  };
};
