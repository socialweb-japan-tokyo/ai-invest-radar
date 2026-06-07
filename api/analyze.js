export default async function handler(req, res) {
  try {
    const code = (req.query.code || "72030").toString();
    const headers = { "x-api-key": process.env.JQUANTS_API_KEY };

    const finRes = await fetch(`https://api.jquants.com/v2/fins/summary?code=${code}`, { headers });
    const finJson = await finRes.json();

    const priceRes = await fetch(`https://api.jquants.com/v2/equities/bars/daily?code=${code}`, { headers });
    const priceJson = await priceRes.json();

    res.status(200).json({
      finStatus: finRes.status,
      priceStatus: priceRes.status,
      finKeys: Object.keys(finJson),
      priceKeys: Object.keys(priceJson),
      finSample: finJson,
      priceSample: priceJson,
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
}
