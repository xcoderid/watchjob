export async function onRequestGet(context) {
  // GET: Mengambil riwayat transaksi user
  const { request, env } = context;
  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');

  if (!userId) return new Response(JSON.stringify({ error: 'User ID required' }), { status: 400 });

  const transactions = await env.DB.prepare(`SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`).bind(userId).all();
  return new Response(JSON.stringify(transactions.results));
}

export async function onRequestPost(context) {
  // POST: Mengajukan Deposit atau Withdrawal
  const { request, env } = context;
  const body = await request.json();
  const { user_id, type, amount, method, account_info } = body; 

  if (amount <= 0) return new Response(JSON.stringify({ error: 'Jumlah harus > 0' }), { status: 400 });
  
  // Periksa Saldo untuk Withdrawal
  if (type === 'withdrawal') {
     const user = await env.DB.prepare('SELECT balance FROM users WHERE id = ?').bind(user_id).first();
     if (!user || user.balance < amount) {
        return new Response(JSON.stringify({ error: 'Saldo tidak mencukupi.' }), { status: 400 });
     }
  }

  try {
    let desc = type === 'deposit' ? `Deposit via ${method}` : `Withdraw ke ${account_info}`;
    const batchOps = [];

    if (type === 'deposit') {
        // Deposit (Auto-Success dan langsung menambah balance untuk simulasi)
        batchOps.push( env.DB.prepare(`INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, ?, ?, ?, 'success')`).bind(user_id, type, amount, desc) );
        batchOps.push( env.DB.prepare(`UPDATE users SET balance = balance + ? WHERE id = ?`).bind(amount, user_id) );
    } else {
        // Withdraw (Status Pending, saldo langsung dikurangi/di-hold)
        batchOps.push( env.DB.prepare(`INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, ?, ?, ?, 'pending')`).bind(user_id, type, amount, desc) );
        batchOps.push( env.DB.prepare(`UPDATE users SET balance = balance - ? WHERE id = ?`).bind(amount, user_id) );
    }

    await env.DB.batch(batchOps);
    return new Response(JSON.stringify({ success: true, message: `${type} berhasil diajukan.` }));

  } catch (e) {
    return new Response(JSON.stringify({ error: 'Error: ' + e.message }), { status: 500 });
  }
}
