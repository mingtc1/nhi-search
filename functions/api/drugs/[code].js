/**
 * GET /api/drugs/:code
 * 依藥品代號取得單筆完整藥品資料
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
};

export async function onRequestGet({ params, env }) {
  const code = params.code;

  try {
    const result = await env.DB.prepare(
      `SELECT * FROM nhi_drugs WHERE 藥品代號 = ? LIMIT 1`
    ).bind(code).first();

    if (!result) {
      return new Response(JSON.stringify({ error: '找不到該藥品代號' }), {
        status: 404,
        headers: CORS_HEADERS,
      });
    }

    return new Response(JSON.stringify({ data: result }), {
      headers: CORS_HEADERS,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: CORS_HEADERS,
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
