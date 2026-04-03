require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

// ── USERS & SITE ACCESS ──────────────────────────────────
// Add users here. sites: null means access to ALL sites.
// sites: ['Site Name 1', 'Site Name 2'] limits to specific sites.
const USERS = {
  'zach': {
    password: 'masscore2026',
    name: 'Zach Giles',
    sites: null // all sites
  },
  'john': {
    password: 'masscore2026',
    name: 'John Lewis',
    sites: null // all sites
  },
  'demo': {
    password: 'massdemo',
    name: 'Demo User',
    sites: ['MASS Cold Storage'] // only sees demo site
  }
};

// ── MIDDLEWARE ───────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'masscore-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect('/login.html');
}

// Serve public files (login page, home page - no auth needed)
app.use(express.static(path.join(__dirname, 'public'), {
  index: false // disable auto index.html serving
}));

// ── ROUTES ───────────────────────────────────────────────

// Root - redirect to home
app.get('/', (req, res) => {
  res.redirect('/home.html');
});

// Dashboard - requires auth
app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Login endpoint
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = USERS[username?.toLowerCase()];
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.user = {
    username: username.toLowerCase(),
    name: user.name,
    sites: user.sites
  };
  res.json({ success: true, name: user.name });
});

// Logout
app.get('/api/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login.html');
});

// Check auth status
app.get('/api/me', (req, res) => {
  if (req.session && req.session.user) {
    res.json({ authenticated: true, user: req.session.user });
  } else {
    res.json({ authenticated: false });
  }
});

