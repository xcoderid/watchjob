import { jsonResponse, hashPassword, getUserBalance } from '../utils';

export async function onRequestPost(context) {
  const { request, env } = context;
  
  // Parsing body request
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const url = new URL(request.url);
  const type = url.searchParams.get('type');

  // --- LOGIN LOGIC ---
  if (type === 'login') {
    let { username, password } = body;

    // 1. Validasi Input (Penting: Trim whitespace)
    if (!username || !password || !username.trim() || !password.trim()) {
        return jsonResponse({ error: 'Username dan password wajib diisi' }, 400);
    }

    try {
        // 2. Hash Password (Keamanan)
        const hashedPassword = await hashPassword(password);
        
        // 3. Cari User di Database
        const user = await env.DB.prepare('SELECT * FROM users WHERE username = ? AND password_hash = ?').bind(username, hashedPassword).first();
        
        if (!user) {
            return jsonResponse({ error: 'Username atau password salah' }, 401);
        }

        // 4. Cek Status Akun
        if (user.status !== 'active') {
            return jsonResponse({ error: 'Akun telah dinonaktifkan/banned' }, 403);
        }

        // 5. Generate & Simpan Token Sesi Baru (UUID)
        const newToken = crypto.randomUUID();
        await env.DB.prepare('UPDATE users SET auth_token = ? WHERE id = ?').bind(newToken, user.id).run();

        // 6. Ambil Data Langganan Aktif
        const sub = await env.DB.prepare(`
          SELECT p.*, s.end_date 
          FROM user_subscriptions s 
          JOIN plans p ON s.plan_id = p.id 
          WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
        `).bind(user.id).first();

        // 7. Ambil Saldo Terbaru
        const balance = await getUserBalance(env, user.id);

        // 8. Response Sukses
        return jsonResponse({ 
            success: true, 
            user: { ...user, balance }, // Kirim data user + saldo
            plan: sub || null,          // Kirim data paket jika ada
            token: newToken             // Token untuk otorisasi request selanjutnya
        });

    } catch (e) {
        return jsonResponse({ error: 'Server Error: ' + e.message }, 500);
    }
  }

  // --- REGISTER LOGIC ---
  if (type === 'register') {
    const { username, email, password, referral_code } = body;
    
    // 1. Validasi Input Lengkap
    if (!username || !email || !password) {
        return jsonResponse({ error: 'Semua data wajib diisi' }, 400);
    }

    if (password.length < 6) {
        return jsonResponse({ error: 'Password minimal 6 karakter' }, 400);
    }

    // 2. Cek Referral Code (Opsional)
    let referrerId = null;
    if (referral_code) {
      const ref = await env.DB.prepare('SELECT id FROM users WHERE referral_code = ?').bind(referral_code).first();
      if (ref) referrerId = ref.id;
    }

    // 3. Persiapan Data (Hash & Token)
    const hashedPassword = await hashPassword(password);
    // Generate kode referral unik untuk user baru ini
    const myRefCode = 'REF' + Math.random().toString(36).substring(2, 8).toUpperCase();
    const initialToken = crypto.randomUUID();

    try {
      // 4. Insert User Baru
      const res = await env.DB.prepare(`
        INSERT INTO users (username, email, password_hash, referral_code, referrer_id, auth_token, role, status) 
        VALUES (?, ?, ?, ?, ?, ?, 'user', 'active')
      `).bind(username, email, hashedPassword, myRefCode, referrerId, initialToken).run();
      
      const userId = res.meta.last_row_id;
      
      // 5. Berikan Paket Trial/Free (ID 1) secara otomatis
      const trial = await env.DB.prepare('SELECT id, duration_days FROM plans WHERE id = 1').first();
      if (trial) {
          const end = new Date(); 
          end.setDate(end.getDate() + trial.duration_days);
          
          await env.DB.prepare(`
            INSERT INTO user_subscriptions (user_id, plan_id, end_date, status) 
            VALUES (?, ?, ?, 'active')
          `).bind(userId, trial.id, end.toISOString()).run();
      }

      return jsonResponse({ success: true, message: 'Registrasi Berhasil. Silakan Login.' });

    } catch (e) {
      // Tangkap error duplikat (biasanya username/email sudah ada karena constraint UNIQUE di DB)
      if (e.message.includes('UNIQUE')) {
          return jsonResponse({ error: 'Username atau Email sudah terdaftar' }, 400);
      }
      return jsonResponse({ error: 'Gagal mendaftar: ' + e.message }, 500);
    }
  }

  return jsonResponse({ error: 'Invalid Action Type' }, 400);
}
