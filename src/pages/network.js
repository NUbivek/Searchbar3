import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { Tab } from '@headlessui/react';
import axios from 'axios';
import { FaSearch, FaProjectDiagram, FaUsers, FaLink, FaCheckCircle, FaExclamationCircle, FaInfoCircle, FaLinkedin } from 'react-icons/fa';
import { FaXTwitter } from 'react-icons/fa6'; // X logo (formerly Twitter)
import NetworkDebug from '../components/NetworkDebug';

function classNames(...classes) {
  return classes.filter(Boolean).join(' ');
}

export default function NetworkPage() {
  const router = useRouter();
  const { error, auth, code, state } = router.query;
  
  // Store last check time in a ref to prevent redundant Twitter checks
  const lastTwitterCheckRef = React.useRef(0);
  
  const [connectionStatus, setConnectionStatus] = useState({
    LinkedIn: false,
    Twitter: false
  });
  
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [networkData, setNetworkData] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState(null);
  const [showConnectionWarning, setShowConnectionWarning] = useState(false);
  
  // Effect to handle network data updates and visualization
  useEffect(() => {
    // Check if the network data is loaded and should display
    if (networkData) {
      // Check if there are any connections to display
      if (networkData.connections?.length > 0) {
        console.log('Network data loaded with connections, can visualize now');
        // Clear any existing error messages about connection issues
        if (errorMessage && errorMessage.includes('but no network data was found')) {
          setErrorMessage('');
        }
      } else {
        // Show a helpful message when the user is connected but no data loaded
        console.log('Network connected but no connections found');
        if ((connectionStatus.LinkedIn || connectionStatus.Twitter) && !errorMessage) {
          setErrorMessage(`Your account is connected, but no network data was found. This might be because you're using a new account or don't have any connections yet.`);
        }
      }
    }
  }, [networkData, connectionStatus, errorMessage]);
  
  // Clear error message when navigating away
  useEffect(() => {
    return () => setErrorMessage('');
  }, []);
  
  // Handle authentication status and errors from URL params
  useEffect(() => {
    if (error) {
      setErrorMessage(decodeURIComponent(error));
      // Remove error from URL
      router.replace('/network', undefined, { shallow: true });
    }
    
    // Handle auth success parameters
    if (auth) {
      if (auth === 'linkedin_success') {
        setConnectionStatus(prev => ({
          ...prev,
          LinkedIn: true
        }));
        // Fetch LinkedIn connections
        fetchLinkedInData();
      } else if (auth === 'twitter_success') {
        setConnectionStatus(prev => ({
          ...prev,
          Twitter: true
        }));
        // Fetch Twitter network data
        fetchTwitterData();
      }
      
      // Remove auth from URL
      router.replace('/network', undefined, { shallow: true });
    }
    
    // Handle LinkedIn OAuth callback
    if (code && state) {
      handleLinkedInCallback(code, state);
    }
  }, [error, auth, code, state, router]);
  
  // Check if user is already authenticated with LinkedIn and Twitter
  useEffect(() => {
    const checkAuthStatus = async () => {
      try {
        setIsLoading(true);
        console.log('Checking LinkedIn authentication status');
        const linkedinResponse = await axios.get('/api/auth/linkedin/token');
        
        if (linkedinResponse.data.isAuthenticated) {
          console.log('User is authenticated with LinkedIn', linkedinResponse.data.user);
          setConnectionStatus(prev => ({
            ...prev,
            LinkedIn: true
          }));
          // Fetch LinkedIn connections if authenticated
          fetchLinkedInData();
        } else {
          console.log('User is not authenticated with LinkedIn');
          if (linkedinResponse.data.error) {
            console.warn('LinkedIn auth status error:', linkedinResponse.data.error);
          }
        }
        
        // Check Twitter authentication status with better retry handling
        console.log('Checking Twitter authentication status');
        
        // Check if we've recently checked Twitter auth status
        const now = Date.now();
        
        // Skip check if we've checked in the last 10 seconds
        if (now - lastTwitterCheckRef.current < 10000) {
          console.log('Skipping Twitter check - too recent');
          setIsLoading(false);
          // Use cached status
          return;
        }
        
        // Update the timestamp for this check
        lastTwitterCheckRef.current = now;
        
        let retryCount = 0;
        const maxRetries = 1; // Only retry once with longer delays
        
        const checkTwitterAuth = async () => {
          try {
            // Use exponential backoff with jitter for retries
            if (retryCount > 0) {
              // Base delay of 6 seconds, with exponential backoff and random jitter
              const baseDelay = 6000;
              const maxDelay = 30000; // Cap at 30 seconds
              const exponentialDelay = Math.min(baseDelay * Math.pow(1.5, retryCount-1), maxDelay);
              const jitter = Math.random() * 2000; // Add up to 2 seconds of jitter
              const delayMs = exponentialDelay + jitter;
              
              console.log(`Waiting ${Math.round(delayMs/1000)}s before retrying Twitter auth check (retry #${retryCount})...`);
              await new Promise(resolve => setTimeout(resolve, delayMs));
            }
            
            const twitterResponse = await axios.get('/api/auth/twitter/token', { 
              validateStatus: false,
              // Add cache busting to avoid browser caching the 429 response
              params: { 
                _t: Date.now(),
                retry: retryCount // Pass retry count to API for logging
              } 
            });
            
            // Handle rate limiting specially
            if (twitterResponse.status === 429) {
              // Extract retry-after if available
              const retryAfter = twitterResponse.data?.retryAfter || 
                                 twitterResponse.headers?.['retry-after'] || 15;
              
              // Get nextReset time if available
              const nextReset = twitterResponse.data?.nextReset || null;
              const nextResetMessage = nextReset ? ` (reset at ${new Date(nextReset).toLocaleTimeString()})` : '';
                                 
              console.warn(`Twitter API rate limited. Retry after ${retryAfter}s${nextResetMessage}`);
              
              // Show a more user-friendly error
              setErrorMessage(`Twitter connection check is temporarily unavailable due to rate limiting. Please try again in ${retryAfter} seconds.`);
              
              // Set Twitter status to false but don't treat as a full error
              setConnectionStatus(prev => ({
                ...prev,
                Twitter: false
              }));
              
              // Only retry once with a longer delay
              if (retryCount < maxRetries) {
                retryCount++;
                // Wait longer before retrying (at least 8 seconds)
                const waitTime = Math.max(retryAfter * 1000, 8000);
                console.log(`Will retry Twitter auth check in ${waitTime/1000}s`);
                setTimeout(checkTwitterAuth, waitTime);
                return;
              } else {
                // Stop loading state after max retries
                setIsLoading(false);
                return;
              }
            }
            
            // Process the response even if it's an error code
            if (twitterResponse.status === 200 && twitterResponse.data.authenticated) {
              console.log('User is authenticated with Twitter', twitterResponse.data.profile);
              setConnectionStatus(prev => ({
                ...prev,
                Twitter: true
              }));
              
              // Clear any error message about rate limiting
              if (errorMessage && errorMessage.includes('rate limit')) {
                setErrorMessage('');
              }
              
              // Fetch Twitter connections if authenticated
              fetchTwitterData();
            } else {
              // User not authenticated or auth expired - don't treat as error
              console.log('User is not authenticated with Twitter');
              setConnectionStatus(prev => ({
                ...prev,
                Twitter: false
              }));
              
              if (twitterResponse.data?.error) {
                console.warn('Twitter auth status:', twitterResponse.data.error);
                
                // Only show rate limit errors to the user
                if (twitterResponse.data.rateLimited) {
                  setErrorMessage(`Twitter API ${twitterResponse.data.error}`);
                }
              }
            }
          } catch (twitterError) {
            // Only log real errors, not auth status
            console.warn('Twitter auth check failed:', twitterError.message);
            setConnectionStatus(prev => ({
              ...prev,
              Twitter: false
            }));
          }
        };
        
        // Start the Twitter auth check process
        await checkTwitterAuth();
      } catch (error) {
        console.error('Failed to check authentication status:', error.response?.data || error.message);
      } finally {
        setIsLoading(false);
      }
    };
    
    checkAuthStatus();
  }, []);
  
  const fetchLinkedInData = async () => {
    try {
      setIsLoading(true);
      console.log('Fetching LinkedIn network data');
      const response = await axios.get('/api/network/linkedin/index');
      
      if (response.data && (response.data.connections || response.data.networksData)) {
        console.log('Successfully retrieved LinkedIn network data:', 
          response.data.connections ? `${response.data.connections.length} connections` : 'No connections');
        
        // Merge with existing networkData or set as new networkData
        setNetworkData(prevData => {
          if (!prevData) {
            return response.data;
          }
          
          // Mark LinkedIn connections with a source field
          const linkedinConnections = (response.data.connections || []).map(conn => ({
            ...conn,
            source: 'linkedin'
          }));
          
          // Keep only connections from other sources (like Twitter)
          const nonLinkedinConnections = (prevData.connections || []).filter(conn => 
            conn.source !== 'linkedin'
          );
          
          return {
            // Preserve user data if it exists
            user: response.data.user || prevData.user,
            // Maintain Twitter user data if it exists
            twitterUser: prevData.twitterUser,
            twitterNetworkData: prevData.twitterNetworkData,
            // LinkedIn specific data
            linkedinNetworkData: response.data.networksData,
            // Merge connections from both sources
            connections: [
              ...nonLinkedinConnections,
              ...linkedinConnections
            ],
            // Preserve any analyzed connections
            analyzedConnections: prevData.analyzedConnections,
            useAnalyzedConnections: prevData.useAnalyzedConnections
          };
        });
      } else {
        console.error('LinkedIn data response is missing expected data structure:', response.data);
        setErrorMessage('Received incomplete data from LinkedIn API');
      }
    } catch (error) {
      console.error('Failed to fetch LinkedIn data:', error.response?.data || error.message);
      const errorDetails = error.response?.data?.error || error.message || 'Unknown error';
      setErrorMessage(`Failed to fetch network data from LinkedIn: ${errorDetails}`);
      
      // If we got a 401, the token might be expired - update connection status
      if (error.response?.status === 401) {
        setConnectionStatus(prev => ({
          ...prev,
          LinkedIn: false
        }));
        console.log('LinkedIn session expired, updating connection status to disconnected');
      }
    } finally {
      setIsLoading(false);
    }
  };
  
  const fetchTwitterData = async () => {
    try {
      setIsLoading(true);
      console.log('Fetching Twitter network data');
      
      // Better error handling with timeout
      const response = await axios.get('/api/network/twitter', {
        timeout: 10000, // 10 second timeout
        validateStatus: status => status < 500 // Handle 500 errors manually
      }).catch(error => {
        console.error('Twitter network fetch failed:', error.message);
        // Explicitly handle network errors
        if (error.code === 'ECONNABORTED') {
          throw new Error('Connection to Twitter API timed out');
        }
        throw error;
      });
      
      if (response.data && response.data.user) {
        console.log('Successfully retrieved Twitter network data:', response.data);
        // Merge with existing networkData or set as new networkData
        setNetworkData(prevData => {
          if (!prevData) {
            return response.data;
          }
          
          // Merge the Twitter data with existing LinkedIn data
          return {
            ...prevData,
            twitterUser: response.data.user,
            twitterNetworkData: response.data.networksData,
            // Add any Twitter connections to the connections array
            connections: [
              ...(prevData.connections || []),
              // Add Twitter contacts as connections with a source field
              ...(response.data.networksData?.nodes?.filter(node => node.id !== 'user') || []).map(node => ({
                firstName: node.name,
                source: 'twitter',
                id: node.id
              }))
            ]
          };
        });
      } else {
        console.error('Twitter data response is missing expected data structure:', response.data);
        setErrorMessage('Received incomplete data from Twitter API');
      }
    } catch (error) {
      console.error('Failed to fetch Twitter data:', error.response?.data || error.message);
      
      // Enhanced error handling with more detailed messages
      if (error.response?.status === 429) {
        const retryAfter = error.response.data?.retryAfter || 
                           error.response.headers?.['retry-after'] || 60;
        setErrorMessage(`Twitter API rate limited. Please try again in ${retryAfter} seconds.`);
      } else if (error.response?.status === 401) {
        setErrorMessage('Twitter authentication expired. Please reconnect your X account.');
        // Update connection status
        setConnectionStatus(prev => ({
          ...prev,
          Twitter: false
        }));
      } else if (error.response?.status === 500) {
        // Log detailed error for debugging
        console.error('Twitter API 500 error details:', error.response?.data);
        
        setErrorMessage('Error connecting to X. The service may be temporarily unavailable.');
      } else {
        // Include more error details
        const errorDetails = error.response?.data?.error || error.message || 'Unknown error';
        const additionalDetails = error.response?.data?.details || '';
        setErrorMessage(`Failed to fetch network data from X: ${errorDetails}${additionalDetails ? ` (${additionalDetails})` : ''}`);
      }
      
      // If we got a 401, the token might be expired - update connection status
      if (error.response?.status === 401) {
        setConnectionStatus(prev => ({
          ...prev,
          Twitter: false
        }));
        console.log('Twitter session expired, updating connection status to disconnected');
      }
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleConnect = (source) => {
    // Clear any previous error messages
    setErrorMessage('');
    
    // Add delay between connection attempts to avoid rate limits
    const lastConnectAttempt = localStorage.getItem(`last_connect_${source}`);
    const now = Date.now();
    
    if (lastConnectAttempt && (now - parseInt(lastConnectAttempt)) < 5000) {
      setErrorMessage(`Please wait a moment before trying to connect to ${source} again.`);
      return;
    }
    
    // Record this connection attempt
    localStorage.setItem(`last_connect_${source}`, now.toString());
    
    if (source === 'LinkedIn') {
      if (connectionStatus.LinkedIn) {
        // Disconnect from LinkedIn
        handleDisconnect('linkedin');
      } else {
        // Delegate OAuth URL creation to server-side handler for consistent env/callback handling.
        window.location.href = '/api/auth/linkedin';
      }
    } else if (source === 'Twitter') {
      if (connectionStatus.Twitter) {
        // Disconnect from Twitter
        handleDisconnect('twitter');
      } else {
        // Delegate OAuth URL creation to server-side handler for consistent env/callback handling.
        window.location.href = '/api/auth/twitter';
      }
    }
  };
  
  const handleDisconnect = async (service) => {
    try {
      await axios.get(`/api/auth/${service}/logout`);
      setConnectionStatus(prev => ({
        ...prev,
        [service.charAt(0).toUpperCase() + service.slice(1)]: false
      }));
      setNetworkData(null);
    } catch (error) {
      console.error(`Failed to disconnect from ${service}:`, error);
      setErrorMessage(`Failed to disconnect from ${service}`);
    }
  };
  
  // Handle LinkedIn OAuth callback directly in the frontend
  const clearNetworkSearch = () => {
    setSearchResults(null);
    setSearchQuery('');
    
    // Reset visualization to use default connections
    if (networkData) {
      setNetworkData(prevData => ({
        ...prevData,
        useAnalyzedConnections: false
      }));
    }
  };

  const handleNetworkSearch = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) {
      clearNetworkSearch();
      return;
    }
    
    try {
      setIsSearching(true);
      setErrorMessage('');
      
      // Get the available network data to include in the request
      const networkDataToSend = {
        connections: networkData?.connections || [],
        user: networkData?.user || {},
        twitterUser: networkData?.twitterUser,
        linkedInConnected: connectionStatus.LinkedIn,
        twitterConnected: connectionStatus.Twitter
      };
      
      console.log('Submitting network analysis query:', searchQuery);
      
      // Send the query to the LLM endpoint for processing
      const response = await axios.post('/api/network/analyze', {
        query: searchQuery,
        networkData: networkDataToSend
      });
      
      if (response.data) {
        console.log('Network analysis result:', response.data);
        setSearchResults(response.data);
        
        // Update network visualization based on the filtered/analyzed data
        if (response.data.filteredConnections) {
          setNetworkData(prevData => ({
            ...prevData,
            analyzedConnections: response.data.filteredConnections,
            useAnalyzedConnections: true
          }));
        }
      }
    } catch (error) {
      console.error('Network analysis failed:', error.response?.data || error.message);
      setErrorMessage(`Analysis failed: ${error.response?.data?.error || error.message || 'Unknown error'}`);
    } finally {
      setIsSearching(false);
    }
  };
  
  const handleLinkedInCallback = async (code, state) => {
    console.log('Handling LinkedIn callback in frontend with code present');
    try {
      setIsLoading(true);
      
      // Exchange the code for an access token
      const response = await axios.post('/api/auth/linkedin/token', { code });
      
      if (response.data && response.data.success) {
        console.log('Successfully authenticated with LinkedIn');
        // Set as connected
        setConnectionStatus(prev => ({
          ...prev,
          LinkedIn: true
        }));
        
        // Fetch LinkedIn data
        fetchLinkedInData();
      } else {
        // Handle unsuccessful authentication
        console.error('LinkedIn authentication response did not indicate success:', response.data);
        setErrorMessage(response.data.error || 'Failed to authenticate with LinkedIn');
      }
      
      // Always clear the URL params to prevent reprocessing
      router.replace('/network', undefined, { shallow: true });
    } catch (error) {
      console.error('Failed to exchange LinkedIn code:', error.response?.data || error.message);
      const errorDetails = error.response?.data?.details || error.message || 'Unknown error';
      setErrorMessage(`Failed to authenticate with LinkedIn: ${errorDetails}`);
      router.replace('/network', undefined, { shallow: true });
    } finally {
      setIsLoading(false);
    }
  };
  return (
    <div className="w-full min-h-screen bg-gray-50">
      <Head>
        <title>Network Map - Research Hub</title>
        <meta name="description" content="Visualize your professional network" />
      </Head>
      
      <main className="container mx-auto px-4 py-6">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-gray-800">Research Hub</h1>
          <p className="text-gray-600 mt-1">Search across web, academic sources, and more.</p>
        </div>
        
        <Tab.Group>
          <Tab.List className="flex space-x-2 rounded-xl bg-blue-100 p-1 mb-6 max-w-md mx-auto">
            <Link href="/" className="w-full rounded-lg py-2.5 text-sm font-medium leading-5 flex items-center justify-center bg-blue-100 text-blue-500 hover:bg-white/[0.12] hover:text-blue-700">
              <FaSearch className="mr-2" /> Open Research
            </Link>
            <Tab
              className={({ selected }) =>
                classNames(
                  'w-full rounded-lg py-2.5 text-sm font-medium leading-5 flex items-center justify-center',
                  'focus:outline-none focus:ring-2 ring-offset-2 ring-offset-blue-400 ring-white ring-opacity-60',
                  selected
                    ? 'bg-white text-blue-700 shadow'
                    : 'text-blue-500 hover:bg-white/[0.12] hover:text-blue-700'
                )
              }
            >
              <FaProjectDiagram className="mr-2" /> Network Map
            </Tab>
          </Tab.List>
        </Tab.Group>

        {/* Enhanced searchbar and connection tabs in one row */}
        <div className="mb-8 px-4 py-3 bg-white shadow-md rounded-xl mx-auto max-w-4xl flex items-center gap-4 border border-gray-100">
          {/* Search bar - more pronounced */}
          <div className="flex-grow">
            <form onSubmit={handleNetworkSearch} className="flex w-full">
              <div className="relative w-full">
                <input
                  type="text"
                  placeholder="Search your network..." 
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    // Show warning if typing without connections
                    if (!connectionStatus.LinkedIn && !connectionStatus.Twitter && e.target.value && !showConnectionWarning) {
                      setShowConnectionWarning(true);
                    }
                  }}
                  onFocus={() => {
                    // Show warning on focus if no connections
                    if (!connectionStatus.LinkedIn && !connectionStatus.Twitter && !showConnectionWarning) {
                      setShowConnectionWarning(true);
                    }
                  }}
                  className="w-full h-11 px-4 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-300 shadow-sm"
                />
                <div className="absolute right-2 top-1/2 transform -translate-y-1/2 flex space-x-2">
                  {searchResults && (
                    <button
                      type="button"
                      onClick={clearNetworkSearch}
                      className="bg-gray-200 text-gray-700 p-1.5 rounded-md hover:bg-gray-300 transition-colors"
                      title="Clear search"
                    >
                      ✕
                    </button>
                  )}
                  <button
                    type="submit"
                    className="bg-blue-500 text-white p-2 rounded-md hover:bg-blue-600 transition-colors"
                    disabled={!connectionStatus.LinkedIn && !connectionStatus.Twitter}
                  >
                    <FaSearch />
                  </button>
                </div>
              </div>
            </form>
          </div>
          
          {/* Connection buttons - more pronounced with status indicators */}
          <div className="flex flex-row gap-3 flex-shrink-0">
            {[
              { name: 'LinkedIn', icon: <FaLinkedin size={18} /> },
              { name: 'Twitter', icon: <FaXTwitter size={18} /> }
            ].map(({ name, icon }) => {
              // Determine button state and styling
              let buttonClass = "flex items-center h-11 px-4 text-sm rounded-md transition-colors font-medium shadow-sm";
              let statusIndicator = null;
              
              if (isLoading && !connectionStatus[name]) {
                // Loading state
                buttonClass += " bg-gray-100 text-gray-500 cursor-not-allowed";
                statusIndicator = (
                  <div className="ml-2 animate-pulse">
                    <div className="h-3 w-3 rounded-full bg-gray-300"></div>
                  </div>
                );
              } else if (connectionStatus[name]) {
                // Connected state - green
                buttonClass += " bg-green-600 text-white hover:bg-green-700";
                statusIndicator = <FaCheckCircle className="text-white ml-2" size={14} />;
              } else {
                // Not connected state - blue
                buttonClass += " bg-blue-500 text-white hover:bg-blue-600";
              }
              
              // Not using tab selection highlighting for now
              /* Removed activeTabIndex reference that was causing an error */
              
              return (
                <button 
                  key={name}
                  onClick={() => handleConnect(name)}
                  disabled={isLoading && !connectionStatus[name]}
                  className={buttonClass}
                  title={connectionStatus[name] ? `Disconnect from ${name}` : `Connect to ${name}`}
                >
                  <span className="mr-2">{icon}</span>
                  <span>{connectionStatus[name] ? 'Connected' : 'Connect'}</span>
                  {statusIndicator}
                </button>
              );
            })}
          </div>
        </div>
        
        {/* Error message display */}
        {errorMessage && (
          <div className="mb-4 p-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg flex items-center justify-between w-full max-w-2xl mx-auto shadow-sm">
            <div className="flex items-center">
              <FaExclamationCircle className="text-red-500 mr-2 flex-shrink-0" />
              <span>{errorMessage}</span>
            </div>
            <button 
              onClick={() => setErrorMessage('')} 
              className="text-red-500 hover:text-red-700 ml-2 p-1"
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}
        
        {false && (
          <div className="hidden mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded relative w-full max-w-2xl mx-auto">
            <div className="flex items-center">
              <FaExclamationCircle className="mr-2" />
              <span>{errorMessage}</span>
            </div>
          </div>
        )}
        
        {/* Add CSS for animation */}
        <style>{`
          @keyframes fadeInDown {
            from {
              opacity: 0;
              transform: translateY(-20px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
          .animate-fade-in-down {
            animation: fadeInDown 0.3s ease-out forwards;
          }
        `}</style>
        
        {/* Popup warning when user tries to use search without connecting */}
        {showConnectionWarning && (
          <div className="fixed inset-x-0 top-20 flex justify-center items-start z-50 px-4 pointer-events-none animate-fade-in-down">
            <div className="bg-white border border-amber-300 rounded-lg shadow-lg p-4 max-w-md pointer-events-auto relative">
              <button 
                onClick={() => setShowConnectionWarning(false)}
                className="absolute top-2 right-2 text-gray-500 hover:text-gray-700"
              >
                ×
              </button>
              <div className="flex items-start space-x-3">
                <div className="bg-amber-100 rounded-full p-2 flex-shrink-0">
                  <FaInfoCircle className="text-amber-500 text-lg" />
                </div>
                <div>
                  <h3 className="font-medium text-gray-900">Connect Your Accounts</h3>
                  <p className="text-gray-600 text-sm mt-1">
                    To search and visualize your professional network, connect to LinkedIn or Twitter using the buttons.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
        
        {/* Subtle divider */}
        <div className="relative mb-8">
          <div className="absolute inset-0 flex items-center" aria-hidden="true">
            <div className="w-full border-t border-gray-200"></div>
          </div>
          <div className="relative flex justify-center">
            <span className="bg-gray-50 px-4 text-sm text-gray-500">Network Analysis</span>
          </div>
        </div>
        
        {/* Network visualization with statistics on the right */}
        <div className="flex flex-col md:flex-row md:justify-between gap-6 mb-6">
          {/* Main visualization area */}
          <div className="bg-white rounded-lg shadow-sm p-8 flex-grow">
            {networkData ? (
              <div className="min-h-[500px]">
                <h2 className="text-xl font-semibold mb-2">Network Visualization</h2>
                <div className="p-4 border border-gray-200 rounded-md h-full relative">
                  {isSearching ? (
                    <div className="flex flex-col items-center justify-center min-h-[400px]">
                      <div className="text-center">
                        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mb-4"></div>
                        <p className="text-gray-600">Analyzing your network...</p>
                        <p className="text-sm text-gray-500 mt-2">Applying AI to understand your query</p>
                      </div>
                    </div>
                  ) : searchResults ? (
                    <div className="flex flex-col items-center min-h-[400px]">
                      <div className="w-full mb-4 text-center">
                        <h3 className="font-medium text-gray-800">{searchResults.responseText}</h3>
                        <p className="text-sm text-gray-600 mt-1">{searchResults.summary}</p>
                      </div>
                      <div className="flex flex-col items-center justify-center relative min-h-[400px] w-full">

                      {/* Center node - the user */}
                      <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-10">
                        <div className="w-24 h-24 rounded-full bg-blue-100 border-4 border-blue-500 flex items-center justify-center shadow-lg">
                          <div className="text-center">
                            <div className="font-semibold text-blue-800">{networkData.user.firstName || 'User'}</div>
                            <div className="text-xs text-blue-600 mt-1">You</div>
                          </div>
                        </div>
                      </div>
                      
                      {/* Connection nodes */}
                      {networkData.useAnalyzedConnections && networkData.analyzedConnections 
                        ? networkData.analyzedConnections.slice(0, 8).map((connection, index) => {
                            // Calculate position in a circle around the center
                            const angle = (index * (360 / Math.min(8, networkData.analyzedConnections.length))) * (Math.PI / 180);
                            const radius = 150; // Distance from center
                            const left = `calc(50% + ${Math.cos(angle) * radius}px)`;
                            const top = `calc(50% + ${Math.sin(angle) * radius}px)`;
                            
                            return (
                              <div key={index} 
                                   className="absolute w-16 h-16 rounded-full bg-blue-50 border-2 border-blue-400 flex items-center justify-center transform -translate-x-1/2 -translate-y-1/2 shadow-md"
                                   style={{ left, top }}>
                                <div className="text-center">
                                  <div className="text-xs font-medium text-blue-800 px-1 truncate">
                                    {connection.firstName || connection.name || `Contact ${index + 1}`}
                                  </div>
                                  {connection.category && (
                                    <div className="text-xxs text-blue-600 px-1 truncate">{connection.category}</div>
                                  )}
                                </div>
                              </div>
                            );
                          })
                        : networkData.connections && networkData.connections.slice(0, 6).map((connection, index) => {
                            // Calculate position in a circle around the center
                            const angle = (index * (360 / Math.min(6, networkData.connections.length))) * (Math.PI / 180);
                            const radius = 150; // Distance from center
                            const left = `calc(50% + ${Math.cos(angle) * radius}px)`;
                            const top = `calc(50% + ${Math.sin(angle) * radius}px)`;
                            
                            return (
                              <div key={index} 
                                   className="absolute w-16 h-16 rounded-full bg-green-50 border-2 border-green-400 flex items-center justify-center transform -translate-x-1/2 -translate-y-1/2 shadow-md"
                                   style={{ left, top }}>
                                <div className="text-center">
                                  <div className="text-xs font-medium text-green-800 px-1 truncate">
                                    {connection.firstName || connection.name || `Contact ${index + 1}`}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                      
                      {/* Connection lines */}
                      <svg className="absolute inset-0 w-full h-full" style={{ zIndex: 0 }}>
                        {networkData.useAnalyzedConnections && networkData.analyzedConnections 
                          ? networkData.analyzedConnections.slice(0, 8).map((connection, index) => {
                              const angle = (index * (360 / Math.min(8, networkData.analyzedConnections.length))) * (Math.PI / 180);
                              const radius = 150;
                              const x2 = Math.cos(angle) * radius;
                              const y2 = Math.sin(angle) * radius;
                              
                              return (
                                <line key={index} 
                                      x1="50%" y1="50%" 
                                      x2={`calc(50% + ${x2}px)`} y2={`calc(50% + ${y2}px)`}
                                      stroke="#3B82F6" strokeWidth="2" strokeDasharray="4,4" />
                              );
                            })
                          : networkData.connections && networkData.connections.slice(0, 6).map((connection, index) => {
                              const angle = (index * (360 / Math.min(6, networkData.connections.length))) * (Math.PI / 180);
                              const radius = 150;
                              const x2 = Math.cos(angle) * radius;
                              const y2 = Math.sin(angle) * radius;
                              
                              return (
                                <line key={index} 
                                      x1="50%" y1="50%" 
                                      x2={`calc(50% + ${x2}px)`} y2={`calc(50% + ${y2}px)`}
                                      stroke="#CBD5E0" strokeWidth="2" strokeDasharray="5,5" />
                              );
                            })}
                      </svg>
                      </div>
                    </div>
                  ) : null}
                  {(!networkData || !networkData.user) && (
                    <div className="text-center py-8">
                      <p className="text-gray-500">Network data visualization</p>
                      <p className="text-sm text-gray-400 mt-2">Connect to see your network</p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center min-h-[500px]">
                <div className="text-6xl text-blue-500 mb-4">
                  <FaProjectDiagram />
                </div>
                <h2 className="text-xl font-semibold mb-2">Network Visualization</h2>
                <p className="text-gray-500 mb-6 text-center max-w-md">
                  Connect to your accounts using the buttons at the top right to visualize your network
                </p>
              </div>
            )}
          </div>
          
          {/* Network statistics on the right - more subtle */}
          <div className="bg-gray-50 border border-gray-100 rounded-lg p-3 md:w-44 text-sm self-start ml-auto text-right">
            <div className="mb-3">
              <h2 className="text-sm font-medium text-gray-600 uppercase tracking-wider">Statistics</h2>
            </div>
            <div className="flex flex-col space-y-3">
              <div className="border-b border-gray-200 pb-2">
                <div className="flex items-center justify-end">
                  <div className="text-base font-medium">{networkData ? networkData.connections?.length || 0 : 0}</div>
                  <div className="text-lg text-gray-500 ml-2"><FaUsers /></div>
                </div>
                <div className="text-xs text-gray-500 mt-1">Connections</div>
              </div>
              <div className="border-b border-gray-200 pb-2">
                <div className="flex items-center justify-end">
                  <div className="text-base font-medium">{Object.values(connectionStatus).filter(Boolean).length}</div>
                  <div className="text-lg text-gray-500 ml-2"><FaLink /></div>
                </div>
                <div className="text-xs text-gray-500 mt-1">Linked accounts</div>
              </div>
              <div className="pb-1">
                <div className="flex items-center justify-end">
                  <div className="text-base font-medium">{networkData ? 1 : 0}</div>
                  <div className="text-lg text-gray-500 ml-2"><FaProjectDiagram /></div>
                </div>
                <div className="text-xs text-gray-500 mt-1">Networks</div>
              </div>
            </div>
          </div>
        </div>
        
        {/* Add search tips and example queries */}
        {networkData && (
          <div className="bg-white rounded-lg shadow-sm p-4 mb-6">
            <h3 className="text-lg font-medium text-gray-800 mb-2">Search Tips</h3>
            <p className="text-sm text-gray-600 mb-3">Use natural language to explore your professional network. Try queries like:</p>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div onClick={() => {
                  setSearchQuery("Who are the software engineers in my network?");
                  setTimeout(() => handleNetworkSearch({ preventDefault: () => {} }), 100);
                }} 
                className="bg-blue-50 p-3 rounded-md cursor-pointer border border-blue-100 hover:bg-blue-100 transition">
                <p className="text-sm font-medium text-blue-800">"Who are the software engineers in my network?"</p>
              </div>
              <div onClick={() => {
                  setSearchQuery("Find connections working at tech companies");
                  setTimeout(() => handleNetworkSearch({ preventDefault: () => {} }), 100);
                }} 
                className="bg-green-50 p-3 rounded-md cursor-pointer border border-green-100 hover:bg-green-100 transition">
                <p className="text-sm font-medium text-green-800">"Find connections working at tech companies"</p>
              </div>
              <div onClick={() => {
                  setSearchQuery("Show me people in leadership positions");
                  setTimeout(() => handleNetworkSearch({ preventDefault: () => {} }), 100);
                }} 
                className="bg-purple-50 p-3 rounded-md cursor-pointer border border-purple-100 hover:bg-purple-100 transition">
                <p className="text-sm font-medium text-purple-800">"Show me people in leadership positions"</p>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Show debug component only in development mode */}
      {process.env.NODE_ENV !== 'production' && (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 mb-8">
          <NetworkDebug provider="linkedin" />
        </div>
      )}
    </div>
  );
}
