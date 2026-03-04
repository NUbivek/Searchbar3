/**
 * Twitter OAuth Relay
 * 
 * This endpoint receives Twitter OAuth callbacks on your production site (research.bivek.ai)
 * and redirects the user to a special handoff page that will forward to your local development server.
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
    <title>Twitter OAuth Relay - research.bivek.ai</title>
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
      h1 {
        color: #0070f3;
        border-bottom: 1px solid #eaeaea;
        padding-bottom: 10px;
      }
      .card {
        background-color: #f7f7f7;
        padding: 15px;
        border-radius: 5px;
        margin-bottom: 20px;
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
      input[type="text"] {
        width: 100%;
        padding: 8px;
        margin: 10px 0;
        border: 1px solid #ddd;
        border-radius: 4px;
      }
      .code-display {
        background-color: #f0f9ff;
        padding: 15px;
        border-radius: 5px;
        overflow-wrap: break-word;
        margin: 10px 0;
      }
    </style>
    <script>
      // Load local server URL from localStorage or use default
      let localServerUrl = localStorage.getItem('localServerUrl') || 'http://localhost:3001';
      
      // Function to update local server URL
      function updateLocalUrl() {
        const input = document.getElementById('localUrl');
        if (input.value) {
          localStorage.setItem('localServerUrl', input.value);
          localServerUrl = input.value;
          document.getElementById('currentUrl').textContent = localServerUrl;
          
          // Update the redirect URL
          updateRedirectUrl();
        }
      }
      
      // Function to construct redirect URL
      function updateRedirectUrl() {
        const code = '${code ? code.replace(/'/g, "\\'"): ""}';
        const state = '${state ? state.replace(/'/g, "\\'"): ""}';
        
        const callbackUrl = localServerUrl + '/api/auth/twitter/callback';
        const url = new URL(callbackUrl);
        if (code) url.searchParams.append('code', code);
        if (state) url.searchParams.append('state', state);
        
        const redirectUrl = url.toString();
        document.getElementById('redirectUrl').textContent = redirectUrl;
        document.getElementById('redirectButton').onclick = function() {
          window.location.href = redirectUrl;
        };
      }
      
      // Initialize on page load
      window.addEventListener('DOMContentLoaded', function() {
        document.getElementById('localUrl').value = localServerUrl;
        document.getElementById('currentUrl').textContent = localServerUrl;
        updateRedirectUrl();
      });
    </script>
  </head>
  <body>
    <div class="container">
      <h1>Twitter OAuth Relay</h1>
      <div class="card">
        <h2>OAuth Parameters Received</h2>
        <p>Authorization code: <span class="code-display">${code ? `${code.substring(0, 10)}...` : 'None'}</span></p>
        <p>State: <span class="code-display">${state || 'None'}</span></p>
      </div>
      
      <div class="card">
        <h2>Redirect to Local Server</h2>
        <p>Current local server: <strong id="currentUrl">Loading...</strong></p>
        
        <p>Update local server URL if needed:</p>
        <input type="text" id="localUrl" placeholder="http://localhost:3001">
        <button onclick="updateLocalUrl()">Update</button>
        
        <p>Redirect URL:</p>
        <div class="code-display" id="redirectUrl">Loading...</div>
        
        <button id="redirectButton">Redirect to Local Server</button>
        <button onclick="window.close()">Close Window</button>
      </div>
    </div>
  </body>
  </html>
  `;
  
  // Set Content-Type and send HTML response
  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(html);
}
