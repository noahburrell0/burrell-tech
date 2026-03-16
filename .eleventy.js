module.exports = function (eleventyConfig) {
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
