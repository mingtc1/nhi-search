/**
 * GET /api/substitutes/summary?drug_id=XXXX&atc_depth=5
 *
 * ── Level 定義（不重疊設計，以 ATC 7 碼辨識成分）──────────────────
 * L1: 同「分類分組名稱」（健保官方同組，含同成分/同劑型/同劑量）
 * L2: ATC 完整 7 碼相同 + 同劑型 + 排除 L1（等於：同成分同劑型，但不同劑量）
 * L3: ATC 完整 7 碼相同 + 不同劑型 + 排除 L1（等於：同成分，不同劑型）
 * L4: ATC 前 N 碼相同但 7 碼不同 + 排除 L1（等於：不同成分，同藥理分類）
 *
 * 注意：「成分」欄位在健保資料庫中包含劑量（如 "DIAZEPAM 5 MG"），
 *       故不可用字串比對來判斷「同成分」，改用 ATC 7 碼作為成分識別子。
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

/** 排除 L1 的通用片段（分類分組名稱不同） */
function excludeL1Clause() {
  return `("分類分組名稱" IS NULL OR "分類分組名稱" = '' OR "分類分組名稱" != ?)`;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  const t0 = Date.now();
  const { searchParams } = new URL(request.url);
  const drug_id   = (searchParams.get('drug_id') || '').trim();
  const atc_depth = Math.min(5, Math.max(3, parseInt(searchParams.get('atc_depth') || '5')));

  if (!drug_id) return json({ error: '缺少必要參數 drug_id' }, 400);

  try {
    // ── 1. 取得原藥品資料 ────────────────────────────────────────
    const target = await env.DB.prepare(
      `SELECT * FROM nhi_drugs WHERE "藥品代號" = ? LIMIT 1`
    ).bind(drug_id).first();

    if (!target) return json({ error: `找不到藥品代號 ${drug_id}` }, 404);

    const groupName = target['分類分組名稱'] || '';
    const form      = target['劑型'] || '';
    const atc       = (target['ATC代碼'] || '').trim();
    const atcFull   = atc;                        // 完整 7 碼（識別同成分）
    const atcPrefix = atc.slice(0, atc_depth);    // 前 N 碼（識別同藥理類別）

    // ── 2. 各 Level 候選數量 ────────────────────────────────────
    const [l1Row, l2Row, l3Row, l4Row] = await Promise.all([

      // L1: 同分類分組名稱（排除自身）
      groupName
        ? env.DB.prepare(
            `SELECT COUNT(*) AS c FROM nhi_drugs
             WHERE "分類分組名稱" = ? AND "藥品代號" != ?`
          ).bind(groupName, drug_id).first()
        : Promise.resolve({ c: 0 }),

      // L2: ATC 7 碼相同 + 同劑型 + 排除 L1
      (atcFull && form)
        ? env.DB.prepare(
            `SELECT COUNT(*) AS c FROM nhi_drugs
             WHERE "ATC代碼" = ?
               AND "劑型" = ?
               AND "藥品代號" != ?
               AND ${excludeL1Clause()}`
          ).bind(atcFull, form, drug_id, groupName).first()
        : Promise.resolve({ c: 0 }),

      // L3: ATC 7 碼相同 + 不同劑型 + 排除 L1
      atcFull
        ? env.DB.prepare(
            `SELECT COUNT(*) AS c FROM nhi_drugs
             WHERE "ATC代碼" = ?
               AND "劑型" != ?
               AND "藥品代號" != ?
               AND ${excludeL1Clause()}`
          ).bind(atcFull, form, drug_id, groupName).first()
        : Promise.resolve({ c: 0 }),

      // L4: ATC 前 N 碼相同但 7 碼不同（不同成分）+ 排除 L1
      atcPrefix
        ? env.DB.prepare(
            `SELECT COUNT(*) AS c FROM nhi_drugs
             WHERE "ATC代碼" LIKE ?
               AND "ATC代碼" != ?
               AND "藥品代號" != ?
               AND ${excludeL1Clause()}`
          ).bind(`${atcPrefix}%`, atcFull, drug_id, groupName).first()
        : Promise.resolve({ c: 0 }),
    ]);

    const responseMs = Date.now() - t0;

    return json({
      target,
      levels: {
        level1: {
          count: l1Row?.c ?? 0,
          label: '健保同分組候選',
          definition: '同「分類分組名稱」（健保官方同組，通常含同成分、同劑型、同劑量）',
          warning: '依健保分類分組產生，請確認適應症、給付條件與院內供應狀態。',
        },
        level2: {
          count: l2Row?.c ?? 0,
          label: '同成分同劑型異劑量候選',
          definition: `ATC ${atcFull ? atcFull : '—'} 相同，劑型相同，劑量不同；已排除 Level 1`,
          warning: '含量規格不同，使用前請確認劑量換算與給付條件。',
        },
        level3: {
          count: l3Row?.c ?? 0,
          label: '同成分異劑型候選',
          definition: `ATC ${atcFull ? atcFull : '—'} 相同，劑型不同；已排除 Level 1`,
          warning: '劑型不同，請確認給藥途徑、釋放特性與臨床可替代性。',
        },
        level4: {
          count: l4Row?.c ?? 0,
          label: `同ATC${atc_depth}碼類別候選`,
          definition: `ATC 前 ${atc_depth} 碼（${atcPrefix || '—'}）相同，但活性成分不同；已排除 Level 1`,
          warning: '不同成分，僅供治療替代參考。請重新評估適應症、劑量、禁忌、交互作用與健保給付條件。',
          atc_depth,
        },
      },
      meta: {
        has_group_name: !!groupName,
        has_atc: !!atc,
        atc_full: atcFull,
        atc_depth,
        api_response_time_ms: responseMs,
      }
    });

  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
