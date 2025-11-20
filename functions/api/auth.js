export async function onRequestPost(context) {
  const { request, env } = context;
  
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const url = new URL(request.url);
  const type = url.searchParams.get('type');

  // --- LOGIN LOGIC ---
  if (type === 'login') {
    const { username, password } = body;

    // 1. Cek User (Gunakan password_hash sesuai schema)
    const user = await env.DB.prepare('SELECT * FROM users WHERE username = ? AND password_hash = ?')
      .bind(username, password)
      .first();

    if (!user) {
      return new Response(JSON.stringify({ error: 'Username atau password salah' }), { status: 401 });
    }

    // 2. Cari paket aktif (Table: user_subscriptions)
    const subscription = await env.DB.prepare(`
      SELECT p.*, s.end_date, s.status as sub_status
      FROM user_subscriptions s 
      JOIN plans p ON s.plan_id = p.id 
      WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
    `).bind(user.id).first();

    return new Response(JSON.stringify({
      success: true,
      user: user,
      plan: subscription || null,
      token: 'token-' + user.id // Simulasi token
    }));
  }

  // --- REGISTER LOGIC ---
  if (type === 'register') {
    const { username, email, password, referral_code } = body;

    // 1. Cek Upline/Referrer
    let referrerId = null;
    if (referral_code) {
      const referrer = await env.DB.prepare('SELECT id FROM users WHERE referral_code = ?')
        .bind(referral_code)
        .first();
      if (referrer) referrerId = referrer.id;
    }

    // 2. Generate Referral Code Unik
    const myReferralCode = 'REF-' + Math.random().toString(36).substr(2, 8).toUpperCase();

    try {
      // Insert User Baru (Table: users)
      const result = await env.DB.prepare(`
        INSERT INTO users (username, email, password_hash, referral_code, referrer_id, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).bind(username, email, password, myReferralCode, referrerId).run();

      const newUserId = result.meta.last_row_id;

      // 3. Berikan Paket TRIAL (Plan ID 1)
      // Asumsi Plan ID 1 selalu ada sebagai Trial
      const trialPlan = await env.DB.prepare('SELECT duration_days FROM plans WHERE id = 1').first();
      const duration = trialPlan ? trialPlan.duration_days : 3;

      const endDate = new Date();
      endDate.setDate(endDate.getDate() + duration);
      const endDateStr = endDate.toISOString().replace('T', ' ').split('.')[0];

      // Insert Subscription (Table: user_subscriptions)
      await env.DB.prepare(`
        INSERT INTO user_subscriptions (user_id, plan_id, end_date, status)
        VALUES (?, 1, ?, 'active')
      `).bind(newUserId, endDateStr).run();

      return new Response(JSON.stringify({ success: true, id: newUserId }));
    } catch (e) {
      // Error biasanya karena email/username/ref_code duplicate
      return new Response(JSON.stringify({ error: 'Registrasi gagal. Email mungkin sudah terdaftar.' }), { status: 400 });
    }
  }

  return new Response(JSON.stringify({ error: 'Invalid type parameter' }), { status: 400 });
}
