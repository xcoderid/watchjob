import { jsonResponse, hashPassword, getUserBalance } from '../utils';

export async function onRequestPost(context) {
  const { request, env } = context;
  
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const url = new URL(request.url);
  const type = url.searchParams.get('type');

  // --- LOGIN (PHONE) ---
  if (type === 'login') {
    const { phone, password } = body;
    
    if (!phone || !password) return jsonResponse({ error: 'Nomor HP dan Password wajib diisi' }, 400);

    // Pastikan format phone 62
    const cleanPhone = phone.replace(/[^0-9]/g, '');

    const hashedPassword = await hashPassword(password);
    // Kita gunakan kolom 'username' untuk menyimpan No HP agar unik
    const user = await env.DB.prepare('SELECT * FROM users WHERE username = ? AND password_hash = ?').bind(cleanPhone, hashedPassword).first();
    
    if (!user) return jsonResponse({ error: 'Nomor HP atau password salah' }, 401);
    if (user.status !== 'active') return jsonResponse({ error: 'Akun dibekukan hubungi admin' }, 403);

    const newToken = crypto.randomUUID();
    await env.DB.prepare('UPDATE users SET auth_token = ? WHERE id = ?').bind(newToken, user.id).run();

    const sub = await env.DB.prepare(`
      SELECT p.*, s.end_date, s.status as sub_status
      FROM user_subscriptions s 
      JOIN plans p ON s.plan_id = p.id 
      WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
    `).bind(user.id).first();

    const balance = await getUserBalance(env, user.id);

    return jsonResponse({ 
        success: true, 
        user: { ...user, balance, username: user.username }, // username is phone now
        plan: sub || null, 
        token: newToken 
    });
  }

  // --- REGISTER (PHONE) ---
  if (type === 'register') {
    const { phone, password, referral_code } = body;
    
    if (!phone || !password) return jsonResponse({ error: 'Data tidak lengkap' }, 400);
    if (password.length < 6) return jsonResponse({ error: 'Password minimal 6 karakter' }, 400);

    // Format Phone Check
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    if (!cleanPhone.startsWith('62') || cleanPhone.length < 10) {
        return jsonResponse({ error: 'Format Nomor HP salah. Harus diawali 62...' }, 400);
    }

    let referrerId = null;
    if (referral_code) {
      const ref = await env.DB.prepare('SELECT id FROM users WHERE referral_code = ?').bind(referral_code).first();
      if (ref) referrerId = ref.id;
    }

    const hashedPassword = await hashPassword(password);
    const myRefCode = 'REF' + Math.random().toString(36).substring(2, 8).toUpperCase();
    const initialToken = crypto.randomUUID();

    try {
      // INSERT: Kolom username diisi Phone, Email dikosongkan (NULL)
      const res = await env.DB.prepare(`
        INSERT INTO users (username, email, password_hash, referral_code, referrer_id, auth_token, role, status) 
        VALUES (?, NULL, ?, ?, ?, ?, 'user', 'active')
      `).bind(cleanPhone, hashedPassword, myRefCode, referrerId, initialToken).run();
      
      const userId = res.meta.last_row_id;
      
      // Paket Trial 3 Hari
      const trialDuration = 3; 
      const end = new Date(); 
      end.setDate(end.getDate() + trialDuration);
      
      await env.DB.prepare(`
        INSERT INTO user_subscriptions (user_id, plan_id, end_date, status) 
        VALUES (?, 1, ?, 'active')
      `).bind(userId, end.toISOString()).run();

      return jsonResponse({ success: true, message: 'Registrasi Berhasil' });

    } catch (e) {
      if (e.message.includes('UNIQUE')) return jsonResponse({ error: 'Nomor HP sudah terdaftar' }, 400);
      return jsonResponse({ error: 'Error: ' + e.message }, 500);
    }
  }

  return jsonResponse({ error: 'Invalid Type' }, 400);
}
