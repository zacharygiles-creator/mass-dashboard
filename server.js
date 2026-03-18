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
  'claude': {
    password: 'claude99',
    name: 'Claude',
    sites: ['99 Cents - Houston'] // only sees his facility
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

    let data = {
      sites: results[0],
      systems: results[1],
      assets: results[2],
      findings: results[3],
      valves: results[4],
      readings: results[5],
      components: results[6],
      snapshots: results[7],
      customers: results[8]
    };

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
          'Submitted At': submittedAt || new Date().toISOString()
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

app.listen(port, () => {
  console.log(`MASSCORE running at http://localhost:${port}`);
});
