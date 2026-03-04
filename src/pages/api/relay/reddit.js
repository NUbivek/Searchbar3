/**
 * Reddit OAuth Relay
 * 
 * This page receives OAuth callbacks from Reddit and provides options to redirect 
 * to your local development server. This avoids the need to update your Reddit 
 * developer console callback URLs whenever your local port changes.
 */

export default function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  // Extract the auth code and state from the query parameters
  const { code, state } = req.query;
  
  // Generate HTML that will display a page with options to redirect
  const html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Reddit OAuth Relay - research.bivek.ai</title>
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
      h1, h2 {
        color: #ff4500;  /* Reddit orange */
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
      pre {
        background-color: #f9f6f2;
        padding: 15px;
        border-radius: 5px;
        overflow-x: auto;
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
        background-color: #ff4500;  /* Reddit orange */
        color: white;
        border: none;
        padding: 10px 20px;
        border-radius: 5px;
        cursor: pointer;
        font-size: 16px;
        margin-right: 10px;
      }
      button:hover {
        background-color: #e03d00;
      }
      .params {
        margin-top: 10px;
        padding: 10px;
        background-color: #f5f5f5;
        border-radius: 5px;
        font-family: monospace;
        word-break: break-all;
      }
    </style>
    <script>
      // Load local server URL from localStorage or use default
      let localServerUrl = localStorage.getItem('localServerUrl') || 'http://localhost:3001';
      
      // Function to redirect to local server
      function redirectToLocal() {
        const code = "${code || ''}";
        const state = "${state || ''}";
        
        // Build the callback URL
        let callbackUrl = localServerUrl + '/api/auth/reddit/callback';
        if (code || state) {
          callbackUrl += '?';
          if (code) callbackUrl += 'code=' + encodeURIComponent(code);
          if (code && state) callbackUrl += '&';
          if (state) callbackUrl += 'state=' + encodeURIComponent(state);
        }
        
        // Redirect to the local server
        window.location.href = callbackUrl;
      }
      
      // Function to update local server URL
      function updateLocalUrl() {
        const input = document.getElementById('localServerUrl');
        if (input.value) {
          localStorage.setItem('localServerUrl', input.value);
          localServerUrl = input.value;
          document.getElementById('currentUrl').textContent = localServerUrl;
          
          // Update the visible callback URL
          const code = "${code || ''}";
          const state = "${state || ''}";
          let callbackUrl = localServerUrl + '/api/auth/reddit/callback';
          if (code || state) {
            callbackUrl += '?';
            if (code) callbackUrl += 'code=' + code;
            if (code && state) callbackUrl += '&';
            if (state) callbackUrl += 'state=' + state;
          }
          document.getElementById('callbackUrl').textContent = callbackUrl;
        }
      }
      
      // Initialize on page load
      window.addEventListener('DOMContentLoaded', function() {
        document.getElementById('localServerUrl').value = localServerUrl;
        document.getElementById('currentUrl').textContent = localServerUrl;
        
        // Set initial callback URL
        const code = "${code || ''}";
        const state = "${state || ''}";
        let callbackUrl = localServerUrl + '/api/auth/reddit/callback';
        if (code || state) {
          callbackUrl += '?';
          if (code) callbackUrl += 'code=' + code;
          if (code && state) callbackUrl += '&';
          if (state) callbackUrl += 'state=' + state;
        }
        document.getElementById('callbackUrl').textContent = callbackUrl;
      });
    </script>
  </head>
  <body>
    <div class="container">
      <h1>Reddit OAuth Relay</h1>
      <p>This page will redirect you to your local development server with the Reddit OAuth code.</p>
      
      <div class="card">
        <h2>Authentication Details</h2>
        <div class="params">
          <strong>Code:</strong> ${code ? code.substring(0, 10) + '...' : 'None'}<br>
          <strong>State:</strong> ${state || 'None'}
        </div>
      </div>
      
      <div class="card">
        <h2>Local Server Settings</h2>
        <p>Current local server: <strong id="currentUrl">Loading...</strong></p>
        
        <p>Update local server URL if needed:</p>
        <input type="text" id="localServerUrl" placeholder="http://localhost:3001">
        <button onclick="updateLocalUrl()">Update</button>
        
        <p>Callback URL that will be used:</p>
        <pre id="callbackUrl">Loading...</pre>
        
        <button onclick="redirectToLocal()">Redirect to Local Server</button>
      </div>
      
      <div class="card">
        <h2>About OAuth Relay</h2>
        <p>
          This relay system allows you to use your production Reddit OAuth setup with your local development environment.
          Your Reddit Developer console only needs to be configured once with the production callback URL.
        </p>
        <p>
          <a href="/api/relay" target="_blank">View OAuth Relay Documentation</a>
        </p>
      </div>
    </div>
  </body>
  </html>
  `;
  
  // Set Content-Type and send HTML response
  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(html);
}
