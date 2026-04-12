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

// Inspection lobby - requires auth
app.get('/inspection-lobby', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'inspection-lobby.html'));
});

// Inspection - requires auth
app.get('/inspection', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'inspection.html'));
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


// ── RUBRIC QUESTIONS API ─────────────────────────────────
app.get('/api/rubric', requireAuth, async (req, res) => {
  try {
    const fetch  = (await import('node-fetch')).default;
    const baseId = process.env.AIRTABLE_BASE_ID;
    const apiKey = process.env.AIRTABLE_API_KEY;
    const headers = { Authorization: `Bearer ${apiKey}` };

    const { assetId, inspType } = req.query;
    if (!assetId || !inspType) {
      return res.status(400).json({ error: 'assetId and inspType are required' });
    }

    const tierMap = {
      'Weekly':      ['W'],
      'Monthly':     ['W','M'],
      'Quarterly':   ['W','M','Q'],
      'Semi Annual': ['W','M','Q','SA'],
      'Annual':      ['W','M','Q','SA','A']
    };
    const tiers = tierMap[inspType] || ['W'];

    // Fetch asset record
    const assetRes = await fetch(`https://api.airtable.com/v0/${baseId}/Assets/${assetId}`, { headers });
    const asset    = await assetRes.json();
    if (!asset || !asset.fields) return res.status(404).json({ error: 'Asset not found' });

    const assetTypeIds = asset.fields['Asset Type'] || [];
    if (!assetTypeIds.length) return res.status(400).json({ error: 'Asset has no Asset Type assigned' });

    const assetClassId = assetTypeIds[0];
    const classRes     = await fetch(`https://api.airtable.com/v0/${baseId}/Asset%20Classes/${assetClassId}`, { headers });
    const classRecord  = await classRes.json();
    const assetClassName = (classRecord.fields && classRecord.fields['Asset Class Name']) || '';
    const assetScore   = parseFloat(asset.fields['Asset Health Score']) || 72;
    const assetName    = asset.fields['Asset Name'] || asset.fields['Name'] || 'Asset';

    // Fetch all active rubric questions with pagination
    let allQuestions = [];
    let offset = null;
    do {
      let url = `https://api.airtable.com/v0/${baseId}/Rubric%20Questions?filterByFormula=%7BActive%7D%3D1`;
      if (offset) url += `&offset=${encodeURIComponent(offset)}`;
      const qRes  = await fetch(url, { headers });
      const qData = await qRes.json();
      allQuestions = allQuestions.concat(qData.records || []);
      offset = qData.offset || null;
    } while (offset);

    // Filter by asset class and frequency tier
    const filtered = allQuestions.filter(q => {
      const qClassIds = q.fields['Asset Classes'] || [];
      const qTier     = q.fields['Frequency Tier'];
      return tiers.includes(qTier) && qClassIds.includes(assetClassId);
    });

    // Sort by tier then question ID
    const tierOrder = ['W','M','Q','SA','A'];
    filtered.sort((a, b) => {
      const ao = tierOrder.indexOf(a.fields['Frequency Tier']);
      const bo = tierOrder.indexOf(b.fields['Frequency Tier']);
      if (ao !== bo) return ao - bo;
      return (a.fields['Question ID'] || 0) - (b.fields['Question ID'] || 0);
    });

    function buildAnswers(f, qType) {
      if (qType === 'CL') {
        return [
          { label:'Excellent',    desc: f['Answer Excellent']    || '', score: 100 },
          { label:'Good',         desc: f['Answer Good']         || '', score: 75  },
          { label:'Fair',         desc: f['Answer Fair']         || '', score: 50  },
          { label:'Degraded',     desc: f['Answer Degraded']     || '', score: 25  },
          { label:'Needs Repair', desc: f['Answer Needs Repair'] || '', score: 0   }
        ];
      }
      if (qType === 'YN') return [
        { label:'Yes', desc:'Completed this visit', score: 100 },
        { label:'No',  desc:'Not completed this visit', score: 0 }
      ];
      if (qType === 'SV') return [
        { label:'Tested — Passed', desc:'Safety device tested and tripped at correct setpoint', score: 100 },
        { label:'Tested — Failed', desc:'Safety device did not trip correctly — service required', score: 0 },
        { label:'Not Tested',      desc:'Not tested this visit', score: 50 }
      ];
      if (qType === 'CV') return [
        { label:'Calibrated',     desc:'Instrument verified accurate against reference', score: 100 },
        { label:'Adjusted',       desc:'Found out of calibration — adjustment made', score: 75 },
        { label:'Not Calibrated', desc:'Not calibrated this visit', score: 50 }
      ];
      return [];
    }

    const questions = filtered.map(q => {
      const f     = q.fields;
      const qType = f['Question Type'] || 'CL';
      return {
        id:            q.id,
        questionId:    f['Question ID'],
        group:         f['Section']        || 'General',
        text:          f['Question Text']  || '',
        weight:        (f['Score Weight']  || 'Medium').toLowerCase(),
        type:          qType,
        scoreTag:      f['Score Tag']      || 'H',
        frequencyTier: f['Frequency Tier'] || 'W',
        answers:       buildAnswers(f, qType)
      };
    });

    res.json({ assetName, assetClass: assetClassName, assetScore, inspType, questionCount: questions.length, questions });

  } catch (err) {
    console.error('Rubric fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch rubric questions' });
  }
});

