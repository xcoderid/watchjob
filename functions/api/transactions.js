import { jsonResponse, getUserBalance } from '../utils';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');

  if (!userId) return jsonResponse({ error: 'User ID required' }, 400);

  const transactions = await env.DB.prepare(`SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`).bind(userId).all();
  return jsonResponse(transactions.results);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json();
  const { user_id, type, amount, method, account_info } = body; 

  if (amount <= 0) return jsonResponse({ error: 'Jumlah harus > 0' }, 400);
  
  // Cek Saldo via Helper jika Withdrawal
  if (type === 'withdrawal') {
     const balance = await getUserBalance(env, user_id);
     if (balance < amount) return jsonResponse({ error: 'Saldo tidak mencukupi.' }, 400);
  }

  try {
    let desc = type === 'deposit' ? `Deposit via ${method}` : `Withdraw ke ${account_info}`;
    let status = type === 'deposit' ? 'success' : 'pending'; // Deposit auto-success (simulasi)
    
    // HANYA Insert Transaksi. Tidak ada UPDATE users.
    await env.DB.prepare(`INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, ?, ?, ?, ?)`).bind(user_id, type, amount, desc, status).run();

    return jsonResponse({ success: true, message: `${type} berhasil diajukan.` });

  } catch (e) {
    return jsonResponse({ error: 'Error: ' + e.message }, 500);
  }
}
