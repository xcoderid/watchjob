import { jsonResponse, getUserBalance } from '../utils';

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json();
  const url = new URL(request.url);
  const type = url.searchParams.get('type');

  if (type === 'login') {
    const { username, password } = body;
    const user = await env.DB.prepare('SELECT * FROM users WHERE username = ? AND password_hash = ?').bind(username, password).first();
    if (!user) return jsonResponse({ error: 'Akun tidak ditemukan atau password salah' }, 401);
    if (user.status !== 'active') return jsonResponse({ error: 'Akun dinonaktifkan' }, 403);

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
        token: `tok_${user.id}` 
    });
  }

  if (type === 'register') {
    const { username, email, password, referral_code } = body;
    let referrerId = null;
    
    if (referral_code) {
      const ref = await env.DB.prepare('SELECT id FROM users WHERE referral_code = ?').bind(referral_code).first();
      if (ref) referrerId = ref.id;
    }

    const myRefCode = 'REF' + Math.random().toString(36).substring(2, 8).toUpperCase();
    try {
      const res = await env.DB.prepare(`INSERT INTO users (username, email, password_hash, referral_code, referrer_id) VALUES (?, ?, ?, ?, ?)`).bind(username, email, password, myRefCode, referrerId).run();
      const userId = res.meta.last_row_id;
      
      const trial = await env.DB.prepare('SELECT id, duration_days FROM plans WHERE id = 1').first();
      if (trial) {
          const end = new Date(); end.setDate(end.getDate() + trial.duration_days);
          await env.DB.prepare(`INSERT INTO user_subscriptions (user_id, plan_id, end_date) VALUES (?, ?, ?)`).bind(userId, trial.id, end.toISOString()).run();
      }
      return jsonResponse({ success: true });
    } catch (e) {
      return jsonResponse({ error: 'Username/Email sudah terdaftar' }, 400);
    }
  }
  return jsonResponse({ error: 'Invalid type' }, 400);
}
