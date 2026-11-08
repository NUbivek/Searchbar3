/**
 * TabNavigation.js
 * An underline tab bar for the search results (All Results / Key Insights).
 */

import React, { useState, useEffect } from 'react';
import styles from './TabNavigation.module.css';

/**
 * @param {Object} props
 * @param {Array} props.tabs - Array of tab objects {id, label, content}
 * @param {string} props.defaultTabId - ID of the default active tab
 * @param {Function} props.onTabChange - Optional callback when tab changes
 */
const TabNavigation = ({
  tabs = [],
  defaultTabId = null,
  onTabChange = null,
  containerStyle = {}
}) => {
  // Initialize with first tab or specified default
  const [activeTabId, setActiveTabId] = useState(
    defaultTabId || (tabs && tabs.length > 0 ? tabs[0].id : null)
  );

  // Keep the active tab valid when the tab list changes
  useEffect(() => {
    if (!activeTabId && tabs && tabs.length > 0) {
      setActiveTabId(defaultTabId || tabs[0].id);
    } else if (activeTabId && tabs && !tabs.find(tab => tab.id === activeTabId)) {
      setActiveTabId(tabs[0].id);
    }
  }, [tabs, defaultTabId, activeTabId]);

  // Handle tab click
  const handleTabClick = (tabId) => {
    setActiveTabId(tabId);
    if (onTabChange) onTabChange(tabId);
  };

  // If no tabs, show a single tab with a short message
  if (!tabs || tabs.length === 0) {
    tabs = [{
      id: 'error-tab',
      label: 'Results',
      content: (
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>Results unavailable</div>
          <p className={styles.emptyText}>The results could not be shown this time. Run the search again.</p>
        </div>
      )
    }];
  }

  // Get active tab content (the tab header is always shown, even for one tab)
  const activeTab = tabs.find(tab => tab.id === activeTabId) || tabs[0];

  return (
    <div
      className={styles.tabContainer}
      data-testid="tab-navigation"
      style={containerStyle}
    >
      <div className={styles.tabHeaders} role="tablist">
        {tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            className={`${styles.tabButton} ${activeTabId === tab.id ? styles.active : ''}`}
            onClick={() => handleTabClick(tab.id)}
            aria-selected={activeTabId === tab.id}
            role="tab"
            data-tab-id={tab.id}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className={styles.tabContent} role="tabpanel">
        {activeTab ? activeTab.content : <div className={styles.emptyText}>No content available</div>}
      </div>
    </div>
  );
};

export default TabNavigation;
