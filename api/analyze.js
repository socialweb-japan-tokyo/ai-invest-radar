module.exports = async (req, res) => {
  try {
    const apiKey = process.env.JQUANTS_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'APIキー未設定' });
    const headers = { "x-api-key": apiKey };

    const q = (req.query.q || '').toString().trim();
    if (!q) return res.status(400).json({ error: 'クエリが空です' });

    // ===== 1. 銘柄マスタ =====
    const masterRes = await fetch("https://api.jquants.com/v2/equities/master", { headers });
    if (!masterRes.ok) return res.status(500).json({ error: `マスタ取得失敗: ${masterRes.status}` });
    const list = (await masterRes.json()).data || [];

    // ===== 2. マッチング =====
    const normalize = s => (s || "")
      .replace(/株式会社/g, "")
      .replace(/[（(]株[）)]/g, "")
      .replace(/\s+/g, "")
      .trim();
    const qNorm = normalize(q);
    const qLower = qNorm.toLowerCase();
    const isCode = /^\d{4,5}$/.test(qNorm);
    const codeQuery = qNorm.length === 4 ? qNorm + "0" : qNorm;

    let company = null;
    if (isCode) company = list.find(c => c.Code === codeQuery);
    if (!company) company = list.find(c => normalize(c.CoName) === qNorm);
    if (!company) company = list.find(c => (c.CoNameEn || '').toLowerCase() === qLower);
    if (!company && qNorm.length >= 2)
      company = list.find(c => normalize(c.CoName).includes(qNorm));
    if (!company && qLower.length >= 3)
      company = list.find(c => (c.CoNameEn || '').toLowerCase().includes(qLower));
    if (!company) return res.status(404).json({ error: `企業が見つかりませんでした: ${q}` });

    const code = company.Code;
    const num = v => {
      if (v == null || v === '') return null;
      const n = Number(v);
      return isNaN(n) ? null : n;
    };
    const pick = (obj, ...keys) => {
      for (const k of keys) if (obj[k] != null && obj[k] !== '') return obj[k];
      return null;
    };

    // ===== 3. 株価(V2: /equities/bars/daily) =====
    let priceHistory = [], currentPrice = null, prevPrice = null, _priceRaw = null;
    try {
      const pr = await fetch(
        `https://api.jquants.com/v2/equities/bars/daily?code=${code}`,
        { headers }
      );
      const ptxt = await pr.text();
      _priceRaw = { status: pr.status, snippet: ptxt.slice(0, 200) };
      if (pr.ok) {
        const pj = JSON.parse(ptxt);
        const arr = pj.data || pj.daily_quotes || [];
        const norm = arr.map(x => ({
          Date: x.Date || x.D,
          close: num(pick(x, 'C', 'Close', 'AdjustmentClose'))
        })).filter(x => x.Date && x.close != null)
          .sort((a,b) => a.Date.localeCompare(b.Date));

        // 月末値
        const byMonth = {};
        for (const x of norm) {
          const m = x.Date.slice(0,7);
          if (!byMonth[m] || x.Date > byMonth[m].Date) byMonth[m] = x;
        }
        const months = Object.keys(byMonth).sort().slice(-12);
        priceHistory = months.map(m => ({ month: m, close: byMonth[m].close }));

        if (norm.length >= 1) currentPrice = norm[norm.length-1].close;
        if (norm.length >= 2) prevPrice = norm[norm.length-2].close;
      }
    } catch (e) { _priceRaw = { error: e.message }; }

    let priceChange = null, priceChangePct = null;
    if (currentPrice != null && prevPrice != null) {
      priceChange = Math.round((currentPrice - prevPrice) * 10) / 10;
      priceChangePct = Math.round((priceChange / prevPrice) * 10000) / 100;
    }

    // ===== 4. 財務(V2: /fins/summary) =====
    let statements = [], _finRaw = null;
    try {
      const sr = await fetch(
        `https://api.jquants.com/v2/fins/summary?code=${code}`,
        { headers }
      );
      const stxt = await sr.text();
      _finRaw = { status: sr.status, snippet: stxt.slice(0, 200) };
      if (sr.ok) {
        const sj = JSON.parse(stxt);
        statements = sj.data || sj.statements || [];
      }
    } catch (e) { _finRaw = { error: e.message }; }

    // 最新決算
    const latest = [...statements].sort((a,b) =>
      (pick(b, 'DisclosedDate', 'DiscDate', 'Date') || '').localeCompare(
       pick(a, 'DisclosedDate', 'DiscDate', 'Date') || ''))[0] || {};

    const netSales = num(pick(latest, 'NetSales', 'Sales', 'NS'));
    const opIncome = num(pick(latest, 'OperatingProfit', 'OpProfit', 'OP'));
    const netProfit = num(pick(latest, 'Profit', 'NetIncome', 'NP'));
    const eps = num(pick(latest, 'EarningsPerShare', 'EPS'));
    const bps = num(pick(latest, 'BookValuePerShare', 'BPS'));
    const equityRatio = num(pick(latest, 'EquityToAssetRatio', 'EqRatio'));
    const fSales = num(pick(latest, 'ForecastNetSales', 'FcstSales'));
    const divAnn = num(pick(latest, 'ForecastDividendPerShareAnnual',
      'ResultDividendPerShareAnnual', 'DPS'));
    const sharesOut = num(pick(latest,
      'NumberOfIssuedAndOutstandingSharesAtTheEndOfFiscalYearIncludingTreasuryStock',
      'IssuedShares', 'Shares'));
    const cfo = num(pick(latest, 'CashFlowsFromOperatingActivities', 'OpCF'));
    const equity = num(pick(latest, 'Equity'));
    const totalAssets = num(pick(latest, 'TotalAssets'));

    const per = (currentPrice != null && eps && eps > 0) ? Math.round((currentPrice/eps)*10)/10 : null;
    const pbr = (currentPrice != null && bps && bps > 0) ? Math.round((currentPrice/bps)*100)/100 : null;
    const marketCap = (currentPrice != null && sharesOut) ? currentPrice * sharesOut : null;
    const divYield = (divAnn != null && currentPrice && currentPrice > 0) ? Math.round((divAnn/currentPrice)*10000)/100 : null;
    const payoutRatio = (divAnn != null && eps && eps > 0) ? Math.round((divAnn/eps)*1000)/10 : null;
    const opMargin = (opIncome != null && netSales && netSales > 0) ? Math.round((opIncome/netSales)*1000)/10 : null;
    const roe = (netProfit != null && equity && equity > 0) ? Math.round((netProfit/equity)*1000)/10 : null;
    const roa = (netProfit != null && totalAssets && totalAssets > 0) ? Math.round((netProfit/totalAssets)*1000)/10 : null;

    const perfHistory = statements
      .filter(s => {
        const t = pick(s, 'TypeOfCurrentPeriod', 'PeriodType');
        return t === 'FY' || t === 'A';
      })
      .sort((a,b) => (pick(a, 'CurrentPeriodEndDate', 'PeriodEnd') || '')
        .localeCompare(pick(b, 'CurrentPeriodEndDate', 'PeriodEnd') || ''))
      .slice(-5)
      .map(s => ({
        year: (pick(s, 'CurrentPeriodEndDate', 'PeriodEnd') || '').slice(0,4),
        sales: num(pick(s, 'NetSales', 'Sales', 'NS')),
        op: num(pick(s, 'OperatingProfit', 'OpProfit', 'OP'))
      }))
      .filter(p => p.year);

    let salesGrowth = null, opGrowth = null;
    if (perfHistory.length >= 2) {
      const p = perfHistory[perfHistory.length-2], c = perfHistory[perfHistory.length-1];
      if (p.sales && c.sales) salesGrowth = Math.round(((c.sales-p.sales)/p.sales)*1000)/10;
      if (p.op && c.op) opGrowth = Math.round(((c.op-p.op)/p.op)*1000)/10;
    }

    // ===== 5. ピア =====
    const peers = list
      .filter(c => c.S33 === company.S33 && c.Code !== code && c.Mkt === '0111')
      .slice(0, 4)
      .map(p => ({ name: p.CoName, code: p.Code, per: null, roe: null, divYield: null }));

    // ===== 6. スコア =====
    let score = 50;
    if (per != null && per < 15) score += 8;
    if (pbr != null && pbr < 1.5) score += 6;
    if (roe != null && roe > 10) score += 8;
    if (divYield != null && divYield > 2) score += 5;
    if (equityRatio != null && equityRatio > 0.5) score += 6;
    if (salesGrowth != null && salesGrowth > 5) score += 5;
    score = Math.max(0, Math.min(100, score));

    const verdict = score >= 75 ? 'strong_buy' : score >= 60 ? 'buy'
                  : score >= 45 ? 'hold' : score >= 30 ? 'sell' : 'strong_sell';
    const verdictTxt = { strong_buy:'中長期保有に強い妥当性', buy:'中長期保有に妥当性あり',
      hold:'現状維持を推奨', sell:'慎重な検討を推奨', strong_sell:'保有見直しを推奨' };
    const comment = `${company.CoName}の主要財務指標を分析。AIスコア${score}点で、${verdictTxt[verdict]}と判断`
      + (per != null ? ` (PER ${per}倍` : '') + (roe != null ? `、ROE ${roe}%` : '')
      + (per != null || roe != null ? ')' : '') + '。';

    res.status(200).json({
      data: {
        name: company.CoName, code: company.Code, nameEn: company.CoNameEn,
        market: company.MktNm, sector: company.S17Nm, sector33: company.S33Nm,
        period: pick(latest, 'TypeOfCurrentPeriod', 'PeriodType'),
        price: currentPrice, priceChange, priceChangePct, priceHistory,
        marketCap, per, pbr, equityRatio, roe, roa, opMargin, cfo,
        divYield, divAnn, payoutRatio, eps,
        salesGrowth, opGrowth, fSales,
        sales: netSales, op: opIncome, perfHistory, peers
      },
      ai: {
        verdict, comment, ai_score: score,
        radar: {
          valuation: per != null ? Math.max(0, Math.min(100, 100 - per * 3)) : 50,
          growth: salesGrowth != null ? Math.max(0, Math.min(100, 50 + salesGrowth * 5)) : 50,
          financial: equityRatio != null ? Math.round(Math.min(100, equityRatio * 150)) : 50,
          profitability: roe != null ? Math.max(0, Math.min(100, roe * 6)) : 50,
          dividend: divYield != null ? Math.max(0, Math.min(100, divYield * 25)) : 50,
          stability: 70
        },
        peer_comment: `同セクター(${company.S33Nm})の主要企業との比較分析。`
      },
      _debug: { priceApi: _priceRaw, finApi: _finRaw, latestKeys: Object.keys(latest) }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
