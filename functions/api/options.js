/**
 * GET /api/options
 * 回傳各篩選下拉選項的去重列表
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json; charset=utf-8',
};

export async function onRequestGet({ env }) {
  try {
    const [劑型結果, 分類結果, 分組結果, 複方結果] = await Promise.all([
      env.DB.prepare(`SELECT DISTINCT 劑型 FROM nhi_drugs WHERE 劑型 != '' ORDER BY 劑型`).all(),
      env.DB.prepare(`SELECT DISTINCT 藥品分類 FROM nhi_drugs WHERE 藥品分類 != '' ORDER BY 藥品分類`).all(),
      env.DB.prepare(`SELECT DISTINCT 分類分組名稱 FROM nhi_drugs WHERE 分類分組名稱 != '' ORDER BY 分類分組名稱`).all(),
      env.DB.prepare(`SELECT DISTINCT 單複方 FROM nhi_drugs WHERE 單複方 != '' ORDER BY 單複方`).all(),
    ]);

    return new Response(JSON.stringify({
      劑型: 劑型結果.results.map(r => r['劑型']),
      藥品分類: 分類結果.results.map(r => r['藥品分類']),
      分類分組名稱: 分組結果.results.map(r => r['分類分組名稱']),
      單複方: 複方結果.results.map(r => r['單複方']),
    }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: CORS_HEADERS,
    });
  }
}
