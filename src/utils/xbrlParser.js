const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { logger } = require('./logger');

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_'
});

// XBRL context management
class XBRLContext {
    constructor(contextData) {
        this.id = contextData['@_id'];
        this.period = this.extractPeriod(contextData.period);
        this.entity = this.extractEntity(contextData.entity);
    }

    extractPeriod(period) {
        if (period.instant) {
            return { type: 'instant', date: period.instant };
        } else if (period.startDate && period.endDate) {
            return {
                type: 'duration',
                startDate: period.startDate,
                endDate: period.endDate
            };
        }
        return null;
    }

    extractEntity(entity) {
        return {
            identifier: entity.identifier['#text'],
            scheme: entity.identifier['@_scheme']
        };
    }
}

// XBRL fact management
class XBRLFact {
    constructor(factData, contextRef) {
        this.value = factData['#text'];
        this.contextRef = contextRef;
        this.unit = factData['@_unitRef'];
        this.decimals = factData['@_decimals'];
        this.name = factData.name;
    }

    normalize() {
        return {
            value: parseFloat(this.value) || this.value,
            unit: this.unit,
            decimals: parseInt(this.decimals),
            context: this.contextRef
        };
    }
}

export class XBRLParser {
    constructor() {
        this.contexts = new Map();
        this.facts = new Map();
    }

    async parseURL(url) {
        try {
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'SearchBar/1.0'
                }
            });
            return this.parseContent(response.data);
        } catch (error) {
            logger.error('Error fetching XBRL document:', error);
            return null;
        }
    }

    parseContent(content) {
        try {
            const parsed = parser.parse(content);
            const xbrl = this.findXBRLRoot(parsed);
            
            if (!xbrl) {
                logger.warn('No XBRL content found');
                return null;
            }

            // Extract contexts
            this.extractContexts(xbrl);
            
            // Extract facts
            return this.extractFacts(xbrl);
        } catch (error) {
            logger.error('Error parsing XBRL content:', error);
            return null;
        }
    }

    findXBRLRoot(parsed) {
        // Handle different XBRL root element possibilities
        const possibleRoots = ['xbrl', 'xbrli:xbrl'];
        for (const root of possibleRoots) {
            if (parsed[root]) {
                return parsed[root];
            }
        }
        return null;
    }

    extractContexts(xbrl) {
        const contexts = xbrl.context || [];
        (Array.isArray(contexts) ? contexts : [contexts]).forEach(context => {
            if (context['@_id']) {
                this.contexts.set(context['@_id'], new XBRLContext(context));
            }
        });
    }

    extractFacts(xbrl) {
        const facts = {};
        
        // Common financial statement elements
        const commonElements = [
            'us-gaap:Assets',
            'us-gaap:Liabilities',
            'us-gaap:StockholdersEquity',
            'us-gaap:Revenues',
            'us-gaap:OperatingIncomeLoss',
            'us-gaap:NetIncomeLoss'
        ];

        commonElements.forEach(element => {
            if (xbrl[element]) {
                const factData = Array.isArray(xbrl[element]) ? 
                    xbrl[element] : [xbrl[element]];
                
                facts[element] = factData.map(data => {
                    const fact = new XBRLFact(data, data['@_contextRef']);
                    return fact.normalize();
                });
            }
        });

        return {
            facts,
            contexts: Object.fromEntries(this.contexts)
        };
    }
}

// Utility functions for common financial calculations
const calculateFinancialRatios = (facts) => {
    const latestFacts = {};
    Object.entries(facts).forEach(([key, values]) => {
        // Get the most recent value
        latestFacts[key] = values.reduce((latest, current) => {
            if (!latest || current.context.period.instant > latest.context.period.instant) {
                return current;
            }
            return latest;
        });
    });

    return {
        currentRatio: latestFacts['us-gaap:Assets']?.value / latestFacts['us-gaap:Liabilities']?.value,
        profitMargin: latestFacts['us-gaap:NetIncomeLoss']?.value / latestFacts['us-gaap:Revenues']?.value,
        operatingMargin: latestFacts['us-gaap:OperatingIncomeLoss']?.value / latestFacts['us-gaap:Revenues']?.value
    };
};

module.exports = {
    XBRLParser,
    calculateFinancialRatios
};
