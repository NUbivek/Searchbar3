/**
 * Direct Category Injector
 * 
 * This script bypasses React to directly inject category elements into the DOM
 * when the standard React rendering pipeline fails.
 */

(function() {
  console.log('%c🔧 Direct Category Injector v1.0', 
    'font-size: 16px; font-weight: bold; color: #e63946; background-color: #f1faee; padding: 5px; border-radius: 4px;'
  );

  // Main injection function
  function injectCategoriesDirect() {
    console.log('🔄 Starting direct category injection...');
    
    // Find or create search results container
    const searchResultsContainer = 
      document.querySelector('.search-results-container') || 
      document.querySelector('.intelligent-search-results');
    
    if (!searchResultsContainer) {
      console.error('❌ No search results container found. Run a search first.');
      return false;
    }
    
    // Get categories from any available source
    const categories = getCategoriesFromAnySource();
    
    if (!categories || categories.length === 0) {
      console.error('❌ No categories found in data sources.');
      return false;
    }
    
    console.log(`✅ Found ${categories.length} categories to inject:`, 
      categories.map(c => c.name).join(', ')
    );
    
    // Create category container if it doesn't exist
    let categoryContainer = document.getElementById('direct-injected-categories');
    
    if (!categoryContainer) {
      categoryContainer = document.createElement('div');
      categoryContainer.id = 'direct-injected-categories';
      categoryContainer.className = 'category-ribbon-container';
      categoryContainer.setAttribute('data-source', 'direct-injector');
      categoryContainer.setAttribute('data-categories-count', categories.length);
      
      // Insert at the top of search results
      if (searchResultsContainer.firstChild) {
        searchResultsContainer.insertBefore(categoryContainer, searchResultsContainer.firstChild);
      } else {
        searchResultsContainer.appendChild(categoryContainer);
      }
    }
    
    // Clear existing content
    categoryContainer.innerHTML = '';
    
    // Add title
    const titleElement = document.createElement('h3');
    titleElement.style.fontSize = '1rem';
    titleElement.style.fontWeight = '500';
    titleElement.style.color = '#4b5563';
    titleElement.style.margin = '10px 0';
    titleElement.textContent = 'Search Categories';
    categoryContainer.appendChild(titleElement);
    
    // Create cards container
    const cardsContainer = document.createElement('div');
    cardsContainer.className = 'category-cards-container';
    cardsContainer.style.display = 'flex';
    cardsContainer.style.flexWrap = 'wrap';
    cardsContainer.style.gap = '8px';
    cardsContainer.style.marginBottom = '10px';
    categoryContainer.appendChild(cardsContainer);
    
    // Create category cards
    categories.forEach((category, index) => {
      const card = document.createElement('div');
      card.className = 'category-card';
      card.setAttribute('data-category-id', category.id || `cat-${index}`);
      card.setAttribute('data-category-name', category.name);
      
      // Generate color from name
      const nameHash = category.name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      const hue = nameHash % 360;
      const borderColor = category.color || `hsl(${hue}, 70%, 45%)`;
      
      // Set styles
      Object.assign(card.style, {
        borderLeft: `4px solid ${borderColor}`,
        backgroundColor: 'white',
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
        padding: '8px 12px',
        borderRadius: '4px',
        cursor: 'pointer',
        minWidth: '160px',
        border: '1px solid #e5e7eb',
        borderLeftWidth: '4px',
        transition: 'all 0.2s ease',
        margin: '4px',
        display: 'inline-block'
      });
      
      // Add name
      const nameEl = document.createElement('div');
      nameEl.style.fontWeight = '500';
      nameEl.style.color = '#111827';
      nameEl.style.marginBottom = '4px';
      nameEl.style.fontSize = '0.9rem';
      nameEl.textContent = category.name;
      card.appendChild(nameEl);
      
      // Add metrics if available
      if (category.metrics) {
        const metricsEl = document.createElement('div');
        metricsEl.style.display = 'flex';
        metricsEl.style.fontSize = '0.75rem';
        metricsEl.style.color = '#6b7280';
        metricsEl.style.gap = '6px';
        
        // Calculate metrics for display
        const relevance = Math.round((category.metrics.relevance || 0.5) * 100);
        const accuracy = Math.round((category.metrics.accuracy || 0.5) * 100);
        const credibility = Math.round((category.metrics.credibility || 0.5) * 100);
        
        metricsEl.innerHTML = `
          <div>R: <span style="color: #2563eb">${relevance}%</span></div>
          <div>A: <span style="color: #059669">${accuracy}%</span></div>
          <div>C: <span style="color: #d97706">${credibility}%</span></div>
        `;
        
        card.appendChild(metricsEl);
      }
      
      // Add click handler to highlight and show results
      card.addEventListener('click', () => {
        // Remove active class from all cards
        document.querySelectorAll('.category-card').forEach(c => {
          c.style.backgroundColor = 'white';
          c.style.boxShadow = '0 1px 3px rgba(0,0,0,0.05)';
          c.style.fontWeight = '500';
        });
        
        // Add active styling to this card
        card.style.backgroundColor = '#f9fafb';
        card.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
        nameEl.style.fontWeight = '600';
        
        console.log(`Category selected: ${category.name}`);
      });
      
      // Add to container
      cardsContainer.appendChild(card);
    });
    
    console.log('✅ Successfully injected categories into DOM');
    return true;
  }
  
  // Get categories from any available source
  function getCategoriesFromAnySource() {
    // Check all possible sources
    const sources = [
      window.__intelligentSearchCategories,
      window.__globalCategoryStorage?.categories,
      window.__allCategories,
      window.__lastCategoriesReceived
    ];
    
    // Return first valid source
    for (const source of sources) {
      if (source && Array.isArray(source) && source.length > 0) {
        return source;
      }
    }
    
    // If no categories found, create defaults
    return createDefaultCategories();
  }
  
  // Create default categories if none exist
  function createDefaultCategories() {
    return [
      {
        id: 'key_insights',
        name: 'Key Insights',
        color: '#0F9D58',
        metrics: { relevance: 0.8, accuracy: 0.7, credibility: 0.7 }
      },
      {
        id: 'all_results',
        name: 'All Results',
        color: '#4285F4',
        metrics: { relevance: 0.7, accuracy: 0.7, credibility: 0.7 }
      },
      {
        id: 'answers',
        name: 'Answers',
        color: '#DB4437',
        metrics: { relevance: 0.6, accuracy: 0.8, credibility: 0.6 }
      }
    ];
  }
  
  // Set up observer to watch for search results
  function setupSearchObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes.length) {
          const hasSearchResults = 
            document.querySelector('.search-results-container') || 
            document.querySelector('.intelligent-search-results');
            
          if (hasSearchResults) {
            // Wait a moment for any React updates to complete
            setTimeout(() => {
              // Check if categories exist
              const hasExistingCategories = 
                document.querySelector('.category-ribbon-container') ||
                document.querySelector('.category-cards-container');
                
              if (!hasExistingCategories) {
                console.log('🔍 Search results detected without categories, injecting...');
                injectCategoriesDirect();
              }
            }, 500);
          }
        }
      }
    });
    
    observer.observe(document.body, { childList: true, subtree: true });
    return observer;
  }
  
  // Expose to window
  window.directCategoryInjector = {
    inject: injectCategoriesDirect,
    getCategories: getCategoriesFromAnySource
  };
  
  // Auto initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupSearchObserver);
  } else {
    setupSearchObserver();
  }
  
  console.log('🔧 Direct Category Injector ready');
  console.log('👉 Run window.directCategoryInjector.inject() to manually trigger injection');
})();
