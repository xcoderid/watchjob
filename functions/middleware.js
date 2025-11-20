import { jsonResponse } from './utils';

export async function onRequest(context) {
  const { request, next } = context;
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }
  try {
    const response = await next();
    response.headers.set('Access-Control-Allow-Origin', '*');
    return response;
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}
