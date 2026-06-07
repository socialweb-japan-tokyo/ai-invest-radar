module.exports = async (req, res) => {
  try {
    const apiKey = process.env.JQUANTS_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'APIキー未設定' });
    const headers = { "x-api-key": apiKey };

    const q = (req.query.q || '').toString().trim();
    if (!q) return res.status(400).json({ error: 'クエリが空です' });

    // ===== 1. 銘柄マスタ取得 =====
    const masterRes = await fetch("https://api.jquants.com/v2/equities/master", { headers });
    if (!masterRes.ok) return res.status(500).json({ error: `マスタ取得失敗: ${masterRes.status}` });
    const list = (await masterRes.json()).data || [];

    // ===== 2. 銘柄マッチング(揺らぎ吸収) =====
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

    // ===== 3. 株価取得(直近400日) =====
    const today = new Date();
    const from = new Date(today.getTime() - 400 * 86400000);
    const fmtD = d => d.toISOString().slice(0,10).replace(/-/g, '');
    
    let priceHistory = [], currentPrice = null, prevPrice = null;
    try {
      const pr = await fetch(
        `https://api.jquants.com/v2/prices/daily_quotes?code=${code}&from=${fmtD(from)}&to=${fmtD(today)}`,
        { headers }
      );
      if (pr.ok) {
        const pj = await pr.json();
        const quotes = (pj.daily_quotes || pj.data || [])
          .filter(x => (x.Close ?? x.AdjustmentClose) != null);
        // 月末値抽出
        const byMonth = {};
        for (const x of quotes) {
          const m = (x.Date || '').slice(0,7);
          const close = x.Close ?? x.AdjustmentClose;
          if (!byMonth[m] || x.Date > byMonth[m].Date)
            byMonth[m] = { Date: x.Date, close };
        }
        const months = Object.keys(byMonth).sort().slice(-12);
        priceHistory = months.map(m => ({ month: m, close: byMonth[m].close }));
        // 直近2日
        const sorted = quotes.sort((a,b) => a.Date.localeCompare(b.Date));
        if (sorted.length >= 1) currentPrice = sorted[sorted.length-1].Close ?? sorted[sorted.length-1].AdjustmentClose;
        if (sorted.length >= 2) prevPrice = sorted[sorted.length-2].Close ?? sorted[sorted.length-2].AdjustmentClose;
      }
    } catch (e) { /* 取れなくても続行 */ }

    let priceChange = null, priceChangePct = null;
    if (currentPrice != null && prevPrice != null) {
      priceChange = Math.round((currentPrice - prevPrice) * 10) / 10;
      priceChangePct = Math.round((priceChange / prevPrice) * 10000) / 100;
    }

    // ===== 4. 財務取得 =====
    let statements = [];
    try {
      const sr = await fetch(
        `https://api.jquants.com/v2/fins/statements?code=${code}`,
        { headers }
      );
      if (sr.ok) {
        const sj = await sr.json();
        statements = sj.statements || sj.data || [];
      }
    } catch (e) { /* 続行 */ }

    const num = v => {
      if (v == null || v === '') return null;
      const n = Number(v);
      return isNaN(n) ? null : n;
    };

    // 最新決算
    const latest = [...statements]
      .sort((a,b) => (b.DisclosedDate || '').localeCompare(a.DisclosedDate || ''))[0] || {};

    const netSales = num(latest.NetSales);
    const opIncome = num(latest.OperatingProfit);
    const netProfit = num(latest.Profit);
    const eps = num(latest.EarningsPerShare);
    const bps = num(latest.BookValuePerShare);
    const equityRatio = num(latest.EquityToAssetRatio);
    const fSales = num(latest.ForecastNetSales);
    const divAnn = num(latest.ForecastDividendPerShareAnnual) ?? num(latest.ResultDividendPerShareAnnual);
    const sharesOut = num(latest.NumberOfIssuedAndOutstandingSharesAtTheEndOfFiscalYearIncludingTreasuryStock);
    const cfo = num(latest.CashFlowsFromOperatingActivities);
    const equity = num(latest.Equity);
    const totalAssets = num(latest.TotalAssets);

    // 計算項目
    const per = (currentPrice != null && eps && eps > 0) ? Math.round((currentPrice/eps)*10)/10 : null;
    const pbr = (currentPrice != null && bps && bps > 0) ? Math.round((currentPrice/bps)*100)/100 : null;
    const marketCap = (currentPrice != null && sharesOut) ? currentPrice * sharesOut : null;
    const divYield = (divAnn != null && currentPrice && currentPrice > 0) ? Math.round((divAnn/currentPrice)*10000)/100 : null;
    const payoutRatio = (divAnn != null && eps && eps > 0) ? Math.round((divAnn/eps)*1000)/10 : null;
    const opMargin = (opIncome != null && netSales && netSales > 0) ? Math.round((opIncome/netSales)*1000)/10 : null;
    const roe = (netProfit != null && equity && equity > 0) ? Math.round((netProfit/equity)*1000)/10 : null;
    const roa = (netProfit != null && totalAssets && totalAssets > 0) ? Math.round((netProfit/totalAssets)*1000)/10 : null;

    // 業績推移
    const perfHistory = statements
      .filter(s => s.TypeOfCurrentPeriod === 'FY' || s.TypeOfCurrentPeriod === 'A')
      .sort((a,b) => (a.CurrentPeriodEndDate || '').localeCompare(b.CurrentPeriodEndDate || ''))
      .slice(-5)
      .map(s => ({
        year: (s.CurrentPeriodEndDate || '').slice(0,4),
        sales: num(s.NetSales),
        op: num(s.OperatingProfit)
      }))
      .filter(p => p.year);

    let salesGrowth = null, opGrowth = null;
    if (perfHistory.length >= 2) {
      const p = perfHistory[perfHistory.length-2], c = perfHistory[perfHistory.length-1];
      if (p.sales && c.sales) salesGrowth = Math.round(((c.sales-p.sales)/p.sales)*1000)/10;
      if (p.op && c.op) opGrowth = Math.round(((c.op-p.op)/p.op)*1000)/10;
    }

    // ===== 5. 同業ピア =====
    const peers = list
      .filter(c => c.S33 === company.S33 && c.Code !== code && c.Mkt === '0111')
      .slice(0, 4)
      .map(p => ({ name: p.CoName, code: p.Code, per: null, roe: null, divYield: null }));

    // ===== 6. AI簡易スコアリング =====
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
    const comment = `${company.CoName}の主要財務指標を分析。AIスコア${score}点で、${verdictTxt[verdict]}と判断。`
      + (per != null ? ` PER ${per}倍` : '') + (roe != null ? `・ROE ${roe}%` : '') + '。';

    res.status(200).json({
      data: {
        name: company.CoName,
        code: company.Code,
        nameEn: company.CoNameEn,
        market: company.MktNm,
        sector: company.S17Nm,
        sector33: company.S33Nm,
        period: latest.TypeOfCurrentPeriod || null,
        price: currentPrice,
        priceChange,
        priceChangePct,
        priceHistory,
        marketCap,
        per, pbr,
        equityRatio,
        roe, roa,
        opMargin, cfo,
        divYield, divAnn,
        payoutRatio, eps,
        salesGrowth, opGrowth,
        fSales,
        sales: netSales,
        op: opIncome,
        perfHistory,
        peers
      },
      ai: {
        verdict,
        comment,
        ai_score: score,
        radar: {
          valuation: per != null ? Math.max(0, Math.min(100, 100 - per * 3)) : 50,
          growth: salesGrowth != null ? Math.max(0, Math.min(100, 50 + salesGrowth * 5)) : 50,
          financial: equityRatio != null ? Math.round(Math.min(100, equityRatio * 150)) : 50,
          profitability: roe != null ? Math.max(0, Math.min(100, roe * 6)) : 50,
          dividend: divYield != null ? Math.max(0, Math.min(100, divYield * 25)) : 50,
          stability: 70
        },
        peer_comment: `同セクター(${company.S33Nm})の主要企業との比較分析。`
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
