const { ApiSearchAdapter } = require('./apiSearchAdapter');
const { FilteredPitchbookAdapter } = require('./filteredPitchbookAdapter');
const { HNAlgoliaAdapter } = require('./hnAlgoliaAdapter');
const { HtmlListAdapter } = require('./htmlListAdapter');
const { RssAdapter } = require('./rssAdapter');
const { SearchApiAdapter } = require('./searchApiAdapter');

const ADAPTERS = {
  api_search: ApiSearchAdapter,
  filtered_pitchbook: FilteredPitchbookAdapter,
  hn_algolia: HNAlgoliaAdapter,
  html_list: HtmlListAdapter,
  rss: RssAdapter,
  search_api: SearchApiAdapter,
};

function createAdapter(source, options = {}) {
  const AdapterClass = source.adapter === 'js_rendered'
    ? require('./playwrightAdapter').PlaywrightAdapter
    : ADAPTERS[source.adapter];

  if (!AdapterClass) {
    throw new Error(`Unsupported adapter: ${source.adapter}`);
  }

  return new AdapterClass(source, options);
}

module.exports = {
  ADAPTERS,
  createAdapter,
};
