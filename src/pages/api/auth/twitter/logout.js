/**
 * Twitter OAuth logout handler
 * This endpoint clears the Twitter authentication state
 */

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Clear Twitter auth cookies
  res.setHeader('Set-Cookie', [
    'twitter_auth_state=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax',
    'twitter_code_verifier=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax',
    'twitter_access_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax'
  ]);
  
  // In a real implementation, you would also clear the session
  
  // Return success
  return res.status(200).json({ 
    success: true,
    message: 'Logged out of Twitter'
  });
}
