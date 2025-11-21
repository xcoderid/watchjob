/**
 * Menghasilkan JSON Response
 * @param {object} data
 * @param {number} status
 * @returns {Response}
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
 * KRITIS: Menghitung hash SHA-256 untuk password menggunakan Web Crypto API.
 * Ini menggantikan impor CDN yang gagal di Cloudflare Pages.
 * @param {string} password
 * @returns {Promise<string>}
 */
export const hashPassword = async (password) => {
    // 1. Mengubah string menjadi ArrayBuffer
    const msgBuffer = new TextEncoder().encode(password);

    // 2. Menghitung hash menggunakan Web Crypto API (SHA-256)
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);

    // 3. Mengubah ArrayBuffer menjadi string Hex
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    return hashHex;
};

/**
 * Mendapatkan YouTube Video ID dari URL
 * @param {string} url
 * @returns {string|null}
 */
export const getYoutubeId = (url) => {
  if (!url) return null;
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
};

/**
 * KRITIS: Memverifikasi token dan mengambil data user
 * @param {object} env - Environment bindings
 * @param {Request} request - Request object
 * @returns {Promise<object|null>} - Data user jika terotentikasi
 */
export const authenticateUser = async (env, request) => {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.substring(7);

  // Ambil semua kolom untuk User Wallet System
  const user = await env.DB.prepare(`
    SELECT * FROM users WHERE auth_token = ? AND status = 'active'
  `).bind(token).first();
  
  if (!user) return null;
  return user;
};

/**
 * KRITIS: Memperbarui kolom 'balance' di tabel users setelah setiap transaksi
 *
 * @param {object} env - Environment bindings
 * @param {number} userId - ID pengguna yang saldonya akan diperbarui
 * @param {number} amount - Jumlah perubahan saldo (+ untuk tambah, - untuk kurang)
 * @returns {Promise<void>}
 */
export const updateUserBalance = async (env, userId, amount) => {
    // Memastikan perubahan adalah angka
    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount === 0) {
        console.warn(`[UPDATE BALANCE] Invalid amount or zero change for user ${userId}: ${amount}`);
        return;
    }

    try {
        await env.DB.prepare(`
            UPDATE users SET balance = balance + ? WHERE id = ?
        `).bind(numericAmount, userId).run();
    } catch (e) {
        console.error(`[DB ERROR] Failed to update balance for user ${userId}: ${e.message}`);
        throw new Error("Gagal memperbarui saldo di database.");
    }
};
