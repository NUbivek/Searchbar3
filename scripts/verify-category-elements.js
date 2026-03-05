/**
 * Category Element Verification Tool
 * 
 * This standalone tool helps verify if categories are properly displayed in the DOM
 * It performs a deep check of all DOM elements related to categories
 */

(function() {
  // Create styled logger for easy identification
  function logInfo(message, data) {
    console.log(`%c🔍 CATEGORY VERIFY: ${message}`, 
      'color: #3b82f6; font-weight: bold;', 
      data || '');
  }
  
  function logSuccess(message, data) {
    console.log(`%c✅ VERIFIED: ${message}`, 
      'color: #10b981; font-weight: bold;', 
      data || '');
  }
  
  function logError(message, data) {
    console.log(`%c❌ MISSING: ${message}`, 
      'color: #ef4444; font-weight: bold;', 
      data || '');
  }
  
  // Main verification function
  function verifyCategoryElements() {
    logInfo('Starting category element verification');
    
    // Step 1: Check for container elements
    const containers = [
      { selector: '#modern-category-display-container', name: 'Modern Category Container' },
      { selector: '#category-ribbon-main-container', name: 'Category Ribbon Main Container' },
      { selector: '.category-ribbon-container', name: 'Category Ribbon Container' },
      { selector: '.category-ribbon-content', name: 'Category Ribbon Content' },
      { selector: '.category-ribbon', name: 'Category Ribbon' },
      { selector: '.category-cards-container', name: 'Category Cards Container' },
      { selector: '.ribbon-category-container', name: 'Ribbon Category Container' },
      { selector: '#direct-injected-categories', name: 'Direct Injected Categories' },
      { selector: '[data-source="direct-injector"]', name: 'Direct Injector Element' }
    ];
    
    let containerResults = {};
    let totalContainers = 0;
    
    containers.forEach(container => {
      const elements = document.querySelectorAll(container.selector);
      const count = elements.length;
      containerResults[container.name] = count;
      totalContainers += count;
      
      if (count > 0) {
        logSuccess(`Found ${count} ${container.name}(s)`, 
          Array.from(elements).map(el => ({
            id: el.id || 'no-id', 
            classList: Array.from(el.classList),
            childCount: el.children.length
          }))
        );
      } else {
        logError(`No ${container.name} found in DOM`);
      }
    });
    
    // Step 2: Check for category cards
    const cards = [
      { selector: '.category-card', name: 'Category Card' },
      { selector: '.ribbon-category-card', name: 'Ribbon Category Card' },
      { selector: '[data-category-id]', name: 'Elements with category ID' },
      { selector: '[data-category-name]', name: 'Elements with category name' }
    ];
    
    let cardResults = {};
    let totalCards = 0;
    
    cards.forEach(card => {
      const elements = document.querySelectorAll(card.selector);
      const count = elements.length;
      cardResults[card.name] = count;
      totalCards += count;
      
      if (count > 0) {
        logSuccess(`Found ${count} ${card.name}(s)`,
          Array.from(elements).map(el => ({
            categoryId: el.dataset.categoryId,
            categoryName: el.dataset.categoryName || el.innerText,
            classes: Array.from(el.classList)
          }))
        );
      } else {
        logError(`No ${card.name}s found in DOM`);
      }
    });
    
    // Step 3: Check for data attributes
    const dataAttributes = [
      { selector: '[data-categories-count]', name: 'Elements with categories count' },
      { selector: '[data-testid*="category"]', name: 'Elements with category test ID' },
      { selector: '[data-in-llm-results]', name: 'Elements with LLM results flag' }
    ];
    
    let attributeResults = {};
    
    dataAttributes.forEach(attr => {
      const elements = document.querySelectorAll(attr.selector);
      const count = elements.length;
      attributeResults[attr.name] = count;
      
      if (count > 0) {
        logSuccess(`Found ${count} ${attr.name}`, Array.from(elements).map(el => el.dataset));
      } else {
        logError(`No ${attr.name} found in DOM`);
      }
    });
    
    // Step 4: Check for content
    const categoriesWithContent = document.querySelectorAll('.category-card, .ribbon-category-card, [data-category-id]');
    const hasVisibleContent = Array.from(categoriesWithContent).some(el => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    });
    
    if (hasVisibleContent) {
      logSuccess('Categories have visible content');
    } else if (categoriesWithContent.length > 0) {
      logError('Categories exist but are not visible - check CSS visibility');
    } else {
      logError('No category content found to check visibility');
    }
    
    // Summary
    const summary = {
      timestamp: new Date().toISOString(),
      totalContainers,
      totalCards,
      containerResults,
      cardResults,
      attributeResults,
      hasCategoryStructure: totalContainers > 0,
      hasCategoryCards: totalCards > 0,
      hasVisibleContent
    };
    
    logInfo('Category verification complete', summary);
    return summary;
  }
  
  // Function to fix any broken category elements
  function fixCategoryElements() {
    logInfo('Attempting to fix category elements');
    
    // Try direct injector first if available
    if (window.directCategoryInjector && window.directCategoryInjector.inject) {
      logInfo('Running directCategoryInjector.inject()');  
      try {
        window.directCategoryInjector.inject();
        setTimeout(verifyCategoryElements, 500); // Verify after injection
        return;
      } catch (err) {
        console.error('Error running direct injector:', err);
      }
    }
    
    // Step 1: Try to create containers if missing
    if (!document.querySelector('.category-ribbon-container')) {
      const searchResults = document.querySelector('.search-results-container, .intelligent-search-results');
      if (searchResults) {
        logInfo('Creating missing category containers');
        
        // Create container structure
        const categoryContainer = document.createElement('div');
        categoryContainer.id = 'category-ribbon-main-container';
        categoryContainer.className = 'category-ribbon-container';
        categoryContainer.setAttribute('data-testid', 'category-ribbon-visual');
        categoryContainer.style.display = 'block';
        categoryContainer.style.visibility = 'visible';
        categoryContainer.style.margin = '10px 0';
        categoryContainer.style.position = 'relative';
        categoryContainer.style.zIndex = '900';
        
        // Create ribbon content
        const ribbonContent = document.createElement('div');
        ribbonContent.className = 'category-ribbon-content category-ribbon';
        ribbonContent.style.display = 'block';
        ribbonContent.style.visibility = 'visible';
        
        // Create cards container
        const cardsContainer = document.createElement('div');
        cardsContainer.className = 'category-cards-container ribbon-category-container';
        cardsContainer.style.display = 'flex';
        cardsContainer.style.flexWrap = 'wrap';
        cardsContainer.style.gap = '8px';
        
        // Add default categories if we can find any in window state
        const defaultCategories = [];
        
        if (window.__categoryRibbonVisualRender && window.__categoryRibbonVisualRender.categories) {
          window.__categoryRibbonVisualRender.categories.forEach((name, i) => {
            defaultCategories.push({
              id: 'emergency-cat-' + i,
              name: name
            });
          });
        } else {
          // Fallback default categories
          defaultCategories.push(
            { id: 'emergency-key-insights', name: 'Key Insights' },
            { id: 'emergency-all-results', name: 'All Results' }
          );
        }
        
        // Create cards
        defaultCategories.forEach((category, index) => {
          const card = document.createElement('div');
          card.className = 'category-card ribbon-category-card';
          card.setAttribute('data-category-id', category.id);
          card.setAttribute('data-category-name', category.name);
          card.style.display = 'inline-block';
          card.style.padding = '8px 12px';
          card.style.margin = '4px';
          card.style.borderRadius = '4px';
          card.style.border = '1px solid #d1d5db';
          card.style.backgroundColor = 'white';
          card.style.cursor = 'pointer';
          
          // Add category name
          const nameEl = document.createElement('div');
          nameEl.style.fontWeight = index === 0 ? 'bold' : 'normal';
          nameEl.textContent = category.name;
          card.appendChild(nameEl);
          
          cardsContainer.appendChild(card);
        });
        
        // Assemble the structure
        ribbonContent.appendChild(cardsContainer);
        categoryContainer.appendChild(ribbonContent);
        
        // Add to the search results
        searchResults.insertBefore(categoryContainer, searchResults.firstChild);
        
        logSuccess('Created emergency category structure with ' + defaultCategories.length + ' categories');
      } else {
        logError('Cannot fix - no search results container found');
      }
    } else {
      // Just fix visibility on existing elements
      const containers = document.querySelectorAll(
        '.category-ribbon-container, .category-ribbon, .category-cards-container'
      );
      
      containers.forEach(container => {
        container.style.display = container.className.includes('flex') ? 'flex' : 'block';
        container.style.visibility = 'visible';
        container.style.opacity = '1';
      });
      
      const cards = document.querySelectorAll('.category-card, .ribbon-category-card, [data-category-id]');
      cards.forEach(card => {
        card.style.display = 'inline-block';
        card.style.visibility = 'visible';
        card.style.opacity = '1';
      });
      
      logSuccess('Fixed visibility on ' + containers.length + ' containers and ' + cards.length + ' cards');
    }
    
    return verifyCategoryElements();
  }
  
  // Add to window
  window.verifyCategoryElements = verifyCategoryElements;
  window.fixCategoryElements = fixCategoryElements;
  
  // Auto-run verification after load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => {
        verifyCategoryElements();
        
        // If no categories found, try to fix
        if (!document.querySelector('.category-ribbon-container, #direct-injected-categories')) {
          setTimeout(fixCategoryElements, 500);
        }
      }, 2000);
    });
  } else {
    setTimeout(() => {
      verifyCategoryElements();
      
      // If no categories found, try to fix
      if (!document.querySelector('.category-ribbon-container, #direct-injected-categories')) {
        setTimeout(fixCategoryElements, 500);
      }
    }, 2000);
  }
  
  // Also run after search results appear
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.addedNodes.length) {
        if (document.querySelector('.search-results-container, .intelligent-search-results')) {
          setTimeout(verifyCategoryElements, 500);
          break;
        }
      }
    }
  });
  
  observer.observe(document.body, { childList: true, subtree: true });
  
  // Log tool availability
  logInfo('Category Verification Tool loaded');
  logInfo('Run window.verifyCategoryElements() to verify category elements');
  logInfo('Run window.fixCategoryElements() to fix missing category elements');
})();
