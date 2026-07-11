/**
 * GET /api/substitutes/compare?target_id=XXXX&candidate_ids=A,B,C
 *
 * 針對使用者選取的 2~5 個候選品項，產生並排比較表資料。
 * 同時寫入 query_logs 紀錄（供研究效益評估）。
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

const LEVEL_META = {
  1: { label: '健保同分組候選',    reason: '分類分組名稱相同' },
  2: { label: '同成分同劑型候選',  reason: '成分與劑型相同' },
  3: { label: '同成分不同劑型候選', reason: '成分相同，劑型不同' },
  4: { label: '同ATC類別候選',     reason: '同ATC藥理分類，不同成分' },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * 判斷候選品項屬於哪個 Level（相對於目標藥品）
 */
function detectLevel(target, candidate) {
  const tGroup = target['分類分組名稱'] || '';
  const cGroup = candidate['分類分組名稱'] || '';

  if (tGroup && tGroup === cGroup) return 1;

  // 解析三段結構
  const tParts = tGroup.split(/[，,]/).map(s => s.trim());
  const tIng   = tParts[0] || '';
  const tStdForm = tParts.length >= 2 ? tParts[1] : '';

  const cParts = cGroup.split(/[，,]/).map(s => s.trim());
  const cIng   = cParts[0] || '';
  const cStdForm = cParts.length >= 2 ? cParts[1] : '';

  if (tIng && cIng === tIng && tStdForm && cStdForm === tStdForm) return 2;
  if (tIng && cIng === tIng && tStdForm && cStdForm !== tStdForm) return 3;

  const tAtc = (target['ATC代碼'] || '').trim();
  const cAtc = (candidate['ATC代碼'] || '').trim();
  if (tAtc && cAtc && tAtc.slice(0, 5) === cAtc.slice(0, 5) && tIng !== cIng) return 4;

  return null; // 無法歸類
}

export async function onRequestGet({ request, env }) {
  const t0 = Date.now();
  const { searchParams } = new URL(request.url);

  const target_id      = (searchParams.get('target_id') || '').trim();
  const candidateParam = (searchParams.get('candidate_ids') || '').trim();

  if (!target_id) return json({ error: '缺少必要參數 target_id' }, 400);
  if (!candidateParam) return json({ error: '缺少必要參數 candidate_ids' }, 400);

  const candidate_ids = candidateParam.split(',').map(s => s.trim()).filter(Boolean);

  if (candidate_ids.length < 2) {
    return json({ error: '至少需要選取 2 個候選品項才能產生比較表' }, 400);
  }
  if (candidate_ids.length > 5) {
    return json({
      error: '比較品項過多會降低判讀效率，請先使用篩選功能縮小候選範圍，最多選擇 5 個品項進行比較。'
    }, 400);
  }

  try {
    // ── 取得原藥品資料 ────────────────────────────────────────────
    const target = await env.DB.prepare(
      `SELECT * FROM nhi_drugs WHERE "藥品代號" = ? LIMIT 1`
    ).bind(target_id).first();

    if (!target) return json({ error: `找不到目標藥品 ${target_id}` }, 404);

    // ── 取得所有候選品項資料 ──────────────────────────────────────
    const placeholders = candidate_ids.map(() => '?').join(', ');
    const candidatesRes = await env.DB.prepare(
      `SELECT * FROM nhi_drugs WHERE "藥品代號" IN (${placeholders})`
    ).bind(...candidate_ids).all();

    const candidatesMap = {};
    (candidatesRes.results || []).forEach(r => {
      candidatesMap[r['藥品代號']] = r;
    });

    // ── 依原始選取順序組裝候選清單，附加 level 資訊 ──────────────
    const candidates = candidate_ids.map(id => {
      const drug = candidatesMap[id];
      if (!drug) return null;
      const level = detectLevel(target, drug);
      const meta  = LEVEL_META[level] || { label: '其他', reason: '無法判斷關聯' };
      const isLevel4 = level === 4;
      return {
        ...drug,
        level,
        level_label: meta.label,
        reason: meta.reason,
        warning: isLevel4
          ? '此品項為不同成分之同ATC類別候選，僅供治療替代方向參考，不代表可直接替代。'
          : (level === 3 ? '劑型不同，請確認給藥途徑、釋放特性與臨床可替代性。'
           : level === 2 ? '規格或含量可能不同，請確認是否需劑量換算。'
           : '依健保分類分組產生，請確認適應症、給付條件與院內供應狀態。'),
      };
    }).filter(Boolean);

    const responseMs = Date.now() - t0;

    // ── 寫入 query_logs (非同步，不阻塞回應) ─────────────────────
    const groupName = target['分類分組名稱'] || '';
    const atc       = target['ATC代碼'] || '';
    env.DB.prepare(`
      INSERT INTO query_logs
        (target_drug_id, has_group_name, has_atc,
         compare_generated, compare_candidate_count,
         candidates_with_license, candidates_with_reimbursement,
         api_response_time_ms)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?)
    `).bind(
      target_id,
      groupName ? 1 : 0,
      atc ? 1 : 0,
      candidates.length,
      candidates.filter(c => c['許可證字號']).length,
      candidates.filter(c => c['給付規定章節連結']).length,
      responseMs,
    ).run().catch(() => {}); // 靜默失敗，不影響主要回應

    return json({
      target: {
        ...target,
        level: 0,
        level_label: '目標藥品（原藥）',
        reason: '',
        warning: '',
      },
      candidates,
      meta: { api_response_time_ms: responseMs },
    });

  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
