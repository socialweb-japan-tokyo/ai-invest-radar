import Anthropic from "@anthropic-ai/sdk";

export default async function handler(req, res) {
  try {
    const code = (req.query.code || "72030").toString();
    const headers = { "x-api-key": process.env.JQUANTS_API_KEY };

    // J-Quants V2: 財務情報と株価四本値を取得
    const finRes = await fetch(`https://api.jquants.com/v2/fins/summary?code=${code}`, { headers }).then(r => r.json());
    const priceRes = await fetch(`https://api.jquants.com/v2/equities/bars/daily?code=${code}`, { headers }).then(r => r.json());

    const finList = finRes.fins_summary || finRes.statements || [];
    const priceList = priceRes.daily_quotes || priceRes.equities_bars_daily || [];
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
      証券コード: code, 株価: closePrice, PER: per, PBR: pbr, 配当利回り: divYield,
      売上高_当期累計: num(fin.Sales), 営業利益_当期累計: num(fin.OP),
      純利益_当期累計: num(fin.NP), 通期売上予想: num(fin.FSales),
      自己資本: equity, 自己資本比率: num(fin.EqAR),
      営業CF: num(fin.CFO), EPS: eps, 予想年間配当: divAnn,
    };

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: `あなたは株式アナリストです。以下はJ-Quantsから取得した実データです。データに無い指標は推測せず、JSON形式だけで回答してください（前後の説明やマークダウン不要）:\n${JSON.stringify(companyData)}\n\n形式:\n{"radar":{"割安度":0-100,"成長性":0-100,"財務健全性":0-100,"収益性":0-100,"配当":0-100,"安定性":0-100},"ai_score":0-100,"verdict":"強い買い/やや買い/中立/やや売り/売り","comment":"100字程度"}`
      }]
    });

    const ai = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);
    res.status(200).json({ data: companyData, ai });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
