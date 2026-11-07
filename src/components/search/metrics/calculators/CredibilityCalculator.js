/**
 * CredibilityCalculator.js
 * Calculates the credibility score for search results based on source reputation, author expertise, and citation quality.
 * Enhanced with author verification, peer review detection, and institutional affiliation assessment.
 */

import { 
  normalizeScore,
  matchesDomain
} from '../../utils/calculatorUtils';

import {
  DISPLAY_THRESHOLD,
  PRESTIGIOUS_INSTITUTIONS as PRESTIGIOUS_INSTITUTIONS_DATA,
  RESEARCH_ORGANIZATIONS as RESEARCH_ORGANIZATIONS_DATA
} from '../../utils/calculatorData';

// Define professional credentials since they're not in calculatorData
const PROFESSIONAL_CREDENTIALS_DATA = [
  'phd', 'md', 'jd', 'mba', 'cpa', 'cfa', 'frm', 'pmp',
  'professor', 'doctor', 'attorney', 'scientist', 'researcher',
  'analyst', 'expert', 'specialist', 'fellow', 'director'
];

// Constants for weighting different factors
const WEIGHTS = {
  SOURCE_REPUTATION: 0.40,
  AUTHOR_EXPERTISE: 0.25,
  CITATION_QUALITY: 0.20,
  VERIFICATION_FACTORS: 0.15, // New weight for verification factors
};

// Minimum threshold for credibility score (70%)
const CREDIBILITY_THRESHOLD = DISPLAY_THRESHOLD;

// List of prestigious academic institutions
const PRESTIGIOUS_INSTITUTIONS = PRESTIGIOUS_INSTITUTIONS_DATA;

// List of reputable research organizations
const RESEARCH_ORGANIZATIONS = RESEARCH_ORGANIZATIONS_DATA;

// List of professional credentials
const PROFESSIONAL_CREDENTIALS = PROFESSIONAL_CREDENTIALS_DATA;

/**
 * Calculate the credibility score for a search result
 * @param {Object} result - The search result object
 * @param {Object} options - Additional options for calculation
 * @returns {number} - The credibility score (0-100)
 */
const calculateCredibilityScore = (result, options = {}) => {
  if (!result) return 0;
  
  // Extract relevant data from result
  const { url, domain, author, authorDetails = {}, citations = [], references = [] } = result;
  
  // Ensure source is a string
  const source = typeof result.source === 'string' ? result.source : String(result.source || '');
  
  // Ensure content is a string
  const content = typeof result.content === 'string' ? result.content : String(result.content || '');
  
  // Calculate individual component scores
  const sourceReputationScore = calculateSourceReputation(url, domain);
  const authorExpertiseScore = calculateAuthorExpertise(author, authorDetails);
  const citationQualityScore = calculateCitationQuality(citations, references);
  const verificationFactorsScore = calculateVerificationFactors({...result, source, content});
  
  // Calculate weighted score
  const weightedScore = 
    (sourceReputationScore * WEIGHTS.SOURCE_REPUTATION) +
    (authorExpertiseScore * WEIGHTS.AUTHOR_EXPERTISE) +
    (citationQualityScore * WEIGHTS.CITATION_QUALITY) +
    (verificationFactorsScore * WEIGHTS.VERIFICATION_FACTORS);
  
  // 0-1 scale (normalizeScore clamps to 0-1; score*100 made every source 1.0)
  return normalizeScore(weightedScore);
};

/**
 * Calculate source reputation score
 * @param {string} url - The result URL
 * @param {string} domain - The result domain
 * @returns {number} - The source reputation score (0-1)
 */
const calculateSourceReputation = (url, domain) => {
  if (!url) return 0;
  
  let score = 0.5; // Default score
  
  // Ensure url is a string before calling toLowerCase
  const urlLower = typeof url === 'string' ? url.toLowerCase() : String(url).toLowerCase();
  
  // Check for academic domains
  if (matchesDomain(urlLower, ['edu', 'ac.uk', 'edu.au'])) {
    score += 0.3;
  }
  
  // Check for government domains
  if (matchesDomain(urlLower, ['gov', 'mil'])) {
    score += 0.25;
  }
  
  // Check for established news sources
  if (matchesDomain(urlLower, ['nytimes.com', 'wsj.com', 'reuters.com', 'bloomberg.com', 'ft.com', 'economist.com'])) {
    score += 0.2;
  }
  
  // Check for scientific journals
  if (matchesDomain(urlLower, ['nature.com', 'science.org', 'cell.com', 'nejm.org', 'thelancet.com'])) {
    score += 0.3;
  }
  
  // Normalize score to 0-1 range
  return Math.min(Math.max(score, 0), 1);
};

