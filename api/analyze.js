let companiesCache = null;
let companiesCacheTime = 0;
const CACHE_DURATION = 1000 * 60 * 60 * 24;

async function fetchCompanies(apiKey) {
  const now = Date.now();
  if (companiesCache && (now - companiesCacheTime) < CACHE_DURATION) return companiesCache;
  const res = await fetch("https://api.jquants.com/v2/equities/master", { headers: { "x-api-key": apiKey } });
  const json = await res.json();
  companiesCache = json.data || [];
  companiesCacheTime = now;
  return companiesCache;
}

function resolveCode(query, companies) {
  const q = query.trim();
  if (/^\d{4,5}$/.test(q)) return q.length === 4 ? q + "0" : q;
  const exact = companies.find(c => c.CoName === q || c.CoNameEn === q);
  if (exact) return exact.Code;
  const startsWith = companies.find(c => c.CoName && c.CoName.startsWith(q));
  if (startsWith) return startsWith.Code;
  const partial = companies.find(c => c.CoName && c.CoName.includes(q));
  if (partial) return partial.Code;
  const enPartial = companies.find(c => c.CoNameEn && c.CoNameEn.toLowerCase().includes(q.toLowerCase()));
  if (enPartial) return enPartial.Code;
  return null;
}

const num = function(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
};

// 1社分の主要指標を取る（軽量版、AI分析なし）
async function fetchPeerMetrics(code, name, apiKey) {
  const headers = { "x-api-key": apiKey };
  try {
    const [finRes, priceRes] = await Promise.all([
      fetch("https://api.jquants.com/v2/fins/summary?code=" + code, { headers }).then(r => r.json()),
      fetch("https://api.jquants.com/v2/equities/bars/daily?code=" + code, { headers }).then(r => r.json())
    ]);
    const finList = finRes.data || [];
    const priceList = priceRes.data || [];
    const fin = finList[finList.length - 1] || {};

    let price = {};
    for (let i = priceList.length - 1; i >= 0; i--) {
      const p = priceList[i];
      if (p && (p.AdjC != null || p.C != null)) { price = p; break; }
    }
    const closePrice = num(price.AdjC) || num(price.C);
    const eps = num(fin.EPS);
    const shares = num(fin.ShOutFY);
    const treasury = num(fin.TrShFY) || 0;
    const equity = num(fin.Eq);
    const np = num(fin.NP);
    const netShares = shares ? shares - treasury : null;
    const bps = (equity && netShares) ? equity / netShares : null;
    const divAnn = num(fin.FDivAnn);
    const period = fin.CurPerType || "";
    const mult = period === "FY" ? 1 : period === "3Q" ? 4/3 : period === "2Q" ? 2 : period === "1Q" ? 4 : 1;
    const annualNp = np ? np * mult : null;

    return {
      code: code,
      name: name,
      per: (closePrice && eps) ? Math.round(closePrice / eps * 100) / 100 : null,
      pbr: (closePrice && bps) ? Math.round(closePrice / bps * 100) / 100 : null,
      roe: (annualNp && equity) ? Math.round(annualNp / equity * 10000) / 100 : null,
      divYield: (divAnn && closePrice) ? Math.round(divAnn / closePrice * 10000) / 100 : null
    };
  } catch (e) {
    return { code: code, name: name, per: null, pbr: null, roe: null, divYield: null };
  }
}

