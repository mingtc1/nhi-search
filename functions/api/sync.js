/**
 * GET /api/sync
 * 回傳最後資料更新時間與總筆數
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json; charset=utf-8',
};

export async function onRequestGet({ env }) {
  try {
    const log = await env.DB.prepare(
      `SELECT sync_time, total_records FROM sync_logs ORDER BY id DESC LIMIT 1`
    ).first();

    const countResult = await env.DB.prepare(
      `SELECT COUNT(*) as total FROM nhi_drugs`
    ).first();

    return new Response(JSON.stringify({
      sync_time: log?.sync_time ?? null,
      total_records: log?.total_records ?? countResult?.total ?? 0,
    }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, sync_time: null, total_records: 0 }), {
      status: 500, headers: CORS_HEADERS,
    });
  }
}
