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
    const tre
