require('dotenv').config();
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.static('public'));

app.get('/api/data', async (req, res) => {
  try {
    const fetch = (await import('node-fetch')).default;
    const baseId = process.env.AIRTABLE_BASE_ID;
    const apiKey = process.env.AIRTABLE_API_KEY;
    const headers = { Authorization: `Bearer ${apiKey}` };

    const tables = [
      'Sites',
      'Systems',
      'Assets',
      'Findings',
      'Relief%20Valves',
      'Compressor%20Readings',
      'Components',
      'Plant%20Condition%20Snapshots',
      'Customers'
    ];

    const results = await Promise.all(
      tables.map(t =>
        fetch(`https://api.airtable.com/v0/${baseId}/${t}`, { headers }).then(r => r.json())
      )
    );

    res.json({
      sites: results[0],
      systems: results[1],
      assets: results[2],
      findings: results[3],
      valves: results[4],
      readings: results[5],
      components: results[6],
      snapshots: results[7],
      customers: results[8]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

app.listen(port, () => {
  console.log(`MASS Dashboard running at http://localhost:${port}`);
});