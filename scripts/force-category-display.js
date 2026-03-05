/**
 * Force Category Display Utility
 * 
 * This is a standalone utility that can be run directly from the browser console
 * to force category elements to display, regardless of their current visibility state.
 * 
 * Usage:
 * 1. In the browser console, run: window.forceDisplayCategories()
 */

(function() {
  // Main function to force category elements to display
  function forceDisplayCategories() {
    console.log('%c🔧 Force Category Display Utility v3.0', 'font-size: 16px; font-weight: bold; color: #3498db; background-color: #eef9ff; padding: 5px; border-radius: 4px;');
    
    // Add targeted CSS to ensure categories are visible
    injectForcedVisibilityCSS();
    
    // Find and force-display all category elements
    findAndFixCategoryElements();
    
    // Return a helpful message
    return {
      message: 'Category visibility fixes applied',
      timestamp: new Date().toISOString(),
      runId: Date.now()
    };
  }
  
  // Inject CSS to force category visibility
  function injectForcedVisibilityCSS() {
    // Check if styles already exist
    if (document.getElementById('force-category-display-styles')) {
      console.log('✅ Force display styles already applied');
      return;
    }
        // Create style element
    const styleEl = document.createElement('style');
    styleEl.id = 'force-category-display-styles';
    styleEl.innerHTML = `
      /* Target the main search results container */
      .search-results-container,
      .intelligent-search-results,
      .search-result-wrapper {
        position: relative !important;
        z-index: 10 !important;
      }
      
      /* Force display of the modern category container - minimal intervention */
      .modern-category-display,
      #modern-category-display-container,
      [id*="category-container"],
      [data-testid*="category"] {
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
        position: relative !important;
        z-index: 999 !important;
        pointer-events: auto !important;
      }
      
      /* Force display of ribbon containers */
      .category-ribbon,
      .category-ribbon-container,
      .category-ribbon-content,
      [class*="ribbon"] {
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
        position: relative !important;
        z-index: 900 !important;
      }
      
      /* Force display of category cards container */
      .category-cards-container,
      .ribbon-category-container {
        display: flex !important;
        visibility: visible !important;
        opacity: 1 !important;
      }
      
      /* Force display of individual category cards */
      .category-card,
      .ribbon-category-card,
      [data-category-id],
      [data-category-name] {
        display: inline-block !important;
        visibility: visible !important;
        opacity: 1 !important;
        pointer-events: auto !important;
      }
    `;
    
    document.head.appendChild(styleEl);
    console.log('✅ Injected CSS to force category display');
  }
  
  // Find and fix all category elements
  function findAndFixCategoryElements() {
    console.log('🔍 Searching for category elements...');
    
    // Target selectors that might contain categories
    const selectors = [
      '.modern-category-display',
      '#modern-category-display-container',
      '.category-ribbon-container',
      '.category-ribbon',
      '.category-ribbon-content',
      '.category-cards-container',
      '.ribbon-category-container',
      '.category-card',
      '.ribbon-category-card',
      '[data-testid*="category"]',
      '[data-category-id]',
      '[data-category-name]',
      '[data-categories-count]',
      '#llm-category-container'
    ];
    
    // Track results
    let totalFound = 0;
    let elementsFound = {};
    
    // Check each selector
    selectors.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      elementsFound[selector] = elements.length;
      totalFound += elements.length;
      
      if (elements.length > 0) {
        console.log(`✅ Found ${elements.length} elements matching: ${selector}`);
        
        // Force display on each element
        elements.forEach(el => {
          // Apply essential styles directly
          el.style.display = 'block';
          el.style.visibility = 'visible';
          el.style.opacity = '1';
          el.style.position = 'relative';
          el.style.zIndex = '999';
          
          // Mark as fixed
          el.setAttribute('data-visibility-fixed', 'true');
          el.setAttribute('data-fixed-timestamp', Date.now());
        });
      }
    });
    
    // Log results
    if (totalFound > 0) {
      console.log(`✅ Applied visibility fixes to ${totalFound} elements`);
    } else {
      console.log('❌ No category elements found in the DOM');
      console.log('👉 Run a search query to generate categories');
      
      // Check if we have categories in data
      if (typeof window.__intelligentSearchCategories !== 'undefined' || 
          typeof window.__globalCategoryStorage !== 'undefined') {
          
        console.log('🔍 Found categories in data model, but not in DOM');
        console.log('👉 Check React component rendering');
      }
    }
    
    return {
      totalFound,
      elementsFound
    };
  }
  
  // Expose functions to window
  window.forceDisplayCategories = forceDisplayCategories;
  window.forceCategoryDisplay = forceDisplayCategories; // Alias for convenience
  
  // Add mutation observer to detect when search results appear
  function setupSearchResultsObserver() {
    console.log('🔍 Setting up observer for search results...');
    
    // Create a mutation observer to watch for search results being added to the DOM
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        // Check if new nodes were added
        if (mutation.addedNodes.length) {
          // Look for search results containers
          const hasSearchResults = document.querySelector('.search-results-container') || 
                                  document.querySelector('.intelligent-search-results');
                                  
          // Look for signs of a completed search
          const hasCategories = document.querySelector('[data-categories-count]') ||
                               document.querySelector('[data-category-id]');
                                  
          if (hasSearchResults && hasCategories) {
            console.log('📊 Search results with categories detected, applying fixes...');
            forceDisplayCategories();
            
            // Don't disconnect observer - continue watching for new search results
            return;
          }
        }
      }
    });
    
    // Start observing the document with the configured parameters
    observer.observe(document.body, { childList: true, subtree: true });
    
    return observer;
  }
  
  // Initialize after the DOM is loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      console.log('🚀 Force Category Display utility loaded - waiting for search query');
      console.log('👉 Run window.forceDisplayCategories() to manually fix category visibility');
      setupSearchResultsObserver();
    });
  } else {
    console.log('🚀 Force Category Display utility loaded - waiting for search query');
    console.log('👉 Run window.forceDisplayCategories() to manually fix category visibility');
    setupSearchResultsObserver();
  }
})();
