function blogSearch() {
  return {
    query: '',
    index: null,
    searchPage: 0,
    pageSize: 15,
    get results() {
      var q = this.query.trim().toLowerCase();
      if (!q || !this.index) return [];
      return this.index.filter(function (post) {
        return post.title.toLowerCase().indexOf(q) !== -1 ||
          post.description.toLowerCase().indexOf(q) !== -1 ||
          post.tags.some(function (tag) { return tag.toLowerCase().indexOf(q) !== -1; });
      });
    },
    get totalPages() {
      return Math.ceil(this.results.length / this.pageSize);
    },
    get pagedResults() {
      var start = this.searchPage * this.pageSize;
      return this.results.slice(start, start + this.pageSize);
    },
    init() {
      var self = this;
      this.pageSize = parseInt(this.$el.dataset.pageSize) || 15;
      fetch('/blog/search-index.json')
        .then(function (r) { return r.json(); })
        .then(function (data) { self.index = data; });
      this.$watch('query', function () { self.searchPage = 0; });
    }
  };
}
