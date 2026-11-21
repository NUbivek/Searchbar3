/**
 * Every source the deep background check can ask, in one list.
 *
 * A source ("connector") is an object:
 *   id, label          how it is identified and shown
 *   kinds              which threads it can work on: 'subject' (the person),
 *                      'company', 'school', 'associate', 'relative', 'handle',
 *                      'domain', 'url'
 *   prior              how useful it is expected to be before any evidence (0..1)
 *   enabled()          optional; false when it needs something this deployment lacks
 *   unavailableReason  shown in the coverage statement when it is off
 *   maxParallel        optional; how many of its lookups may run at once (for
 *                      sources that must be paced)
 *   plan(thread, subject)  optional; the query patterns to run for a thread,
 *                      as [{ template, params?, prior?, why? }]. Each becomes
 *                      its own lookup, scored separately by learning.js.
 *   run(task, ctx)     does one lookup. task = { kind, value, template, params,
 *                      depth, relation }; ctx = { subject, deadline, known() }.
 *                      Resolves to { findings, threads, notes } built with
 *                      makeFinding / makeThread (finding.js).
 *
 * All sources are free. None needs a key unless `enabled` says so.
 */
import { secPersonConnector, secCompanyConnector } from './sec';
import { patentsConnector, trademarksConnector } from './ip';
import { domainHistoryConnector } from './domains';
import { ukCompaniesConnector, frCompaniesConnector, usStateRegistriesConnector, leiConnector, ycDirectoryConnector } from './registries';
import { leakSiteConnector, breachCatalogueConnector, breachRegistersConnector } from './exposure';
import * as courts from './courts';
import { sanctionsListsConnector, exclusionsConnector, offshoreLeaksConnector, wantedConnector } from './sanctions';
import * as knowledge from './knowledge';
import { academicRecordConnector, publicationsConnector } from './scholar';
import { githubConnector, hackerNewsConnector, linkedAccountsConnector } from './profiles';
import { archiveConnector } from './archive';
import { webSearchConnector, newsArchiveConnector } from './web';
import { pageReaderConnector } from './pages';
import * as courtsMore from './courtsMore';
import { mdbDebarmentConnector, usBankRegulatorsConnector, fincenActionsConnector } from './debarment';
import { usFederalAwardsConnector, usLobbyingConnector, cfpbComplaintsConnector, federalRegisterConnector, fdaRecallsConnector, nihGrantsConnector } from './government';
import { semanticScholarConnector, stackOverflowConnector, npmPackagesConnector, blueskyConnector, mastodonConnector, writingFeedsConnector } from './presence';

// The web archive answers slowly and refuses connections after a burst: one lookup at a time.
archiveConnector.maxParallel = 1;
// LittleSis and The Gazette each ask for ten seconds between requests
for (const c of [...Object.values(knowledge), ...Object.values(courts)]) {
  if (c && (c.id === 'littlesis' || c.id === 'uk-gazette')) c.maxParallel = 1;
}

/** Every object a source file exports that looks like a connector (so a file can gain one without this list changing). */
const connectorsOf = (module) => Object.values(module).filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && Array.isArray(x.kinds) && typeof x.run === 'function');

export const CONNECTORS = [
  // the open web: carries most of the load and finds the pages other sources then dig into
  webSearchConnector, newsArchiveConnector,
  // the pages about the person that the search found, read for their career and education
  pageReaderConnector,
  // earlier versions of profiles, bios and resumes
  archiveConnector,
  // who the person is, on the public record
  ...connectorsOf(knowledge),
  githubConnector, hackerNewsConnector, linkedAccountsConnector,
  stackOverflowConnector, npmPackagesConnector, blueskyConnector, mastodonConnector, writingFeedsConnector,
  academicRecordConnector, publicationsConnector, semanticScholarConnector,
  // courts, regulators, watchlists
  ...connectorsOf(courts),
  ...connectorsOf(courtsMore),
  sanctionsListsConnector, exclusionsConnector, offshoreLeaksConnector, wantedConnector,
  // the development banks' debarment list (EBRD, carrying World Bank, ADB, IDB and AfDB cross-debarments). Its
  // publisher's terms allow personal, non-commercial use; the owner confirmed on 2026-11-20 that this site is
  // non-commercial and asked for it to be on. Then bank regulators' orders and FinCEN actions.
  mdbDebarmentConnector, usBankRegulatorsConnector, fincenActionsConnector,
  // US federal records: awards, lobbying registrations, consumer complaints, Federal Register, FDA recalls, NIH grants
  usFederalAwardsConnector, usLobbyingConnector, cfpbComplaintsConnector, federalRegisterConnector, fdaRecallsConnector, nihGrantsConnector,
  // filings and company records
  secPersonConnector, secCompanyConnector,
  ukCompaniesConnector, frCompaniesConnector, usStateRegistriesConnector, leiConnector, ycDirectoryConnector,
  patentsConnector, trademarksConnector, domainHistoryConnector,
  // company-level breach and leak-site exposure
  leakSiteConnector, breachCatalogueConnector, breachRegistersConnector,
].filter(Boolean);

export const connectorById = (id) => CONNECTORS.find((c) => c.id === id) || null;
