const { ApiSearchAdapter } = require('./apiSearchAdapter');
  const { HNAlgoliaAdapter } = require('./hnAlgoliaAdapter');
  const { HtmlListAdapter } = require('./htmlListAdapter');
const { JsRenderedAdapter } = require('./jsRenderedAdapter');
  const { RssAdapter } = require('./rssAdapter');
const { SearchApiAdapter } = require('./searchApiAdapter');

const ADAPTERS = {
  api_search: ApiSearchAdapter,
  hn_algolia: HNAlgoliaAdapter,
  html_list: HtmlListAdapter,
  js_rendered: JsRenderedAdapter,
  rss: RssAdapter,
  search_api: SearchApiAdapter,
};

function createAdapter(source, options = {}) {
  const AdapterClass = ADAPTERS[source.adapter];

  if (!AdapterClass) {
    throw new Error(`Unsupported adapter: ${source.adapter}`);
  }

  return new AdapterClass(source, options);
}

module.exports = {
  ADAPTERS,
  createAdapter,
};
