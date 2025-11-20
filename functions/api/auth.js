import { jsonResponse, hashPassword, getUserBalance } from '../utils';

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json();
  const url = new URL(request.url);
  const type = url.searchParams.get('type');

  if (type === 'login') {
    const { username, password } = body;
    if (!username || !password) return jsonResponse({ error: 'Data tidak lengkap' }, 400);

    const hashedPassword = await hashPassword(password);
    
    // Update query to use hashed password
    const user = await env.DB.prepare('SELECT * FROM users WHERE username = ? AND password_hash = ?').bind(username, hashedPassword).first();
    
    if (!user) return jsonResponse({ error: 'Username atau password salah' }, 401);
    if (user.status !== 'active') return jsonResponse({ error: 'Akun telah dibekukan' }, 403);

    // Generate Secure Token (UUID)
    const newToken = crypto.randomUUID();
    await env.DB.prepare('UPDATE users SET auth_token = ? WHERE id = ?').bind(newToken, user.id).run();

    const sub = await env.DB.prepare(`
      SELECT p.*, s.end_date FROM user_subscriptions s 
      JOIN plans p ON s.plan_id = p.id 
      WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
    `).bind(user.id).first();

    const balance = await getUserBalance(env, user.id);

    return jsonResponse({ 
        success: true, 
        user: { ...user, balance }, 
        plan: sub || null, 
        token: newToken // Return UUID token
    });
  }

  if (type === 'register') {
    const { username, email, password, referral_code } = body;
    
    if (!username || !email || !password || password.length < 6) {
        return jsonResponse({ error: 'Data tidak valid. Password min 6 karakter.' }, 400);
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
      const res = await env.DB.prepare(`
        INSERT INTO users (username, email, password_hash, referral_code, referrer_id, auth_token, role, status) 
        VALUES (?, ?, ?, ?, ?, ?, 'user', 'active')
      `).bind(username, email, hashedPassword, myRefCode, referrerId, initialToken).run();
      
      const userId = res.meta.last_row_id;
      
      // Assign Free/Trial Plan (ID 1)
      const trial = await env.DB.prepare('SELECT id, duration_days FROM plans WHERE id = 1').first();
      if (trial) {
          const end = new Date(); 
          end.setDate(end.getDate() + trial.duration_days);
          await env.DB.prepare(`INSERT INTO user_subscriptions (user_id, plan_id, end_date, status) VALUES (?, ?, ?, 'active')`).bind(userId, trial.id, end.toISOString()).run();
      }

      return jsonResponse({ success: true, message: 'Registrasi Berhasil' });
    } catch (e) {
      // Check constraint violation (Unique Username/Email)
      return jsonResponse({ error: 'Username atau Email sudah terdaftar' }, 400);
    }
  }

  return jsonResponse({ error: 'Invalid Action' }, 400);
}