module.exports = async (req, res) => {
  try {
    const apiKey = process.env.JQUANTS_API_KEY;
    const headers = { "x-api-key": apiKey };
    const query = (req.query.q || req.query.code || "トヨタ自動車").toString();

    let code = null;
    let companyInfo = null;
    const companies = await fetchCompanies(apiKey);

    if (/^\d{4,5}$/.test(query.trim())) {
      code = query.trim().length === 4 ? query.trim() + "0" : query.trim();
      companyInfo = companies.find(c => c.Code === code);
    } else {
      code = resolveCode(query, companies);
      if (code) companyInfo = companies.find(c => c.Code === code);
    }

    if (!code) return res.status(404).json({ error: "企業が見つかりませんでした: " + query });

    const finRes = await fetch("https://api.jquants.com/v2/fins/summary?code=" + code, { headers });
    const finJson = await finRes.json();
    const priceRes = await fetch("https://api.jquants.com/v2/equities/bars/daily?code=" + code, { headers });
    const priceJson = await priceRes.json();

    const finList = finJson.data || [];
    const priceList = priceJson.data || [];
    const fin = finList[finList.length - 1] || {};

    let price = {};
    let prevPrice = {};
    let foundLatest = false;
    for (let i = priceList.length - 1; i >= 0; i--) {
      const p = priceList[i];
      if (p && (p.AdjC != null || p.C != null)) {
        if (!foundLatest) { price = p; foundLatest = true; }
        else { prevPrice = p; break; }
      }
    }

    const closePrice = num(price.AdjC) || num(price.C);
    const prevClose = num(prevPrice.AdjC) || num(prevPrice.C);
    const priceChange = (closePrice && prevClose) ? Math.round((closePrice - prevClose) * 10) / 10 : null;
    const priceChangePct = (priceChange != null && prevClose) ? Math.round(priceChange / prevClose * 10000) / 100 : null;

    const eps = num(fin.EPS);
    const shares = num(fin.ShOutFY);
    const treasury = num(fin.TrShFY) || 0;
    const equity = num(fin.Eq);
    const assets = num(fin.TA);
    const np = num(fin.NP);
    const sales = num(fin.Sales);
    const op = num(fin.OP);
    const netShares = shares ? shares - treasury : null;
    const bps = (equity && netShares) ? equity / netShares : null;
    const divAnn = num(fin.FDivAnn);

    const per = (closePrice && eps) ? Math.round(closePrice / eps * 100) / 100 : null;
    const pbr = (closePrice && bps) ? Math.round(closePrice / bps * 100) / 100 : null;
    const divYield = (divAnn && closePrice) ? Math.round(divAnn / closePrice * 10000) / 100 : null;
    const marketCap = (closePrice && shares) ? closePrice * shares : null;

    const period = fin.CurPerType || "";
    const periodMult = period === "FY" ? 1 : period === "3Q" ? 4/3 : period === "2Q" ? 2 : period === "1Q" ? 4 : 1;
    const annualNp = np ? np * periodMult : null;
    const roe = (annualNp && equity) ? Math.round(annualNp / equity * 10000) / 100 : null;
    const roa = (annualNp && assets) ? Math.round(annualNp / assets * 10000) / 100 : null;
    const opMargin = (op && sales) ? Math.round(op / sales * 10000) / 100 : null;
    const payoutRatio = (divAnn && eps) ? Math.round(divAnn / (eps * periodMult) * 10000) / 100 : null;

    const fyList = finList.filter(f => f.CurPerType === "FY");
    let salesGrowth = null, opGrowth = null;
    if (fyList.length >= 2) {
      const latest = fyList[fyList.length - 1];
      const prev = fyList[fyList.length - 2];
      const ls = num(latest.Sales), ps = num(prev.Sales);
      const lo = num(latest.OP), po = num(prev.OP);
      if (ls && ps) salesGrowth = Math.round((ls / ps - 1) * 10000) / 100;
      if (lo && po) opGrowth = Math.round((lo / po - 1) * 10000) / 100;
    }

    // === 競合比較 ===
    // 同じセクター33の企業から、自社を除いて時価総額の近い順に4社を取る
    let peers = [];
    let peerAnalysis = null;
    if (companyInfo && companyInfo.S33 && marketCap) {
      const sameSector = companies.filter(c =>
        c.S33 === companyInfo.S33 && c.Code !== code && c.CoName
      );
      // 規模感の近い企業を選びたいが時価総額は不明なので、銘柄コード順で上位4社を採用
      const peerSelection = sameSector.slice(0, 4);
      const peerPromises = peerSelection.map(p => fetchPeerMetrics(p.Code, p.CoName, apiKey));
      peers = await Promise.all(peerPromises);
    }

    const companyData = {
      code: code,
      name: (companyInfo && companyInfo.CoName) || query,
      nameEn: companyInfo ? companyInfo.CoNameEn : null,
      market: companyInfo ? companyInfo.MktNm : null,
      sector: companyInfo ? companyInfo.S17Nm : null,
      sector33: companyInfo ? companyInfo.S33Nm : null,
      period: period,
      price: closePrice, priceChange: priceChange, priceChangePct: priceChangePct,
      marketCap: marketCap,
      per: per, pbr: pbr, divYield: divYield,
      sales: sales, op: op, np: np, fSales: num(fin.FSales),
      equity: equity, equityRatio: num(fin.EqAR), assets: assets,
      roe: roe, roa: roa, opMargin: opMargin,
      cfo: num(fin.CFO),
      eps: eps, divAnn: divAnn, payoutRatio: payoutRatio,
      salesGrowth: salesGrowth, opGrowth: opGrowth,
      priceHistory: extractMonthlyPrices(priceList),
      perfHistory: fyList.slice(-5).map(f => ({
        year: f.CurFYEn ? String(f.CurFYEn).slice(0,4) : null,
        sales: num(f.Sales), op: num(f.OP)
      })),
      peers: peers
    };

    // AI分析
    const promptParts = [
      "You are a stock analyst. Analyze the following Japanese company data from J-Quants. Do not guess missing metrics.",
      "Data: " + JSON.stringify({
        code: companyData.code, name: companyData.name, sector: companyData.sector,
        price: companyData.price, per: companyData.per, pbr: companyData.pbr,
        divYield: companyData.divYield, roe: companyData.roe, roa: companyData.roa,
        equityRatio: companyData.equityRatio, opMargin: companyData.opMargin,
        salesGrowth: companyData.salesGrowth, opGrowth: companyData.opGrowth,
        payoutRatio: companyData.payoutRatio,
        peers: peers.map(p => ({ name: p.name, per: p.per, roe: p.roe, divYield: p.divYield }))
      }),
      "Respond ONLY in JSON like this (no extra text, no markdown):",
      '{"radar":{"valuation":0-100,"growth":0-100,"financial":0-100,"profitability":0-100,"dividend":0-100,"stability":0-100},"ai_score":0-100,"verdict":"strong_buy|buy|hold|sell|strong_sell","comment":"100 chars in Japanese","peer_comment":"competitive position vs peers in 100 chars Japanese"}'
    ];
    const prompt = promptParts.join("\n");

    const aiResRaw = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1500, messages: [{ role: "user", content: prompt }] })
    });
    const aiRes = await aiResRaw.json();

    let ai = null;
    const text = (aiRes.content && aiRes.content[0] && aiRes.content[0].text) || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { ai = JSON.parse(match[0]); } catch (e) { ai = { parseError: e.message, raw: text }; }
    } else {
      ai = { error: "no JSON in AI response", raw: text };
    }

    res.status(200).json({ data: companyData, ai: ai });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
};

function extractMonthlyPrices(priceList) {
  const byMonth = {};
  for (const p of priceList) {
    if (!p || !p.Date) continue;
    const c = p.AdjC != null ? Number(p.AdjC) : (p.C != null ? Number(p.C) : null);
    if (c == null || isNaN(c)) continue;
    const ym = String(p.Date).slice(0, 7);
    byMonth[ym] = { date: p.Date, close: c };
  }
  const keys = Object.keys(byMonth).sort();
  const last12 = keys.slice(-12);
  return last12.map(k => ({ month: k, close: byMonth[k].close }));
}
