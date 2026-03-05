/**
 * Direct Category Injection Script
 * 
 * This script injects categories directly into the DOM,
 * bypassing React and CSS module dependencies completely.
 * 
 * Usage: 
 * - Load this script in the browser console directly
 * - Call window.forceInjectionTabs() to manually inject tabs
 */
(function() {
  console.log('🚀 Force Categories script loaded');
  
  // Store in global scope
  window.__forceCategoriesScript = true;
  
  /**
   * Get categories from any possible source
   */
  function getAllCategories() {
    // Try to find categories from any available source
    const possibleSources = [
      window.__lastViewedCategories,
      window.__lastCategoriesReceived,
      window.__intelligentSearchCategories,
      window.__allCategories,
      window.__globalCategoryStorage?.categories,
      window.__processedCategories,
      window.__apiDirectCategories
    ];
    
    for (const source of possibleSources) {
      if (Array.isArray(source) && source.length > 0) {
        console.log(`Found ${source.length} categories from source`);
        return source;
      }
    }
    
    // Fallback default categories if nothing else is available
    return [
      { id: 'key_insights', name: 'Key Insights', content: [] },
      { id: 'all_results', name: 'All Results', content: [] }
    ];
  }
  
  /**
   * Force category tabs to appear
   */
  window.forceInjectionTabs = function() {
    const categories = getAllCategories();
    console.log(`Injecting ${categories.length} categories as tabs`);
    
    // Create container if it doesn't exist
    let container = document.getElementById('force-category-tabs');
    if (!container) {
      container = document.createElement('div');
      container.id = 'force-category-tabs';
      container.style.cssText = 'position:relative; width:100%; max-width:800px; margin:20px auto; padding:10px; background:#fff; border-radius:8px; box-shadow:0 2px 8px rgba(0,0,0,0.1); z-index:9999;';
    } else {
      // Clear existing content
      container.innerHTML = '';
    }
    
    // Add title
    const title = document.createElement('h3');
    title.textContent = 'This page tests the sleek, modern category ribbon display';
    title.style.cssText = 'text-align:center; font-size:16px; color:#111827; margin-bottom:15px; font-weight:500;';
    container.appendChild(title);
    
    // Add subtitle
    const subtitle = document.createElement('div');
    subtitle.textContent = 'Sample Category Ribbon';
    subtitle.style.cssText = 'font-size:14px; color:#4b5563; margin-bottom:10px;';
    container.appendChild(subtitle);
    
    // Create tabs container
    const tabsContainer = document.createElement('div');
    tabsContainer.style.cssText = 'display:flex; flex-wrap:wrap; gap:8px; margin-bottom:20px;';
    
    // Colors for category cards
    const colors = ['#10b981', '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e'];
    
    // Create each category tab
    categories.forEach((category, index) => {
      const tabCard = document.createElement('div');
      const borderColor = category.color || colors[index % colors.length];
      
      tabCard.style.cssText = `border-left:4px solid ${borderColor}; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,0.1); padding:8px 12px; border-radius:4px; cursor:pointer; min-width:160px; border:1px solid #e5e7eb; border-left-width:4px;`;
      
      // Category name
      const name = document.createElement('div');
      name.textContent = category.name;
      name.style.cssText = 'font-weight:500; color:#111827; margin-bottom:4px; font-size:14px;';
      tabCard.appendChild(name);
      
      // Metrics row (example values)
      const metricsRow = document.createElement('div');
      metricsRow.style.cssText = 'display:flex; font-size:12px; color:#6b7280; gap:6px;';
      
      // R score
      const rScore = document.createElement('div');
      rScore.innerHTML = `R: <span style="color:#2563eb">${Math.floor(Math.random() * 15 + 80)}%</span>`;
      metricsRow.appendChild(rScore);
      
      // C score  
      const cScore = document.createElement('div');
      cScore.innerHTML = `C: <span style="color:#059669">${Math.floor(Math.random() * 15 + 80)}%</span>`;
      metricsRow.appendChild(cScore);
      
      // A score
      const aScore = document.createElement('div');
      aScore.innerHTML = `A: <span style="color:#d97706">${Math.floor(Math.random() * 15 + 80)}%</span>`;
      metricsRow.appendChild(aScore);
      
      tabCard.appendChild(metricsRow);
      
      // Make active on click
      tabCard.addEventListener('click', function() {
        // Reset all tabs
        document.querySelectorAll('#force-category-tabs .tab-card').forEach(el => {
          el.style.background = '#fff';
          el.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
          el.style.fontWeight = '500';
        });
        
        // Highlight this tab
        this.style.background = '#f9fafb';
        this.style.boxShadow = '0 2px 4px rgba(0,0,0,0.15)';
        this.querySelector('div').style.fontWeight = '600';
      });
      
      tabCard.classList.add('tab-card');
      tabsContainer.appendChild(tabCard);
    });
    
    container.appendChild(tabsContainer);
    
    // Add sample content panel
    const contentPanel = document.createElement('div');
    contentPanel.style.cssText = 'border:1px solid #e5e7eb; border-radius:8px; padding:16px; background:white;';
    
    const contentTitle = document.createElement('h3');
    contentTitle.textContent = categories[0]?.name || 'Sample Category';
    contentTitle.style.cssText = 'border-left:4px solid #3b82f6; padding-left:8px; font-size:16px; font-weight:600; color:#111827; margin-bottom:16px;';
    contentPanel.appendChild(contentTitle);
    
    // Example content text
    const contentText = document.createElement('div');
    contentText.style.cssText = 'font-size:14px; color:#374151;';
    contentText.innerHTML = `
      <p style="margin-bottom:16px;">The global investment landscape is projected to grow by 15% in 2025, with emerging markets leading the charge at 22% growth rate.</p>
      <p style="color:#6b7280; font-size:12px;">Sources: Goldman Sachs 2025 Market Outlook, Morgan Stanley Investment Report</p>
    `;
    contentPanel.appendChild(contentText);
    
    container.appendChild(contentPanel);
    
    // Add to document
    const targetContainer = document.querySelector('.search-results-container') || 
                           document.querySelector('.main-content') ||
                           document.querySelector('main') ||
                           document.body;
                           
    if (targetContainer) {
      // Try to insert at specific position
      const searchBox = document.querySelector('.search-box') || 
                        document.querySelector('input[type="search"]');
                        
      if (searchBox) {
        // Insert after search box
        searchBox.parentNode.insertBefore(container, searchBox.nextSibling);
      } else {
        // Insert at beginning
        targetContainer.prepend(container);
      }
      
      console.log('✅ Successfully injected force category tabs');
    } else {
      // Fallback to body
      document.body.prepend(container);
      console.log('⚠️ Injected force category tabs to body as fallback');
    }
    
    return container;
  };
  
  // Wait for page to load then auto-inject
  if (document.readyState === 'complete') {
    setTimeout(window.forceInjectionTabs, 1000);
  } else {
    window.addEventListener('load', function() {
      setTimeout(window.forceInjectionTabs, 1000);
    });
  }
  
  // Display instructions in console
  console.log('%c💡 Force categories available!', 'background:#2563eb; color:white; padding:4px 8px; border-radius:4px;');
  console.log('%c• Type window.forceInjectionTabs() in the console to manually inject tabs', 'color:#2563eb;');
})();
