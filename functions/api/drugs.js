/**
 * GET /api/drugs
 * 多條件複合搜尋健保藥品，支援無限捲動
 * 
 * QueryString 參數:
 *   q            - 全文關鍵字 (中文名/英文名/成分/代號/許可字號)
 *   成分          - 成分 LIKE 比對
 *   劑型          - 精確比對
 *   藥品分類       - 精確比對
 *   分類分組名稱   - 精確比對
 *   單複方         - 精確比對 (單方/複方)
 *   ATC代碼        - LIKE 前綴比對
 *   支付價_min     - 支付價下限
 *   支付價_max     - 支付價上限
 *   page           - 第幾批 (預設 1，每批 100 筆)
 */

const PAGE_SIZE = 100;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
};

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const p = url.searchParams;

  const q = p.get('q') || '';
  const 成分 = p.get('成分') || '';
  const 劑型 = p.get('劑型') || '';
  const 藥品分類 = p.get('藥品分類') || '';
  const 分類分組 = p.get('分類分組名稱') || '';
  const 單複方 = p.get('單複方') || '';
  const ATC = p.get('ATC代碼') || '';
  const 支付價min = parseFloat(p.get('支付價_min') || '');
  const 支付價max = parseFloat(p.get('支付價_max') || '');
  const page = Math.max(1, parseInt(p.get('page') || '1'));
  const offset = (page - 1) * PAGE_SIZE;

  const sortBy = p.get('sort_by') || '';
  const order = (p.get('order') || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const exportCsv = p.get('export') === 'csv';

  const validSortColumns = ['藥品代號', '藥品中文名稱', '成分', '劑型', 'ATC代碼', '支付價'];
  let orderByClause = 'ORDER BY 藥品代號 ASC';
  if (validSortColumns.includes(sortBy)) {
    if (sortBy === '支付價') {
      orderByClause = `ORDER BY CAST(支付價 AS REAL) ${order}, 藥品代號 ASC`;
    } else {
      orderByClause = `ORDER BY "${sortBy}" ${order}, 藥品代號 ASC`;
    }
  }

  const conditions = [];
  const params = [];

  // 全文關鍵字 (OR 展開)
  if (q) {
    const kw = `%${q}%`;
    conditions.push(`(藥品中文名稱 LIKE ? OR 藥品英文名稱 LIKE ? OR 成分 LIKE ? OR 藥品代號 LIKE ? OR 許可證字號 LIKE ?)`);
    params.push(kw, kw, kw, kw, kw);
  }

  // 精確/模糊 AND 條件
  // 支援逗號分隔的多成分查詢：每個成分都必須 LIKE 匹配
  if (成分) {
    const ingredients = 成分.split(',').map(s => s.trim()).filter(Boolean);
    ingredients.forEach(ing => {
      conditions.push(`成分 LIKE ?`);
      params.push(`%${ing}%`);
    });
  }
  if (劑型) { conditions.push(`劑型 = ?`); params.push(劑型); }
  if (藥品分類) { conditions.push(`藥品分類 = ?`); params.push(藥品分類); }
  if (分類分組) { conditions.push(`分類分組名稱 = ?`); params.push(分類分組); }
  if (單複方) { conditions.push(`單複方 = ?`); params.push(單複方); }
  if (ATC) { conditions.push(`ATC代碼 LIKE ?`); params.push(`${ATC}%`); }
  if (!isNaN(支付價min)) { conditions.push(`CAST(支付價 AS REAL) >= ?`); params.push(支付價min); }
  if (!isNaN(支付價max)) { conditions.push(`CAST(支付價 AS REAL) <= ?`); params.push(支付價max); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    // 匯出 CSV 模式
    if (exportCsv) {
      const dataResult = await env.DB.prepare(
        `SELECT * FROM nhi_drugs ${where} ${orderByClause}`
      ).bind(...params).all();

      const rows = dataResult.results;
      if (rows.length === 0) {
        return new Response('\uFEFF無搜尋結果', {
          headers: { ...CORS_HEADERS, 'Content-Type': 'text/csv; charset=utf-8' }
        });
      }

      // 產生 CSV
      const headers = Object.keys(rows[0]);
      let csvContent = '\uFEFF' + headers.join(',') + '\n';
      
      for (const r of rows) {
        const rowData = headers.map(k => {
          let val = r[k] === null || r[k] === undefined ? '' : String(r[k]);
          val = val.replace(/"/g, '""'); // CSV 跳脫雙引號
          return `"${val}"`;
        });
        csvContent += rowData.join(',') + '\n';
      }

      const dateStr = new Date().toISOString().split('T')[0];
      return new Response(csvContent, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="nhi_drugs_export_${dateStr}.csv"`
        }
      });
    }

    // 計算總筆數 (僅非匯出模式需要)
    const countResult = await env.DB.prepare(
      `SELECT COUNT(*) as total FROM nhi_drugs ${where}`
    ).bind(...params).first();

    const total = countResult?.total ?? 0;

    // 一般分頁查詢
    const dataResult = await env.DB.prepare(
      `SELECT * FROM nhi_drugs ${where} ${orderByClause} LIMIT ? OFFSET ?`
    ).bind(...params, PAGE_SIZE, offset).all();

    return new Response(JSON.stringify({
      data: dataResult.results,
      total,
      page,
      page_size: PAGE_SIZE,
      has_more: offset + dataResult.results.length < total,
    }), { headers: CORS_HEADERS });

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
