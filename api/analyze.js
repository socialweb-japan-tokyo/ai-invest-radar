return res.status(200).json({
  _debug: {
    totalCount: list.length,
    keysAvailable: list[0] ? Object.keys(list[0]) : [],
    firstSample: list[0] || null
  }
});module.exports = async (req, res) => {
  try {
    const apiKey = process.env.JQUANTS_API_KEY;
    const headers = { "x-api-key": apiKey };
    
    const masterRes = await fetch("https://api.jquants.com/v2/equities/master", { headers });
    const masterJson = await masterRes.json();
    const list = masterJson.data || [];
    
    // マツダを含む名前で検索
    const matches = list.filter(c => 
      (c.CoName && c.CoName.includes("マツダ")) ||
      (c.CoNameEn && c.CoNameEn.toLowerCase().includes("mazda")) ||
      c.Code === "7261" || c.Code === "72610"
    );
    
    // 全データの最初の3件もサンプルとして見たい
    const samples = list.slice(0, 3);
    
    res.status(200).json({
      totalCount: list.length,
      mazdaMatches: matches,
      keysAvailable: list[0] ? Object.keys(list[0]) : [],
      firstThreeSamples: samples
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
