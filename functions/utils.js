/**
 * Standardized JSON Response
 */
export const jsonResponse = (data, status = 200) => {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
};

/**
 * Secure Password Hashing (SHA-256)
 * Jangan pernah menyimpan password plain text!
 */
export const hashPassword = async (password) => {
  const msgBuffer = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
};

/**
 * Extract Youtube ID securely
 */
export const getYoutubeId = (url) => {
  if (!url) return null;
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
};

/**
 * Validate User Token & Return User Data
 */
export const authenticateUser = async (env, request) => {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  
  const token = authHeader.split(' ')[1];
  // Asumsi ada kolom auth_token di tabel users. 
  // Jika belum ada, jalankan: ALTER TABLE users ADD COLUMN auth_token TEXT;
  const user = await env.DB.prepare('SELECT * FROM users WHERE auth_token = ? AND status = "active"').bind(token).first();
  return user;
};

/**
 * Calculate Real-time Balance
 */
export const getUserBalance = async (env, userId) => {
  const query = `
    SELECT SUM(
      CASE 
        WHEN type IN ('deposit', 'income', 'commission') AND status = 'success' THEN amount 
        WHEN type IN ('expense') AND status = 'success' THEN -amount
        WHEN type IN ('withdrawal') AND status IN ('success', 'pending') THEN -amount
        ELSE 0 
      END
    ) as balance FROM transactions WHERE user_id = ?
  `;
  const result = await env.DB.prepare(query).bind(userId).first();
  return result.balance || 0;
};
