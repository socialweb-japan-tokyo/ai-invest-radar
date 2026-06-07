// メモリキャッシュ（関数の再利用中は保持される）
let companiesCache = null;
let companiesCacheTime = 0;
const CACHE_DURATION = 1000 * 60 * 60 * 24; // 24時間

async function fetchCompanies(apiKey) {
  const now = Date.now();
  if (companiesCache && (now - companiesCacheTime) < CACHE_DURATION) {
    return companiesCache;
  }
  const res = await fetch("https://api.jquants.com/v2/equities/master", {
    headers: { "x-api-key": apiKey }
  });
  const json = await res.json();
  companiesCache = json.data || [];
  companiesCacheTime = now;
  return companiesCache;
}

function resolveCode(query, companies) {
  const q = query.trim();
  // 数字だけなら証券コード扱い
  if (/^\d{4,5}$/.test(q)) {
    return q.length === 4 ? q + "0" : q;
  }
  // 完全一致を優先
  const exact = companies.find(c => c.CoName === q || c.CoNameEn === q);
  if (exact) return exact.Code;
  // 前方一致
  const startsWith = companies.find(c => c.CoName && c.CoName.startsWith(q));
  if (startsWith) return startsWith.Code;
  // 部分一致
  const partial = companies.find(c => c.CoName && c.CoName.includes(q));
  if (partial) return partial.Code;
  // 英語名で部分一致
  const enPartial = companies.find(c => c.CoNameEn && c.CoNameEn.toLowerCase().includes(q.toLowerCase()));
  if (enPartial) return enPartial.Code;
  return null;
}

module.exports = async (req, res) => {
  try {
    const apiKey = process.env.JQUANTS_API_KEY;
    const headers = { "x-api-key": apiKey };

    // 銘柄リクエストに対応: ?list=1 を渡されたら銘柄一覧を返す
    if (req.query.list) {
      const companies = await fetchCompanies(apiKey);
      const slim = companies.map(c => ({
        code: c.Code, name: c.CoName, nameEn: c.CoNameEn, market: c.MktNm
      }));
      return res.status(200).json({ companies: slim });
    }

    // 通常の分析リクエスト
    const query = (req.query.q || req.query.code || "トヨタ自動車").toString();
    let code = null;
    let resolvedName = null;

    if (/^\d{4,5}$/.test(query.trim())) {
      code = query.trim().length === 4 ? query.trim() + "0" : query.trim();
    } else {
      const companies = await fetchCompanies(apiKey);
      code = resolveCode(query, companies);
      if (code) {
        const found = companies.find(c => c.Code === code);
        if (found) resolvedName = found.CoName;
      }
    }

    if (!code) {
      return res.status(404).json({ error: "企業が見つかりませんでした: " + query });
    }

    const finRes = await fetch("https://api.jquants.com/v2/fins/summary?code=" + code, { headers });
    const finJson = await finRes.json();
    const priceRes = await fetch("https://api.jquants.com/v2/equities/bars/daily?code=" + code, { headers });
    const priceJson = await priceRes.json();

    const finList = finJson.data || [];
    const priceList = priceJson.data || [];
    const fin = finList[finList.length - 1] || {};
    const price = priceList[priceList.length - 1] || {};

    const num = function(v) {
      if (v === null || v === undefined || v === "") return null;
      const n = Number(v);
      return isNaN(n) ? null : n;
    };

    const closePrice = num(price.AdjC) || num(price.C);
    const eps = num(fin.EPS);
    const shares = num(fin.ShOutFY);
    const treasury = num(fin.TrShFY) || 0;
    const equity = num(fin.Eq);
    const netShares = shares ? shares - treasury : null;
    const bps = (equity && netShares) ? equity / netShares : null;
    const divAnn = num(fin.FDivAnn);

    const per = (closePrice && eps) ? Math.round(closePrice / eps * 100) / 100 : null;
    const pbr = (closePrice && bps) ? Math.round(closePrice / bps * 100) / 100 : null;
    const divYield = (divAnn && closePrice) ? Math.round(divAnn / closePrice * 10000) / 100 : null;

    const companyData = {
      code: code,
      name: resolvedName || query,
      period: fin.CurPerType || null,
      price: closePrice,
      per: per, pbr: pbr, divYield: divYield,
      sales: num(fin.Sales), op: num(fin.OP), np: num(fin.NP),
      fSales: num(fin.FSales),
      equity: equity, equityRatio: num(fin.EqAR),
      cfo: num(fin.CFO), eps: eps, divAnn: divAnn
    };

    const promptParts = [
      "You are a stock analyst. Analyze the following Japanese company data from J-Quants. Do not guess missing metrics.",
      "Data: " + JSON.stringify(companyData),
      "Respond ONLY in JSON like this (no extra text, no markdown):",
      '{"radar":{"valuation":0-100,"growth":0-100,"financial":0-100,"profitability":0-100,"dividend":0-100,"stability":0-100},"ai_score":0-100,"verdict":"strong_buy|buy|hold|sell|strong_sell","comment":"100 chars in Japanese"}'
    ];
    const prompt = promptParts.join("\n");

    const aiResRaw = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const aiRes = await aiResRaw.json();

    let ai = null;
    const text = (aiRes.content && aiRes.content[0] && aiRes.content[0].text) || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { ai = JSON.parse(match[0]); } catch (e) { ai = { parseError: e.message, raw: text }; }
    } else {
      ai = { error: "no JSON in AI response", raw: text, full: aiRes };
    }

    res.status(200).json({ data: companyData, ai: ai });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
};
