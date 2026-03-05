/**
 * Category Visibility Diagnostic Tool
 * 
 * This script checks DOM elements for category display visibility issues
 * and applies CSS fixes to force visibility.
 */

// Self-executing function to scope variables
(function() {
  console.log('%c🔍 Category Visibility Fix Tool v2', 'font-size: 16px; font-weight: bold; color: #3498db; background-color: #eef9ff; padding: 5px; border-radius: 4px;');
  
  // Create a style element to inject our CSS fixes
  function injectCSSFixes() {
    const styleId = 'category-visibility-fix-styles';
    
    // Don't add if already exists
    if (document.getElementById(styleId)) {
      console.log('✅ CSS fixes already applied');
      return;
    }
    
    // Create style element with targeted CSS that works with the existing category system
    const styleEl = document.createElement('style');
    styleEl.id = styleId;
    styleEl.innerHTML = `
      /* Target the search result container first to ensure we select within results */
      .search-result-wrapper,
      .search-results-container,
      .search-results,
      .intelligent-search-results,
      [data-testid="search-results"] {
        position: relative !important;
      }
      
      /* Strong direct selectors for category elements */
      .modern-category-display,
      #category-ribbon-main-container,
      .category-ribbon-container,
      .category-ribbon,
      .category-ribbon-content,
      .category-cards-container,
      .category-card,
      [data-testid*="category"],
      [data-category-id],
      [data-category-name],
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
        position: relative !important;
        z-index: 900 !important;
        min-height: 30px !important;
        height: auto !important;
        overflow: visible !important;
        pointer-events: auto !important;
      }
      
      /* Target flexbox containers */
      [class*="category-container"],
      [class*="ribbon-container"],
      [class*="category"] [class*="container"],
      [class*="container"][class*="category"],
      [class*="cards-container"] {
        display: flex !important;
        flex-wrap: wrap !important;
        gap: 8px !important;
        visibility: visible !important;
        opacity: 1 !important;
        min-height: 40px !important;
      }
      
      /* Style individual category cards/items */
      [class*="category-card"],
      [class*="category-item"],
      [class*="category-tab"],
      [data-category-id] {
        display: inline-block !important;
        visibility: visible !important;
        opacity: 1 !important;
        padding: 8px 12px !important;
        border: 1px solid #e5e7eb !important;
        border-radius: 4px !important;
        background-color: white !important;
        margin: 4px !important;
        min-width: 120px !important;
        cursor: pointer !important;
        box-shadow: 0 1px 3px rgba(0,0,0,0.1) !important;
      }
    `;
    
    // Add to document
    document.head.appendChild(styleEl);
    console.log('✅ Applied CSS fixes for category visibility');
  }
  
  // Function to detect and fix category elements
  function fixCategoryElements() {
    console.log('🔧 Searching for categories in the DOM...');
    
    // Broad selectors that might match category containers
    const selectors = [
      '[class*="category"]',
      '[id*="category"]',
      '[data-testid*="category"]',
      '[class*="ribbon"]',
      '[id*="ribbon"]',
      '[data-category-id]',
      '[data-category-name]',
      '.modern-category-display',
      '[id*="llm-category"]'
    ];
    
    // Track what we find
    let elementsFound = {};
    let totalFound = 0;
    
    // Try each selector
    selectors.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      elementsFound[selector] = elements.length;
      totalFound += elements.length;
      
      if (elements.length > 0) {
        console.log(`📌 Found ${elements.length} elements matching: ${selector}`);
        
        // Force visibility on each matching element
        elements.forEach(el => {
          el.style.display = 'block';
          el.style.visibility = 'visible';
          el.style.opacity = '1';
          el.setAttribute('data-forced-visible', 'true');
        });
      }
    });
    
    // Log summary
    console.log(`📊 Found ${totalFound} total category-related elements`);
    
    // If we found category elements, enhance them
    if (totalFound > 0) {
      // Inject CSS to ensure visibility
      injectCSSFixes();
    } else {
      console.log('❌ No category elements found in the DOM');
      console.log('👉 Try running a search query to generate categories');
    }
    
    return {
      totalFound,
      elementsFound
    };
  }
  
  // Wait for DOM to be fully loaded
  function init() {
    console.log('🔄 Category Visibility Fix initializing...');
    
    // First pass - inject CSS fixes immediately
    injectCSSFixes();
    
    // Schedule fixes to run after a slight delay
    setTimeout(() => {
      const results = fixCategoryElements();
      
      // Schedule additional check after DOM changes likely happened
      setTimeout(() => {
        // Ensure CSS is still applied
        injectCSSFixes();
        
        // Log available categories in data model but don't inject emergency ones
        if (results.totalFound === 0) {
          console.log('⚠️ Categories are in the data model but not showing in the DOM');
          console.log('🔍 Checking data model for categories...');
          
          // Check data model for categories
          const categories = 
            window.__globalCategoryStorage?.categories || 
            window.__intelligentSearchCategories ||
            window.__allCategories || [];
            
          if (categories.length > 0) {
            console.log(`✅ Found ${categories.length} categories in data model:`, 
              categories.map(c => c.name || 'Unnamed').join(', '));
            console.log('🔧 Adding stronger CSS selectors to make them visible');
            
            // Add targeted CSS specifically for search results and category display
            const extraStyles = document.createElement('style');
            extraStyles.id = 'category-visibility-direct-fixes';
            extraStyles.textContent = `
              /* Target the direct category components with exact class names */
              .intelligent-search-results .category-ribbon-container,
              .intelligent-search-results .modern-category-display,
              .search-results-container .category-ribbon-container,
              .search-results-container .modern-category-display {
                display: block !important;
                visibility: visible !important;
                opacity: 1 !important;
                border: 2px solid #6366f1 !important;
                background-color: #f5f3ff !important;
                padding: 8px !important;
                margin: 15px 0 !important;
                border-radius: 8px !important;
              }
            `;
            document.head.appendChild(extraStyles);
          } else {
            console.log('⚠️ No categories found in data model either');
            console.log('🔍 Run a search query to generate categories');
          }
        }
      }, 3000);
    }, 1000);
  }
  
  // Expose the fix function globally
  window.forceCategoryDisplay = function() {
    console.log('🔧 Manually forcing category display...');
    injectCSSFixes();
    return fixCategoryElements();
  };
  
  // Auto-run when loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
