/**
 * OAuth Relay System - Configuration Page
 * 
 * This page provides information and setup instructions for the OAuth relay system
 * that allows you to use production OAuth callbacks with your local development environment.
 */

export default function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Generate HTML with detailed instructions
  const html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OAuth Relay System - research.bivek.ai</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        line-height: 1.6;
        padding: 20px;
        max-width: 800px;
        margin: 0 auto;
        color: #333;
      }
      .container {
        border: 1px solid #eaeaea;
        border-radius: 10px;
        padding: 20px;
        margin-top: 20px;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
      }
      h1, h2, h3 {
        color: #0070f3;
      }
      h1 {
        border-bottom: 1px solid #eaeaea;
        padding-bottom: 10px;
      }
      .card {
        background-color: #f7f7f7;
        padding: 15px;
        border-radius: 5px;
        margin-bottom: 20px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        margin: 20px 0;
      }
      th, td {
        text-align: left;
        padding: 12px;
        border-bottom: 1px solid #ddd;
      }
      th {
        background-color: #f2f2f2;
      }
      code {
        background-color: #f0f9ff;
        padding: 2px 6px;
        border-radius: 4px;
        font-family: monospace;
      }
      .url-display {
        background-color: #f0f9ff;
        padding: 15px;
        border-radius: 5px;
        word-break: break-all;
        margin: 10px 0;
        font-family: monospace;
      }
      input[type="text"] {
        width: 100%;
        padding: 8px;
        margin: 10px 0;
        border: 1px solid #ddd;
        border-radius: 4px;
      }
      button {
        background-color: #0070f3;
        color: white;
        border: none;
        padding: 10px 20px;
        border-radius: 5px;
        cursor: pointer;
        font-size: 16px;
        margin-right: 10px;
      }
      button:hover {
        background-color: #005bb5;
      }
    </style>
    <script>
      // Load local server URL from localStorage or use default
      let localServerUrl = localStorage.getItem('localServerUrl') || 'http://localhost:3001';
      
      // Function to update local server URL
      function updateLocalUrl() {
        const input = document.getElementById('localServerUrl');
        if (input.value) {
          localStorage.setItem('localServerUrl', input.value);
          localServerUrl = input.value;
          document.getElementById('currentUrl').textContent = localServerUrl;
          updateCallbackUrls();
        }
      }
      
      // Update callback URLs in the table
      function updateCallbackUrls() {
        // Twitter and LinkedIn use fixed callback URLs in this relay page.
        document.getElementById('reddit-callback').textContent = localServerUrl + '/api/auth/reddit/callback';
      }
      
      // Initialize on page load
      window.addEventListener('DOMContentLoaded', function() {
        document.getElementById('localServerUrl').value = localServerUrl;
        document.getElementById('currentUrl').textContent = localServerUrl;
        updateCallbackUrls();
      });
    </script>
  </head>
  <body>
    <div class="container">
      <h1>OAuth Relay System</h1>
      <p>This system allows you to use your production OAuth callbacks with your local development environment.</p>
      
      <div class="card">
        <h2>How It Works</h2>
        <ol>
          <li>Configure OAuth providers (Twitter, LinkedIn, etc.) to use your production URLs</li>
          <li>When a user authenticates, the provider redirects to your production endpoint</li>
          <li>Our relay system captures the OAuth code and presents a page for redirecting to your local server</li>
          <li>Your local development server receives the OAuth code and completes the authentication</li>
        </ol>
      </div>
      
      <div class="card">
        <h2>Provider Configuration</h2>
        <p>Configure the following callback URLs in your OAuth provider developer consoles:</p>
        
        <table>
          <tr>
            <th>Provider</th>
            <th>Callback URL</th>
          </tr>
          <tr>
            <td>Twitter</td>
            <td><code>https://research.bivek.ai/api/auth/twitter/callback</code></td>
          </tr>
          <tr>
            <td>LinkedIn</td>
            <td><code>https://research.bivek.ai/api/auth/linkedin/callback</code></td>
          </tr>
          <tr>
            <td>Reddit</td>
            <td><code>https://research.bivek.ai/api/relay/reddit</code></td>
          </tr>
        </table>
      </div>
      
      <div class="card">
        <h2>Local Development Setup</h2>
        <p>Current local server: <strong id="currentUrl">Loading...</strong></p>
        
        <p>Update local server URL if needed:</p>
        <input type="text" id="localServerUrl" placeholder="http://localhost:3001">
        <button onclick="updateLocalUrl()">Update</button>
        
        <h3>Local Callback URLs</h3>
        <p>These are the local endpoints that will receive the OAuth callbacks:</p>
        
        <table>
          <tr>
            <th>Provider</th>
            <th>Local Callback URL</th>
          </tr>
          <tr>
            <td>Twitter</td>
            <td id="twitter-callback" class="url-display">https://research.bivek.ai/api/auth/twitter/callback</td>
          </tr>
          <tr>
            <td>LinkedIn</td>
            <td id="linkedin-callback" class="url-display">https://research.bivek.ai/api/auth/linkedin/callback</td>
          </tr>
          <tr>
            <td>Reddit</td>
            <td id="reddit-callback" class="url-display">Loading...</td>
          </tr>
        </table>
      </div>
      
      <div class="card">
        <h2>Environment Variables</h2>
        <p>Make sure your <code>.env.local</code> file has the following settings:</p>
        <div class="url-display">
          NEXT_PUBLIC_BASE_URL=http://localhost:3001<br>
          NEXT_PUBLIC_PRODUCTION_URL=https://research.bivek.ai<br>
          NEXT_PUBLIC_USE_PRODUCTION_CALLBACKS=true
        </div>
        <p>With these settings, your application will use the production callbacks in the authentication flow.</p>
      </div>
    </div>
  </body>
  </html>
  `;
  
  // Set Content-Type and send HTML response
  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(html);
}
