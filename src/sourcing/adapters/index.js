const { HNAlgoliaAdapter } = require('./hnAlgoliaAdapter');
const { HtmlListAdapter } = require('./htmlListAdapter');
const { RssAdapter } = require('./rssAdapter');

const ADAPTERS = {
  hn_algolia: HNAlgoliaAdapter,
  html_list: HtmlListAdapter,
  rss: RssAdapter,
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
