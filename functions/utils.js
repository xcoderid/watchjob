export const jsonResponse = (data, status = 200) => {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
};

export const getYoutubeId = (url) => {
  if (!url) return null;
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
};

export const getUserBalance = async (env, userId) => {
  const query = `
    SELECT SUM(
      CASE 
        WHEN type IN ('deposit', 'income', 'commission') AND status = 'success' THEN amount 
        WHEN type IN ('expense') AND status = 'success' THEN -amount
        WHEN type IN ('withdrawal') AND status IN ('success', 'pending') THEN -amount
        ELSE 0 
      END
    ) as balance FROM transactions WHERE user_id = ?
  `;
  const result = await env.DB.prepare(query).bind(userId).first();
  return result.balance || 0;
};