// ── INSPECTION SUBMIT API ────────────────────────────────
app.post('/api/inspection/submit', requireAuth, async (req, res) => {
  try {
    const fetch  = (await import('node-fetch')).default;
    const baseId = process.env.AIRTABLE_BASE_ID;
    const apiKey = process.env.AIRTABLE_API_KEY;
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

    const { assetId, siteName, inspType, healthScore, responses, openObservation, urgency } = req.body;
    const now = new Date().toISOString();

    // Create Assessment record
    const assessRes = await fetch(`https://api.airtable.com/v0/${baseId}/Assessments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        fields: {
          'Assessment Date':     now.split('T')[0],
          'Assessment Type':     inspType,
          'Asset':               [assetId],
          'Health Score Result': healthScore,
          'Status':              'Complete',
          'Submitted At':        now,
          'Notes':               openObservation || ''
        }
      })
    });
    const assessment   = await assessRes.json();
    const assessmentId = assessment.id;
    if (!assessmentId) {
      console.error('Assessment creation failed:', assessment);
      return res.status(500).json({ error: 'Failed to create assessment record' });
    }

    // Create Inspection Response records in batches of 10
    const responseRecords = (responses || [])
      .filter(r => r.answerIndex !== null)
      .map(r => ({
        fields: {
          'Assessment':               [assessmentId],
          'Rubric Question':          [r.questionId],
          'Asset':                    [assetId],
          'Response Condition Label': r.answerLabel || '',
          'Score Contribution':       r.answerScore || 0,
          'Score Tag':                r.scoreTag    || 'H',
          'Submitted At':             now
        }
      }));

    const batches = [];
    for (let i = 0; i < responseRecords.length; i += 10) {
      batches.push(responseRecords.slice(i, i + 10));
    }
    await Promise.all(batches.map(batch =>
      fetch(`https://api.airtable.com/v0/${baseId}/Inspection%20Responses`, {
        method: 'POST', headers, body: JSON.stringify({ records: batch })
      })
    ));

    // Update asset last inspection date
    const dateFieldMap = {
      'Weekly':      'Last Weekly Inspection',
      'Monthly':     'Last Monthly Inspection',
      'Quarterly':   'Last Quarterly Inspection',
      'Semi Annual': 'Last Semi Annual Inspection',
      'Annual':      'Last Annual Inspection'
    };
    const dateField = dateFieldMap[inspType] || 'Last Weekly Inspection';
    await fetch(`https://api.airtable.com/v0/${baseId}/Assets/${assetId}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ fields: { [dateField]: now.split('T')[0] } })
    });

    res.json({ success: true, assessmentId });

  } catch (err) {
    console.error('Inspection submit error:', err);
    res.status(500).json({ error: 'Failed to submit inspection' });
  }
});

app.listen(port, () => {
  console.log(`MASSCORE running at http://localhost:${port}`);
});
