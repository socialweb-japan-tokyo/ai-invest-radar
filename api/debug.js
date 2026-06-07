module.exports = async (req, res) => {
  try {
    const apiKey = process.env.JQUANTS_API_KEY;
    const headers = { "x-api-key": apiKey };
    
    const masterRes = await fetch("https://api.jquants.com/v2/equities/master", { headers });
    const masterStatus = masterRes.status;
    const masterText = await masterRes.text();
    
    let masterJson = null;
    let parseError = null;
    try {
      masterJson = JSON.parse(masterText);
    } catch (e) {
      parseError = e.message;
    }
    
    const list = (masterJson && masterJson.data) || [];
    
    const matches = list.filter(c => {
      const name = c.CompanyName || c.CoName || "";
      const nameEn = (c.CompanyNameEnglish || c.CoNameEn || "").toLowerCase();
      return name.includes("マツダ") || nameEn.includes("mazda") 
          || c.Code === "7261" || c.Code === "72610";
    });
    
    res.status(200).json({
      apiKeyExists: !!apiKey,
      apiKeyLength: apiKey ? apiKey.length : 0,
      masterStatus: masterStatus,
      parseError: parseError,
      rawResponseSnippet: masterText.slice(0, 300),
      totalCount: list.length,
      keysAvailable: list[0] ? Object.keys(list[0]) : [],
      mazdaMatches: matches,
      firstThreeSamples: list.slice(0, 3)
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
};
