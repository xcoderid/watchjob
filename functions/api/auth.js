// functions/api/auth.js

export async function onRequestPost(context) {
  const { request, env } = context;
  
  // Parse body request
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const url = new URL(request.url);
  const type = url.searchParams.get('type'); // ?type=login atau ?type=register

  // --- LOGIN LOGIC ---
  if (type === 'login') {
    const { username, password } = body;

    // Cari user
    const user = await env.DB.prepare('SELECT * FROM users WHERE username = ? AND password_hash = ?')
      .bind(username, password)
      .first();

    if (!user) {
      return new Response(JSON.stringify({ error: 'Username atau password salah' }), { status: 401 });
    }

    // Cari paket aktif
    const subscription = await env.DB.prepare(`
      SELECT p.*, s.end_date 
      FROM user_subscriptions s 
      JOIN plans p ON s.plan_id = p.id 
      WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
    `).bind(user.id).first();

    // Update last login atau aktivitas jika perlu (opsional)

    return new Response(JSON.stringify({
      success: true,
      user: user,
      plan: subscription || null,
      token: 'dummy-token-manual-' + user.id // Sederhana untuk pemula
    }));
  }

  // --- REGISTER LOGIC ---
  if (type === 'register') {
    const { username, email, password, referral_code } = body;

    // Cek Referrer
    let referrerId = null;
    if (referral_code) {
      const referrer = await env.DB.prepare('SELECT id FROM users WHERE referral_code = ?')
        .bind(referral_code)
        .first();
      if (referrer) referrerId = referrer.id;
    }

    // Generate kode referral unik user ini
    const myReferralCode = 'REF-' + Math.random().toString(36).substr(2, 8).toUpperCase();

    try {
      const result = await env.DB.prepare(`
        INSERT INTO users (username, email, password_hash, referral_code, referrer_id)
        VALUES (?, ?, ?, ?, ?)
      `).bind(username, email, password, myReferralCode, referrerId).run();

      // Berikan paket TRIAL otomatis (Plan ID 1)
      const trialDays = 3; // Default
      // Hitung tanggal expired
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + trialDays);
      const endDateStr = endDate.toISOString().replace('T', ' ').split('.')[0]; // Format SQLite

      await env.DB.prepare(`
        INSERT INTO user_subscriptions (user_id, plan_id, end_date, status)
        VALUES (?, ?, ?, 'active')
      `).bind(result.meta.last_row_id, 1, endDateStr).run();

      return new Response(JSON.stringify({ success: true, id: result.meta.last_row_id }));
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Username atau Email sudah terdaftar' }), { status: 400 });
    }
  }

  return new Response(JSON.stringify({ error: 'Invalid type parameter' }), { status: 400 });
}