/**
 * Calculate author expertise score
 * @param {string} author - The author name
 * @param {Object} authorDetails - The author details
 * @returns {number} - The author expertise score (0-1)
 */
const calculateAuthorExpertise = (author, authorDetails = {}) => {
  // If no author, return low score
  if (!author) return 0.3;
  
  // Ensure author is a string
  const authorName = typeof author === 'string' ? author.toLowerCase() : String(author).toLowerCase();
  
  let score = 0.5; // Default score
  
  // Check for professional credentials in author name
  for (const credential of PROFESSIONAL_CREDENTIALS) {
    if (authorName.includes(credential)) {
      score += 0.15;
      break;
    }
  }
  
  // Check author details if available
  if (authorDetails) {
    // Ensure affiliation is a string
    const affiliation = typeof authorDetails.affiliation === 'string' 
      ? authorDetails.affiliation.toLowerCase() 
      : String(authorDetails.affiliation || '').toLowerCase();
    
    // Check for prestigious institution affiliation
    for (const institution of PRESTIGIOUS_INSTITUTIONS) {
      if (affiliation.includes(institution)) {
        score += 0.2;
        break;
      }
    }
    
    // Check for research organization affiliation
    for (const organization of RESEARCH_ORGANIZATIONS) {
      if (affiliation.includes(organization)) {
        score += 0.15;
        break;
      }
    }
    
    // Check for verified status
    if (authorDetails.verified) {
      score += 0.15;
    }
    
    // Check for publication count
    if (authorDetails.publicationCount > 10) {
      score += 0.1;
    }
  }
  
  // Normalize score to 0-1 range
  return Math.min(Math.max(score, 0), 1);
};

/**
 * Calculate citation quality score
 * @param {Array} citations - The citations
 * @param {Array} references - The references
 * @returns {number} - The citation quality score (0-1)
 */
const calculateCitationQuality = (citations, references) => {
  let score = 0.5; // Start with a baseline score
  
  // Factor 1: Has citations
  if (citations && citations.length > 0) {
    // More citations generally means better research (up to a point)
    const citationCount = citations.length;
    if (citationCount >= 10) score += 0.2;
    else if (citationCount >= 5) score += 0.15;
    else if (citationCount >= 1) score += 0.1;
    
    // Factor 2: Quality of cited sources
    if (citations.some(citation => isHighQualitySource(citation.source))) {
      score += 0.2;
    } else if (citations.some(citation => isModerateQualitySource(citation.source))) {
      score += 0.1;
    }
    
    // Factor 3: Diversity of citations
    const uniqueSources = new Set(citations.map(citation => citation.source)).size;
    if (uniqueSources >= 5) score += 0.1;
    else if (uniqueSources >= 3) score += 0.05;
  } else if (references && references.length > 0) {
    // If we know it has references but don't have the details
    score += 0.1;
  }
  
  // Factor 4: Peer-reviewed or fact-checked
  if (references && references.some(reference => reference.peerReviewed)) {
    score += 0.25;
  } else if (references && references.some(reference => reference.factChecked)) {
    score += 0.15;
  }
  
  // Factor 5: Direct source availability
  if (references && references.some(reference => reference.directSource)) {
    score += 0.15;
  }
  
  // Cap at 1.0
  return Math.min(score, 1.0);
};

/**
 * Calculate verification factors score
 * @param {Object} result - The search result
 * @returns {number} - The verification factors score (0-1)
 */
const calculateVerificationFactors = (result) => {
  let score = 0.5; // Start with neutral score
  
  // Check for peer review
  const peerReviewScore = detectPeerReview(result);
  
  // Check for author verification
  const authorVerificationScore = verifyAuthor(result.author, result.source, result.authorDetails);
  
  // Check for institutional affiliation
  const institutionalAffiliationScore = assessInstitutionalAffiliation(result);
  
  // Check for transparency factors
  const transparencyScore = assessTransparency(result);
  
  // Combine scores with weights
  score = (peerReviewScore * 0.30) + 
          (authorVerificationScore * 0.30) + 
          (institutionalAffiliationScore * 0.20) + 
          (transparencyScore * 0.20);
  
  return Math.min(score, 1.0);
};

