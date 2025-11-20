export async function onRequestGet(context) {
  // GET: Mengambil daftar semua plan yang aktif
  const { env } = context;
  const plans = await env.DB.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY price ASC').all();
  return new Response(JSON.stringify(plans.results));
}

export async function onRequestPost(context) {
  // POST: Menangani pembelian paket oleh member
  const { request, env } = context;
  const body = await request.json();
  const { user_id, plan_id } = body;

  const plan = await env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(plan_id).first();
  if (!plan) return new Response(JSON.stringify({ error: 'Plan tidak ditemukan' }), { status: 404 });

  // 1. Cek Saldo User (Menggunakan kolom balance di tabel users)
  const user = await env.DB.prepare('SELECT balance FROM users WHERE id = ?').bind(user_id).first();
  
  if (!user || user.balance < plan.price) {
    return new Response(JSON.stringify({ error: 'Saldo tidak mencukupi.' }), { status: 400 });
  }

  try {
    const now = new Date();
    const endDate = new Date();
    endDate.setDate(now.getDate() + plan.duration_days);
    const endDateStr = endDate.toISOString().replace('T', ' ').split('.')[0];

    // 2. Eksekusi Transaksi Atomic (Batch)
    await env.DB.batch([
      // a. Potong saldo user
      env.DB.prepare(`UPDATE users SET balance = balance - ? WHERE id = ?`).bind(plan.price, user_id),
      
      // b. Log pengeluaran
      env.DB.prepare(`INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'expense', ?, ?, 'success')`)
        .bind(user_id, plan.price, `Beli Paket: ${plan.name}`),
      
      // c. Nonaktifkan plan lama (Jika ada)
      env.DB.prepare(`UPDATE user_subscriptions SET status = 'expired' WHERE user_id = ? AND status = 'active'`).bind(user_id),
      
      // d. Aktifkan plan baru
      env.DB.prepare(`INSERT INTO user_subscriptions (user_id, plan_id, end_date, status) VALUES (?, ?, ?, 'active')`)
        .bind(user_id, plan_id, endDateStr)
    ]);

    return new Response(JSON.stringify({ success: true, message: `Paket ${plan.name} aktif!` }));

  } catch (e) {
    return new Response(JSON.stringify({ error: 'Error: ' + e.message }), { status: 500 });
  }
}
