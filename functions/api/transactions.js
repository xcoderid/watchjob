export async function onRequestGet(context) {
  // --- GET: RIWAYAT TRANSAKSI USER ---
  const { request, env } = context;
  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');

  if (!userId) return new Response(JSON.stringify({ error: 'User ID required' }), { status: 400 });

  const transactions = await env.DB.prepare(`
    SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
  `).bind(userId).all();

  return new Response(JSON.stringify(transactions.results));
}

export async function onRequestPost(context) {
  // --- POST: REQUEST DEPOSIT / WITHDRAW ---
  const { request, env } = context;
  const body = await request.json();
  const { user_id, type, amount, method, account_info } = body; 
  // type: 'deposit' | 'withdrawal'

  if (!['deposit', 'withdrawal'].includes(type)) {
    return new Response(JSON.stringify({ error: 'Invalid type' }), { status: 400 });
  }

  if (amount <= 0) return new Response(JSON.stringify({ error: 'Jumlah harus lebih dari 0' }), { status: 400 });

  // Jika Withdrawal, cek saldo dulu
  if (type === 'withdrawal') {
     const balanceResult = await env.DB.prepare(`
        SELECT 
          SUM(CASE WHEN type IN ('deposit', 'income', 'bonus') THEN amount ELSE 0 END) - 
          SUM(CASE WHEN type IN ('withdrawal', 'expense') THEN amount ELSE 0 END) as current_balance
        FROM transactions 
        WHERE user_id = ? AND status = 'success'
      `).bind(user_id).first();
    
     const currentBalance = balanceResult.current_balance || 0;
     if (currentBalance < amount) {
        return new Response(JSON.stringify({ error: 'Saldo tidak mencukupi untuk penarikan.' }), { status: 400 });
     }
  }

  try {
    // Simpan transaksi dengan status 'pending'
    // Admin nanti harus mengubah status jadi 'success' di database/dashboard admin jika uang sudah ditransfer
    
    let desc = '';
    if (type === 'deposit') desc = `Deposit via ${method}`;
    if (type === 'withdrawal') desc = `Withdraw ke ${account_info}`;

    await env.DB.prepare(`
      INSERT INTO transactions (user_id, type, amount, description, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).bind(user_id, type, amount, desc).run();

    return new Response(JSON.stringify({ success: true, message: `${type} berhasil diajukan. Menunggu konfirmasi admin.` }));

  } catch (e) {
    return new Response(JSON.stringify({ error: 'Error: ' + e.message }), { status: 500 });
  }
}
