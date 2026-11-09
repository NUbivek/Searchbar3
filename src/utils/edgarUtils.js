const axios = require('axios');
const { DATA_PROVIDERS } = require('./dataSources');
const { logger } = require('./logger');

class EdgarAPI {
    constructor() {
        this.lastRequestTime = 0;
        this.minRequestInterval = 500; // 500ms between requests (2 requests per second to be very safe)
        this.baseRetryDelay = 1000; // Start with 1s retry delay
        this.maxRetryDelay = 30000; // Max 30s delay
        this.maxRetries = 5;
    }

    async makeRequest(config) {
        const edgar = DATA_PROVIDERS.government_data.edgar;
        const headers = {
            ...edgar.headers,
            'Accept-Encoding': 'gzip, deflate',
            'Host': 'data.sec.gov'
        };

        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        
        if (timeSinceLastRequest < this.minRequestInterval) {
            await new Promise(r => setTimeout(r, this.minRequestInterval - timeSinceLastRequest));
        }

        let retryCount = 0;
        let retryDelay = this.baseRetryDelay;

        while (retryCount <= this.maxRetries) {
            try {
                const response = await axios({
                    ...config,
                    headers: { ...headers, ...config.headers }
                });
                this.lastRequestTime = Date.now();
                return response;
            } catch (error) {
                if (error.response?.status === 429 || error.response?.status === 403) {
                    if (retryCount === this.maxRetries) throw error;
                    
                    logger.warn(`SEC EDGAR rate limit exceeded (attempt ${retryCount + 1}), retrying after ${retryDelay}ms...`);
                    await new Promise(r => setTimeout(r, retryDelay));
                    retryCount++;
                    retryDelay = Math.min(retryDelay * 2, this.maxRetryDelay);
                    continue;
                }
                throw error;
            }
        }
    }

    async fetchData(endpoint, params = {}) {
        const edgar = DATA_PROVIDERS.government_data.edgar;
        const url = `${edgar.base_url}${endpoint}`;

        try {
            const response = await this.makeRequest({
                method: 'GET',
                url,
                params
            });
            return response.data;
        } catch (error) {
            logger.error('Error fetching EDGAR data:', error);
            throw error;
        }
    }

    /**
     * Find companies by name or ticker in SEC's company list
     * (www.sec.gov/files/company_tickers.json). The previous version called
     * cgi-bin/browse-edgar on data.sec.gov, which SEC does not serve there,
     * so it always failed. Returns [{ cik, ticker, title }], best match first.
     */
    async searchCompany(query) {
        try {
            const q = String(query || '').trim();
            if (!q) return [];
            if (!this.tickerCache || Date.now() - this.tickerCache.at > 24 * 3600 * 1000) {
                const ua = DATA_PROVIDERS.government_data.edgar.headers?.['User-Agent'] || 'Searchbar3-Research research@example.com';
                const res = await axios.get('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': ua }, timeout: 8000 });
                this.tickerCache = { at: Date.now(), list: Object.values(res.data || {}) };
            }
            const norm = (v) => String(v || '').toLowerCase().replace(/[.,&'’/-]/g, ' ')
                .replace(/\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|llc|holdings?|group|the)\b/g, ' ')
                .replace(/\s+/g, ' ').trim();
            const target = norm(q);
            const upper = q.toUpperCase();
            const scored = [];
            for (const c of this.tickerCache.list) {
                const title = norm(c.title);
                let score = 0;
                if (c.ticker === upper) score = 3;
                else if (title === target) score = 2;
                else if (target.length >= 4 && title.startsWith(`${target} `)) score = 1;
                if (score) scored.push({ score, cik: String(c.cik_str), ticker: c.ticker, title: c.title });
            }
            return scored.sort((a, b) => b.score - a.score).slice(0, 5).map(({ score, ...c }) => c);
        } catch (error) {
            logger.error('Error searching company:', error.message);
            return [];
        }
    }

    /** Recent filings for a CIK, normalized for display. */
    async getRecentFilings(cik, limit = 5) {
        const sub = await this.getFilings(String(cik));
        const recent = sub?.filings?.recent;
        if (!recent?.form) return [];
        const out = [];
        for (let i = 0; i < recent.form.length && out.length < limit; i += 1) {
            if (!/^(10-K|10-Q|8-K|S-1|20-F|40-F|DEF 14A)$/.test(recent.form[i])) continue;
            const acc = String(recent.accessionNumber?.[i] || '');
            out.push({
                cik: String(cik),
                companyName: sub.name,
                formType: recent.form[i],
                filingDate: recent.filingDate?.[i] || null,
                description: recent.primaryDocDescription?.[i] || null,
                url: acc && recent.primaryDocument?.[i]
                    ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, '')}/${recent.primaryDocument[i]}`
                    : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`
            });
        }
        return out;
    }

    async getFilings(cik) {
        // Pad CIK with leading zeros to 10 digits
        const paddedCik = cik.padStart(10, '0');
        try {
            const response = await this.fetchData(`submissions/CIK${paddedCik}.json`);
            return response;
        } catch (error) {
            logger.error('Error getting filings:', error);
            return null;
        }
    }

    async getXBRLData(accessionNumber) {
        try {
            const response = await this.fetchData(`data/xbrl/companyfacts/CIK${accessionNumber}.json`);
            return response;
        } catch (error) {
            logger.error('Error getting XBRL data:', error);
            return null;
        }
    }
}

// Create a singleton instance
const edgarAPI = new EdgarAPI();

// Export the instance methods directly
const fetchEdgarData = (endpoint, params = {}) => edgarAPI.fetchData(endpoint, params);
const searchCompany = (query) => edgarAPI.searchCompany(query);
const getFilings = (cik) => edgarAPI.getFilings(cik);
const getRecentFilings = (cik, limit) => edgarAPI.getRecentFilings(cik, limit);
const getXBRLData = (accessionNumber) => edgarAPI.getXBRLData(accessionNumber);

module.exports = {
    fetchEdgarData,
    searchCompany,
    getFilings,
    getRecentFilings,
    getXBRLData
};