/**
 * Detect if content has undergone peer review
 * @param {Object} result - The search result
 * @returns {number} - The peer review score (0-1)
 */
const detectPeerReview = (result) => {
  let score = 0.5;
  
  // Check if source is a peer-reviewed journal
  if (result.source) {
    // Ensure source is a string before calling toLowerCase
    const sourceLower = typeof result.source === 'string' ? result.source.toLowerCase() : String(result.source).toLowerCase();
    
    // Academic journal indicators
    const journalIndicators = [
      'journal', 'proceedings', 'review', 'quarterly', 'transactions on',
      'acta', 'annals', 'bulletin', 'letters', 'archives'
    ];
    
    if (journalIndicators.some(indicator => sourceLower.includes(indicator))) {
      score += 0.2;
    }
  }
  
  // Check content for peer review mentions
  if (result.content) {
    // Ensure content is a string before calling toLowerCase
    const contentLower = typeof result.content === 'string' ? result.content.toLowerCase() : String(result.content).toLowerCase();
    
    // Peer review terminology
    const peerReviewTerms = [
      'peer-reviewed', 'peer reviewed', 'refereed', 'double-blind',
      'blind review', 'published in', 'accepted for publication'
    ];
    
    if (peerReviewTerms.some(term => contentLower.includes(term))) {
      score += 0.2;
    }
    
    // Check for DOI (Digital Object Identifier)
    if (/doi\.org|doi:/.test(contentLower)) {
      score += 0.1;
    }
  }
  
  // Check if it's a preprint
  if (result.source && /arxiv|biorxiv|medrxiv|ssrn|preprint/i.test(result.source)) {
    // Preprints are not peer-reviewed but are still academic
    score = 0.6;
  }
  
  return Math.min(score, 1.0);
};

/**
 * Verify author credentials and identity
 * @param {string} author - The author name
 * @param {string} source - The source
 * @param {Object} authorDetails - The author details
 * @returns {number} - The author verification score (0-1)
 */
const verifyAuthor = (author, source, authorDetails = {}) => {
  if (!author) return 0;
  
  // Ensure author is a string
  const authorName = typeof author === 'string' ? author.toLowerCase() : String(author).toLowerCase();
  
  // Ensure source is a string
  const sourceName = typeof source === 'string' ? source.toLowerCase() : String(source || '').toLowerCase();
  
  let score = 0.4; // Default score
  
  // Check if author has an institutional email
  if (authorDetails.email) {
    // Ensure email is a string
    const email = typeof authorDetails.email === 'string' 
      ? authorDetails.email.toLowerCase() 
      : String(authorDetails.email || '').toLowerCase();
    
    if (email.includes('.edu') || email.includes('.gov') || email.includes('.org')) {
      score += 0.2;
    }
  }
  
  // Check for author verification on the platform
  if (authorDetails.verified) {
    score += 0.2;
  }
  
  // Check if author is affiliated with the source
  if (sourceName && authorDetails.affiliation) {
    // Ensure affiliation is a string
    const affiliation = typeof authorDetails.affiliation === 'string' 
      ? authorDetails.affiliation.toLowerCase() 
      : String(authorDetails.affiliation || '').toLowerCase();
    
    if (sourceName.includes(affiliation) || affiliation.includes(sourceName)) {
      score += 0.1;
    }
  }
  
  // Check for social media verification
  if (authorDetails.socialProfiles) {
    const verifiedProfiles = authorDetails.socialProfiles.filter(profile => profile.verified).length;
    if (verifiedProfiles > 0) {
      score += Math.min(verifiedProfiles * 0.05, 0.15);
    }
  }
  
  // Normalize score to 0-1 range
  return Math.min(Math.max(score, 0), 1);
};

/**
 * Assess institutional affiliation quality
 * @param {Object} result - The search result
 * @returns {number} - The institutional affiliation score (0-1)
 */
