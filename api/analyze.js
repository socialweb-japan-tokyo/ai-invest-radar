module.exports = async (req, res) => {
  try {
    const code = (req.query.code || "72030").toString();
    const headers = { "x-api-key": process.env.JQUANTS_API_KEY };

    const finRes = await fetch(`https://api.jquants.com/v2/fins/summary?code=${code}`, { headers }).then(r => r.json());
    const priceRes = await fetch(`https://api.jquants.com/v2/equities/bars/daily?code=${code}`, { headers }).then(r => r.json());

    const finList = finRes.data || [];
    const priceList = priceRes.data || [];
    const fin = finList[finList.length - 1] || {};
    const price = priceList[priceList.length - 1] || {};

    const num = v => (v === null || v === undefined || v === "" || isNaN(Number(v))) ? null : Number(v);
    const closePrice = num(price.AdjC ?? price.C);
    const eps = num(fin.EPS);
    const shares = num(fin.ShOutFY);
    const treasury = num(fin.TrShFY) || 0;
    const equity = num(fin.Eq);
    const netShares = shares ? shares - treasury : null;
    const bps = (equity && netShares) ? equity / netShares : null;
    const divAnn = num(fin.FDivAnn);
    const per = (closePrice && eps) ? +(closePrice / eps).toFixed(2) : null;
    const pbr = (closePrice && bps) ? +(closePrice / bps).toFixed(2) : null;
    const divYield = (divAnn && closePrice) ? +(divAnn / closePrice * 100).toFixed(2) : null;

    const companyData = {
      code, period: fin.CurPerType || null, price: closePrice,
      per, pbr, divYield,
      sales: num(fin.Sales), op: num(fin.OP), np: num(fin.NP),
      fSales: num(fin.FSales), equity, equityRatio: num(fin.EqAR),
      cfo: num(fin.CFO), eps, divAnn
    };

    const prompt = "あなたは株式アナリストです。以下はJ-Quantsから取得した実データです。データに無い指標は推測せず、JSON形式だけで回答してください（前後の説明やマークダウン不要）:\n" + JSON.stringify(companyData) + '\n\n形式:\n{"radar":{"割安度":0-100,"成長性":0-100,"財務健全性":0-100,"収益性":0-100,"配当":0-100,"安定性":0-100},"ai_score":0-100,"verdict":"強い買い/やや買い/中立/やや売り/売り","comment":"100字程度"}';

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.AN
