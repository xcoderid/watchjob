export async function onRequestGet(context) {
  // --- GET: AMBIL DAFTAR PLAN (PUBLIC) ---
  const { env } = context;
  
  // Ambil hanya plan yang aktif
  const plans = await env.DB.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY price ASC').all();
  return new Response(JSON.stringify(plans.results));
}

export async function onRequestPost(context) {
  // --- POST: BELI PAKET (BUY PLAN) ---
  const { request, env } = context;
  const body = await request.json();
  const { user_id, plan_id } = body;

  if (!user_id || !plan_id) return new Response(JSON.stringify({ error: 'Data tidak lengkap' }), { status: 400 });

  // 1. Ambil Detail Plan
  const plan = await env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(plan_id).first();
  if (!plan) return new Response(JSON.stringify({ error: 'Plan tidak ditemukan' }), { status: 404 });

  // 2. Hitung Saldo User Saat Ini
  // (Income + Deposit - Withdraw - Expense/Buy)
  const balanceResult = await env.DB.prepare(`
    SELECT 
      SUM(CASE WHEN type IN ('deposit', 'income', 'bonus') THEN amount ELSE 0 END) - 
      SUM(CASE WHEN type IN ('withdrawal', 'expense') THEN amount ELSE 0 END) as current_balance
    FROM transactions 
    WHERE user_id = ? AND status = 'success'
  `).bind(user_id).first();

  const currentBalance = balanceResult.current_balance || 0;

  // 3. Cek Cukup Saldo?
  if (currentBalance < plan.price) {
    return new Response(JSON.stringify({ error: 'Saldo tidak mencukupi. Silakan deposit.' }), { status: 400 });
  }

  // 4. Cek Apakah Sedang Ada Paket Aktif? (Opsional: bisa ditumpuk atau harus nunggu habis)
  // Di sini kita buat logika: Jika beli baru, paket lama hangus/diganti.
  
  try {
    // Mulai Batch Transaksi
    const now = new Date();
    const endDate = new Date();
    endDate.setDate(now.getDate() + plan.duration_days);
    const endDateStr = endDate.toISOString().replace('T', ' ').split('.')[0];

    await env.DB.batch([
      // a. Potong Saldo (Catat sebagai 'expense')
      env.DB.prepare(`
        INSERT INTO transactions (user_id, type, amount, description, status) 
        VALUES (?, 'expense', ?, ?, 'success')
      `).bind(user_id, plan.price, `Beli Paket: ${plan.name}`),

      // b. Nonaktifkan paket lama (jika ada)
      env.DB.prepare(`
        UPDATE user_subscriptions SET status = 'expired' WHERE user_id = ? AND status = 'active'
      `).bind(user_id),

      // c. Insert Paket Baru
      env.DB.prepare(`
        INSERT INTO user_subscriptions (user_id, plan_id, end_date, status) 
        VALUES (?, ?, ?, 'active')
      `).bind(user_id, plan_id, endDateStr)
    ]);

    return new Response(JSON.stringify({ success: true, message: `Berhasil membeli paket ${plan.name}` }));

  } catch (e) {
    return new Response(JSON.stringify({ error: 'Database Error: ' + e.message }), { status: 500 });
  }
}
