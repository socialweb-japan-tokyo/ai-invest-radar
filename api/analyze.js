module.exports = async (req, res) => {
  try {
    const code = (req.query.code || "72030").toString();
    const headers = { "x-api-key": process.env.JQUANTS_API_KEY };

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
      period: fin.CurPerType || null,
      price: closePrice,
      per: per,
      pbr: pbr,
      divYield: divYield,
      sales: num(fin.Sales),
      op: num(fin.OP),
      np: num(fin.NP),
      fSales: num(fin.FSales),
      equity: equity,
      equityRatio: num(fin.EqAR),
      cfo: num(fin.CFO),
      eps: eps,
      divAnn: divAnn
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
