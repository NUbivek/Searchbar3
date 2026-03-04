/**
 * Facebook OAuth callback handler
 * This endpoint receives the authorization code from Facebook
 */

export default async function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    return res.redirect('/network?error=Method%20not%20allowed');
  }

  const { code, state, error, error_description } = req.query;

  // Handle error from Facebook
  if (error) {
    console.error('Facebook auth error:', error, error_description);
    return res.redirect(`/network?error=${encodeURIComponent(error_description || 'Authentication failed')}`);
  }

  // Validate state parameter (should match what was sent in the auth request)
  // In a real implementation, you would validate this against a stored state
  
  if (!code) {
    return res.redirect('/network?error=No authorization code received');
  }

  // In a real implementation, the code would be exchanged for a token server-side
  // and the user would be redirected back to the app with a session cookie

  // For now, we'll redirect to the network page with the code as a query param
  // The frontend will handle the token exchange
  return res.redirect(`/network?code=${code}&source=facebook`);
}