// Data API - requires auth, filters by user site access
app.get('/api/data', requireAuth, async (req, res) => {
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
      'Compliance',
      'Compressor%20Readings',
      'Components',
      'Plant%20Condition%20Snapshots',
      'Customers',
      'Service%20Record',
      'Employees'
    ];

    const results = await Promise.all(
      tables.map(t =>
        fetch(`https://api.airtable.com/v0/${baseId}/${t}`, { headers }).then(r => r.json())
      )
    );

    let data = {
      sites: results[0],
      systems: results[1],
      assets: results[2],
      findings: results[3],
      valves: results[4],
      readings: results[5],
      components: results[6],
      snapshots: results[7],
      customers: results[8],
      serviceRecords: results[9],
      employees: results[10]
    };

    // ── CAPITAL PLANNING CALCULATIONS ────────────────────
    if (data.assets && data.assets.records && data.serviceRecords && data.serviceRecords.records) {
      data.assets.records.forEach(asset => {
        const replacementValue = parseFloat(asset.fields['Estimated Replacement Value']) || 0;
        const cumulativeSpend = parseFloat(asset.fields['Cumulative Repair Spend']) || 0;
        const ratio = replacementValue > 0 ? cumulativeSpend / replacementValue : null;
        asset.fields['Repair to Value Ratio'] = ratio;
        asset.fields['Capital Flag'] = ratio === null ? null
          : ratio >= 0.7 ? 'REPLACE RECOMMENDED'
          : ratio >= 0.4 ? 'EVALUATE'
          : 'MONITOR';
      });
    }

    // Filter sites by user access
    const allowedSites = req.session.user.sites;
    if (allowedSites !== null && data.sites && data.sites.records) {
      const allowedIds = data.sites.records
        .filter(s => allowedSites.includes(s.fields['Site Name'] || s.fields['Name']))
        .map(s => s.id);
      data.sites = { records: data.sites.records.filter(s => allowedSites.includes(s.fields['Site Name'] || s.fields['Name'])) };
    }

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

// Lead submission endpoint
app.post('/api/lead', async (req, res) => {
  try {
    const fetch = (await import('node-fetch')).default;
    const baseId = process.env.AIRTABLE_BASE_ID;
    const apiKey = process.env.AIRTABLE_API_KEY;
    const { firstName, lastName, email, phone, company, role, message, submittedAt } = req.body;

    const response = await fetch(`https://api.airtable.com/v0/${baseId}/Leads`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: {
          'First Name': firstName || '',
          'Last Name': lastName || '',
          'Email': email || '',
          'Phone Number': phone || '',
          'Company Name': company || '',
          'Role': role || '',
          'Message': message || '',
        }
      })
    });

    const result = await response.json();
    if (result.id) {
      res.json({ success: true });
    } else {
      console.error('Airtable error:', result);
      res.status(500).json({ success: false, error: 'Failed to save lead' });
    }
  } catch (err) {
    console.error('Lead submission error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Quote request endpoint
app.post('/api/request-quote', requireAuth, async (req, res) => {
  try {
    const fetch = (await import('node-fetch')).default;
    const baseId = process.env.AIRTABLE_BASE_ID;
    const apiKey = process.env.AIRTABLE_API_KEY;
    const resendKey = process.env.RESEND_API_KEY;
    const { findingId, title, aName, sev, rec, cost, siteName } = req.body;

    // Look up account manager email from Airtable
    let recipients = [];

    // Find the site, then customer, then all account managers
    const sitesRes = await fetch(`https://api.airtable.com/v0/${baseId}/Sites`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const sitesData = await sitesRes.json();
    const site = (sitesData.records||[]).find(s => (s.fields['Site Name']||s.fields['Name']) === siteName);

    if (site) {
      const customerIds = site.fields['Customer'] || [];
      if (customerIds.length) {
        const custRes = await fetch(`https://api.airtable.com/v0/${baseId}/Customers/${customerIds[0]}`, { headers: { Authorization: `Bearer ${apiKey}` } });
        const custData = await custRes.json();
        const managerIds = custData.fields['Account Manager'] || [];
        await Promise.all(managerIds.map(async (mid) => {
          const empRes = await fetch(`https://api.airtable.com/v0/${baseId}/Employees/${mid}`, { headers: { Authorization: `Bearer ${apiKey}` } });
          const empData = await empRes.json();
          const email = empData.fields['Email'] || null;
          const name = empData.fields['Employee Name'] || 'Account Manager';
          if (email) recipients.push({ email, name });
        }));
      }
    }

    if (!recipients.length) {
      return res.status(400).json({ success: false, error: 'No account manager emails found' });
    }

    // Send email to all account managers
    const emailResults = await Promise.all(recipients.map(r =>
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'MASSCORE Notifications <notifications@mail.masscore.com>',
          to: r.email,
          subject: `Quote Request — ${title} — ${siteName}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0f0f0f;color:#e8e8e8;padding:32px">
            <div style="border-bottom:3px solid #E8320A;padding-bottom:16px;margin-bottom:24px">
              <div style="font-size:22px;font-weight:900;letter-spacing:3px;color:#fff">MASS<span style="color:#E8320A">CORE</span></div>
              <div style="font-size:11px;letter-spacing:2px;color:#999;margin-top:4px">QUOTE REQUEST NOTIFICATION</div>
            </div>
            <p style="color:#ccc;margin-bottom:24px">A customer has requested pricing for the following finding at <strong style="color:#fff">${siteName}</strong>.</p>
            <div style="background:#1a1a1a;border:1px solid #2a2a2a;padding:20px;margin-bottom:24px">
              <div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:12px">${title}</div>
              <div style="font-size:11px;color:#999;letter-spacing:1px;margin-bottom:4px">ASSET: <span style="color:#ccc">${aName}</span></div>
              <div style="font-size:11px;color:#999;letter-spacing:1px;margin-bottom:4px">SEVERITY: <span style="color:#ccc">${sev}</span></div>
              ${rec ? `<div style="font-size:11px;color:#999;letter-spacing:1px;margin-bottom:4px">RECOMMENDED ACTION: <span style="color:#ccc">${rec}</span></div>` : ''}
              ${cost ? `<div style="font-size:11px;color:#999;letter-spacing:1px">ESTIMATED COST: <span style="color:#ccc">${cost}</span></div>` : ''}
            </div>
            <p style="color:#999;font-size:12px">Requested by: ${req.session.user.name}<br>Login: ${req.session.user.username}</p>
            <div style="border-top:1px solid #2a2a2a;margin-top:24px;padding-top:16px;font-size:11px;color:#555;letter-spacing:1px">MASSCORE — MECHANICAL ASSESSMENT SCORING SYSTEM</div>
          </div>
        `
        })
      }).then(r => r.json())
    ));

    const allSent = emailResults.every(r => r.id);
    if (allSent) {
      res.json({ success: true });
    } else {
      console.error('Resend errors:', emailResults);
      res.status(500).json({ success: false, error: 'One or more emails failed to send' });
    }
  } catch (err) {
    console.error('Quote request error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.listen(port, () => {
  console.log(`MASSCORE running at http://localhost:${port}`);
});
