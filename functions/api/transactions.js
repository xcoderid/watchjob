import { jsonResponse, authenticateUser, getUserBalance } from '../utils';

export async function onRequestGet(context) {
  const { request, env } = context;
  
  const user = await authenticateUser(env, request);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  const transactions = await env.DB.prepare(`SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`).bind(user.id).all();
  return jsonResponse(transactions.results);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  
  const user = await authenticateUser(env, request);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  const body = await request.json();
  const { type, amount, method, account_info } = body; 

  if (!amount || isNaN(amount) || amount <= 0) return jsonResponse({ error: 'Jumlah tidak valid' }, 400);
  
  try {
    if (type === 'withdrawal') {
       const balance = await getUserBalance(env, user.id);
       if (balance < amount) return jsonResponse({ error: 'Saldo tidak mencukupi untuk penarikan.' }, 400);
    }

    let desc = type === 'deposit' ? `Deposit via ${method}` : `Withdraw ke ${account_info}`;
    let status = type === 'deposit' ? 'pending' : 'pending'; // Deposit now defaults to pending for admin check
    
    // Auto-approve deposit demo (Optional: remove in production)
    // if (type === 'deposit') status = 'success'; 

    await env.DB.prepare(`INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, ?, ?, ?, ?)`).bind(user.id, type, amount, desc, status).run();

    return jsonResponse({ success: true, message: `${type === 'deposit' ? 'Deposit' : 'Penarikan'} berhasil diajukan. Menunggu persetujuan Admin.` });

  } catch (e) {
    return jsonResponse({ error: 'Error: ' + e.message }, 500);
  }
}