const assessInstitutionalAffiliation = (result) => {
  let score = 0.5;
  
  // Check for institutional affiliation in content
  if (result.content) {
    // Ensure content is a string before calling toLowerCase
    const contentLower = typeof result.content === 'string' ? result.content.toLowerCase() : String(result.content).toLowerCase();
    
    // Check for prestigious academic institutions
    if (PRESTIGIOUS_INSTITUTIONS.some(institution => contentLower.includes(institution))) {
      score += 0.2;
    }
    
    // Check for research organizations
    if (RESEARCH_ORGANIZATIONS.some(org => contentLower.includes(org))) {
      score += 0.15;
    }
    
    // Check for government institutions
    if (/\.gov|government|federal|agency|department of|ministry of/i.test(contentLower)) {
      score += 0.15;
    }
    
    // Check for corporate research
    if (/research (at|by|from) (google|microsoft|apple|amazon|meta|facebook|ibm|intel)/i.test(contentLower)) {
      score += 0.1;
    }
  }
  
  // Check source domain for institutional affiliation
  if (result.source) {
    // Ensure source is a string before calling toLowerCase
    const sourceLower = typeof result.source === 'string' ? result.source.toLowerCase() : String(result.source).toLowerCase();
    
    if (/\.edu$|\.gov$|\.org$|\.ac\.[a-z]{2}$/i.test(sourceLower)) {
      score += 0.1;
    }
  }
  
  return Math.min(score, 1.0);
};

/**
 * Assess transparency in reporting and methodology
 * @param {Object} result - The search result
 * @returns {number} - The transparency score (0-1)
 */
const assessTransparency = (result) => {
  let score = 0.5;
  
  if (result.content) {
    // Ensure content is a string before calling toLowerCase
    const contentLower = typeof result.content === 'string' ? result.content.toLowerCase() : String(result.content).toLowerCase();
    
    // Check for methodology descriptions
    if (/methodology|methods|data collection|research design|study design|approach|procedure/i.test(contentLower)) {
      score += 0.1;
    }
    
    // Check for limitations acknowledgment
    if (/limitation|caveat|constraint|weakness|drawback|shortcoming/i.test(contentLower)) {
      score += 0.1;
    }
    
    // Check for funding disclosure
    if (/funding|grant|financial support|sponsored by|financial disclosure|conflict of interest/i.test(contentLower)) {
      score += 0.1;
    }
    
    // Check for data availability
    if (/data available|dataset available|code available|github|repository|supplementary material/i.test(contentLower)) {
      score += 0.1;
    }
    
    // Check for contact information
    if (/corresponding author|contact information|email:|contact:|for inquiries/i.test(contentLower)) {
      score += 0.1;
    }
  }
  
  return Math.min(score, 1.0);
};

/**
 * Check if a source is a high-quality source
 * @param {string} source - The source to check
 * @returns {boolean} - Whether the source is high quality
 */
const isHighQualitySource = (source) => {
  if (!source) return false;
  
  const highQualitySources = [
    'nature', 'science', 'cell', 'nejm', 'lancet', 'jama', 'bmj',
    'ieee', 'acm', 'harvard', 'stanford', 'mit', 'berkeley', 'oxford',
    'cambridge', 'princeton', 'yale', 'columbia', 'chicago', 'caltech'
  ];
  
  // Ensure source is a string before calling toLowerCase
  const sourceLower = typeof source === 'string' ? source.toLowerCase() : String(source).toLowerCase();
  
  return highQualitySources.some(quality => sourceLower.includes(quality));
};

/**
 * Check if a source is a moderate-quality source
 * @param {string} source - The source to check
 * @returns {boolean} - Whether the source is moderate quality
 */
const isModerateQualitySource = (source) => {
  if (!source) return false;
  
  const moderateQualitySources = [
    'pubmed', 'springer', 'wiley', 'elsevier', 'frontiers', 'sage',
    'oxford journals', 'cambridge journals', 'acs', 'aps', 'plos',
    'mdpi', 'hindawi', 'taylor & francis', 'emerald', 'bmc'
  ];
  
  // Ensure source is a string before calling toLowerCase
  const sourceLower = typeof source === 'string' ? source.toLowerCase() : String(source).toLowerCase();
  
  return moderateQualitySources.some(quality => sourceLower.includes(quality));
};

export const calculateCredibility = calculateCredibilityScore;
export default calculateCredibilityScore;