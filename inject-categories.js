/**
 * Emergency Category Injection System
 * This script runs immediately when loaded and bypasses all React rendering and CSS modules
 * to ensure categories display even if the React component tree has issues
 */
(function() {
  console.log('🚨 Emergency category injection script loaded');
  
  // Create a self-refreshing system
  function setupCategoryMonitor() {
    // Create a backup display container
    let container = document.getElementById('emergency-category-display');
    if (!container) {
      container = document.createElement('div');
      container.id = 'emergency-category-display';
      
      // Style the container with inline styles only
      Object.assign(container.style, {
        position: 'fixed',
        top: '10px',
        right: '10px',
        zIndex: '100000',
        backgroundColor: '#ffffff',
        border: '3px solid #ef4444',
        borderRadius: '8px',
        padding: '15px',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
        width: '300px',
        maxHeight: '80vh',
        overflowY: 'auto',
        fontSize: '14px',
        visibility: 'visible',
        display: 'none' // Hidden by default
      });
      
      document.body.appendChild(container);
    }
    
    // Function to inject categories
    window.injectEmergencyCategories = function(forceShow = false) {
      // Find categories from all possible sources
      const categorySources = [
        window.__apiDirectCategories,
        window.__lastAPICategories,
        window.__allCategories,
        window.__lastCategoriesReceived,
        window.__processedCategories,
        window.__intelligentSearchCategories,
        window.__globalCategoryStorage
      ];
      
      // Get the first valid categories array
      const categories = categorySources.find(source => Array.isArray(source) && source.length > 0) || [];
      
      if (categories.length === 0) {
        console.warn('No categories found for emergency injection');
        container.innerHTML = `
          <h3 style="margin: 0 0 10px 0; font-size: 16px; font-weight: bold; color: #ef4444; text-align: center; border-bottom: 2px solid #ef4444; padding-bottom: 5px;">
            🚨 EMERGENCY CATEGORIES
          </h3>
          <p style="margin: 10px 0; color: #ef4444; font-weight: bold;">No categories found!</p>
          <button onclick="this.parentNode.style.display='none'" style="margin-top: 10px; padding: 6px 12px; background-color: #6b7280; color: white; border: none; border-radius: 4px; cursor: pointer; width: 100%;">
            Close
          </button>
        `;
        return;
      }
      
      // Show the container if forced
      if (forceShow) {
        container.style.display = 'block';
      }
      
      // Clear existing content
      container.innerHTML = '';
      
      // Add header
      const header = document.createElement('h3');
      header.textContent = '🚨 EMERGENCY CATEGORIES';
      Object.assign(header.style, {
        margin: '0 0 10px 0',
        fontSize: '16px',
        fontWeight: 'bold',
        color: '#ef4444',
        textAlign: 'center',
        borderBottom: '2px solid #ef4444',
        paddingBottom: '5px'
      });
      container.appendChild(header);
      
      // Add source info
      const sourceInfo = document.createElement('div');
      sourceInfo.textContent = `Found ${categories.length} categories`;
      Object.assign(sourceInfo.style, {
        fontSize: '12px',
        marginBottom: '10px',
        padding: '4px 8px',
        backgroundColor: '#f3f4f6',
        borderRadius: '4px',
        color: '#4b5563'
      });
      container.appendChild(sourceInfo);
      
      // Create tabs container
      const tabsContainer = document.createElement('div');
      Object.assign(tabsContainer.style, {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '6px',
        marginBottom: '15px'
      });
      
      // Add category tabs
      categories.forEach(category => {
        const tab = document.createElement('div');
        tab.textContent = category.name;
        tab.setAttribute('data-category-id', category.id || '');
        tab.setAttribute('data-category-name', category.name || '');
        
        Object.assign(tab.style, {
          padding: '8px 12px',
          backgroundColor: '#f3f4f6',
          borderRadius: '4px',
          cursor: 'pointer',
          fontSize: '13px',
          fontWeight: '500',
          border: '1px solid #d1d5db',
          color: '#1f2937'
        });
        
        tab.onmouseover = () => {
          tab.style.backgroundColor = '#e5e7eb';
          tab.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
        };
        
        tab.onmouseout = () => {
          tab.style.backgroundColor = '#f3f4f6';
          tab.style.boxShadow = 'none';
        };
        
        tabsContainer.appendChild(tab);
      });
      
      container.appendChild(tabsContainer);
      
      // Add toggle button
      const toggleButton = document.createElement('button');
      toggleButton.textContent = 'Toggle Display';
      Object.assign(toggleButton.style, {
        padding: '8px 12px',
        backgroundColor: '#3b82f6',
        color: 'white',
        border: 'none',
        borderRadius: '4px',
        cursor: 'pointer',
        fontWeight: 'bold',
        marginBottom: '10px',
        width: '100%'
      });
      
      toggleButton.onclick = function() {
        // Find all category elements on the page
        const categoryElements = document.querySelectorAll('[data-category-name]');
        console.log(`Found ${categoryElements.length} category elements`);
        
        if (categoryElements.length > 0) {
          // Toggle visibility of these elements
          categoryElements.forEach(el => {
            if (el.style.display === 'none') {
              el.style.display = 'block';
              el.style.visibility = 'visible';
            }
          });
          
          // Log success
          console.log('✅ Toggled visibility on existing category elements');
        } else {
          console.log('⚠️ No category elements found to toggle');
          
          // If no elements found, attempt to force new injection
          const categoryContainer = document.getElementById('category-ribbon-main-container');
          if (categoryContainer) {
            // Try to force new rendering
            categoryContainer.style.display = 'block';
            categoryContainer.style.visibility = 'visible';
            console.log('✅ Forced category container visibility');
          }
        }
      };
      
      container.appendChild(toggleButton);
      
      // Add close button
      const closeButton = document.createElement('button');
      closeButton.textContent = 'Close';
      Object.assign(closeButton.style, {
        padding: '6px 12px',
        backgroundColor: '#6b7280',
        color: 'white',
        border: 'none',
        borderRadius: '4px',
        cursor: 'pointer',
        width: '100%'
      });
      
      closeButton.onclick = function() {
        container.style.display = 'none';
      };
      
      container.appendChild(closeButton);
      
      console.log('✅ Emergency categories injected successfully', categories.length);
    };
    
    // Set up auto-refresh monitor
    setInterval(() => {
      // Check if categories exist in any source
      const categorySources = [
        window.__apiDirectCategories,
        window.__lastAPICategories,
        window.__allCategories,
        window.__lastCategoriesReceived,
        window.__processedCategories,
        window.__intelligentSearchCategories,
        window.__globalCategoryStorage
      ];
      
      // Find the first valid source
      const categories = categorySources.find(source => Array.isArray(source) && source.length > 0);
      
      // If categories exist but no category elements, show emergency display
      if (categories && categories.length > 0) {
        const categoryElements = document.querySelectorAll('[data-category-name]');
        if (categoryElements.length === 0) {
          console.log('🚨 No category elements found despite having categories! Showing emergency display');
          container.style.display = 'block';
          window.injectEmergencyCategories(true);
        }
      }
    }, 5000); // Check every 5 seconds
  }
  
  // Function to guarantee setup
  function guaranteeSetup() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setupCategoryMonitor();
    } else {
      window.addEventListener('DOMContentLoaded', setupCategoryMonitor);
    }
    
    // Also set up on load just to be extra certain
    window.addEventListener('load', setupCategoryMonitor);
  }
  
  // Run setup
  guaranteeSetup();
  
  // Add global accessor
  window.emergencyCategorySystem = {
    inject: function() {
      window.injectEmergencyCategories(true);
    },
    check: function() {
      const categorySources = [
        window.__apiDirectCategories,
        window.__lastAPICategories,
        window.__allCategories,
        window.__lastCategoriesReceived,
        window.__processedCategories, 
        window.__intelligentSearchCategories,
        window.__globalCategoryStorage
      ];
      
      console.table(
        categorySources.map((source, index) => ({
          source: ['API Direct', 'Last API', 'All Categories', 'Last Received', 'Processed', 'Intelligent Search', 'Global Storage'][index],
          count: Array.isArray(source) ? source.length : 'Not an array',
          isValid: Array.isArray(source) && source.length > 0 ? 'Yes' : 'No',
          names: Array.isArray(source) ? source.map(c => c.name).join(', ') : 'N/A'
        }))
      );
      
      return categorySources.find(source => Array.isArray(source) && source.length > 0) || [];
    }
  };
  
  console.log('✅ Emergency category system initialized');
  console.log('%c💡 Use window.emergencyCategorySystem.inject() to force category display', 'background: #3b82f6; color: white; padding: 4px 8px; border-radius: 4px;');
})();
