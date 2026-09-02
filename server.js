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

// Dashboard - requires auth.
// A user with no sites assigned has nothing to look at, so send them
// straight into onboarding rather than rendering an empty dashboard.
app.get('/dashboard', requireAuth, (req, res) => {
  const sites = req.session.user.sites;           // null = access to everything
  const needsOnboarding = Array.isArray(sites) && sites.length === 0;
  if (needsOnboarding && !req.query.skip) return res.redirect('/onboarding');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Onboarding wizard - requires auth
app.get('/onboarding', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'onboarding.html'));
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

// ── ONBOARDING: create site, systems and assets ──────────
// Takes the wizard answers and builds the skeleton in Airtable.
// Returns the new site id plus the first asset id so the wizard
// can hand straight off to asset registration.
app.post('/api/onboarding/structure', requireAuth, async (req, res) => {
  try {
    const fetch  = (await import('node-fetch')).default;
    const baseId = process.env.AIRTABLE_BASE_ID;
    const apiKey = process.env.AIRTABLE_API_KEY;
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

    const {
      site,                  // "Pepsi - Houston"
      plantType,             // cold | chiller | process
      compressorType,        // screw | recip | mixed
      liquidFeed,            // pumped | pumper | gravity
      compressorCount,
      condenserCount,
      stages                 // [{ v: 19, label: "19F", evap: 11 }, ...]
    } = req.body;

    if (!site) return res.status(400).json({ error: 'Site name is required' });

    const created = async (table, fields) => {
      const r = await fetch(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`, {
        method: 'POST', headers, body: JSON.stringify({ fields })
      });
      const j = await r.json();
      if (!r.ok) {
        const detail = (j && j.error && (j.error.message || j.error.type)) || JSON.stringify(j);
        console.error(`[ONBOARD] ${table} create failed:`, detail, 'fields sent:', JSON.stringify(fields));
        const e = new Error(`${table}: ${detail}`);
        e.detail = detail;
        throw e;
      }
      return j;
    };

    // ── Site ──
    // Plant Type options in Airtable: COLD STORAGE / CHILLER / PROCESS
    const PLANT_TYPE = { cold:'COLD STORAGE', chiller:'CHILLER', process:'PROCESS' };
    const siteFields = { 'Site Name': site };
    if (PLANT_TYPE[plantType]) siteFields['Plant Type'] = PLANT_TYPE[plantType];

    const siteRec = await created('Sites', siteFields);
    const siteId = siteRec.id;

    // ── Work out the systems ──
    const nComp = Math.max(0, parseInt(compressorCount, 10) || 0);
    const nCond = (parseInt(condenserCount, 10) > 0)
      ? parseInt(condenserCount, 10)
      : Math.max(2, Math.ceil(nComp / 2));

    const sorted = (Array.isArray(stages) ? stages : [])
      .slice()
      .sort((a, b) => b.v - a.v);              // warmest first, down the pressure ladder

    const plan = [];

    if (nComp > 0) {
      const label = compressorType === 'recip' ? 'RECIPROCATING COMPRESSOR'
                  : compressorType === 'screw' ? 'ROTARY SCREW COMPRESSOR'
                  : 'ROTARY SCREW COMPRESSOR';
      plan.push({
        system: 'Compressors',
        crit: 'MAJOR',
        assets: Array.from({ length: nComp }, (_, i) => ({
          name: `${compressorType === 'recip' ? 'RC' : 'C'}-${i + 1}`,
          type: 'COMPRESSOR',
          cls:  label
        }))
      });
    }

    plan.push({
      system: 'Condensing',
      crit: 'MAJOR',
      assets: [
        ...Array.from({ length: nCond }, (_, i) => ({
          name: `Condenser ${i + 1}`, type: 'CONDENSER', cls: 'EVAPORATIVE CONDENSER'
        })),
        { name: 'Liquid Receiver', type: 'VESSEL', cls: 'PRESSURE VESSEL' }
      ]
    });

    sorted.forEach(st => {
      const assets = [{ name: `${st.label} Vessel`, type: 'VESSEL', cls: 'PRESSURE VESSEL' }];
      if (liquidFeed === 'pumped') {
        assets.push({ name: `${st.label} Recirc Pump 1`, type: 'PUMP', cls: 'PUMP' });
        assets.push({ name: `${st.label} Recirc Pump 2`, type: 'PUMP', cls: 'PUMP' });
      }
      if (liquidFeed === 'pumper') {
        assets.push({ name: `${st.label} Pumper Drum`, type: 'VESSEL', cls: 'PUMPER DRUM' });
      }
      const nEvap = Math.max(0, parseInt(st.evap, 10) || 0);
      for (let i = 0; i < nEvap; i++) {
        assets.push({ name: `${st.label} Evap ${i + 1}`, type: 'EVAPORATORS', cls: 'EVAPORATOR' });
      }
      plan.push({ system: `${st.label} Stage`, crit: 'CRITICAL', assets });
    });

    if (plantType === 'chiller') {
      plan.push({
        system: 'Auxiliary',
        crit: 'MAJOR',
        assets: [
          { name: 'Glycol Tank - Supply', type: 'VESSEL', cls: 'PRESSURE VESSEL' },
          { name: 'Glycol Tank - Return', type: 'VESSEL', cls: 'PRESSURE VESSEL' },
          { name: 'Glycol Pump 1', type: 'PUMP', cls: 'PUMP' },
          { name: 'Glycol Pump 2', type: 'PUMP', cls: 'PUMP' },
          { name: 'Glycol Pump 3', type: 'PUMP', cls: 'PUMP' }
        ]
      });
    }

    // ── Create systems, then their assets ──
    const out = { site: siteId, systems: [], assets: [] };
    let firstAssetId = null;

    for (const block of plan) {
      // Systems Priority Weight is a formula driven by System Criticality,
      // so set the criticality and let the weight compute itself.
      const sysRec = await created('Systems', {
        'System Name': `${block.system} (${site})`,
        'Site': [siteId],
        'System Criticality': block.crit || 'CRITICAL'
      });
      out.systems.push({ id: sysRec.id, name: block.system });

      for (const a of block.assets) {
        const assetRec = await created('Assets', {
          'Asset Name':  `${a.name} (${site})`,
          'Asset Type':  a.type,
          'System':      [sysRec.id],
          'Site':        [siteId]
        });
        out.assets.push({ id: assetRec.id, name: a.name });
        if (!firstAssetId) firstAssetId = assetRec.id;
      }
    }

    out.firstAsset  = firstAssetId;
    out.systemCount = out.systems.length;
    out.assetCount  = out.assets.length;
    res.json(out);

  } catch (err) {
    console.error('[ONBOARD] structure failed:', err);
    res.status(500).json({ error: err.message || 'Failed to build structure' });
  }
});

// ── ONBOARDING: update an asset's registration details ───
app.post('/api/onboarding/asset', requireAuth, async (req, res) => {
  try {
    const fetch  = (await import('node-fetch')).default;
    const baseId = process.env.AIRTABLE_BASE_ID;
    const apiKey = process.env.AIRTABLE_API_KEY;
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

    const { assetId, fields } = req.body;
    if (!assetId) return res.status(400).json({ error: 'assetId is required' });

    const r = await fetch(`https://api.airtable.com/v0/${baseId}/Assets/${assetId}`, {
      method: 'PATCH', headers, body: JSON.stringify({ fields })
    });
    const j = await r.json();
    if (!r.ok) { console.error('[ONBOARD] asset patch failed', JSON.stringify(j)); throw new Error('patch'); }
    res.json({ success: true, id: j.id });

  } catch (err) {
    console.error('[ONBOARD] asset failed:', err);
    res.status(500).json({ error: 'Failed to update asset' });
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
      'Weekly':       ['W'],
      'Monthly':      ['W','M'],
      'Quarterly':    ['W','M','Q'],
      'Semi Annual':  ['W','M','Q','SA'],
      'Annual':       ['W','M','Q','SA','A'],
      'Onboarding':   [],
      'Reassessment': []
    };
    const tiers = tierMap[inspType] || ['W'];

    // Onboarding and Reassessment run the integrity question set, not the
    // frequency-based recurring set. Both pull RUBRIC TYPE = ONBOARDING.
    // What differs between them is how the scoring engine treats the answers,
    // which is driven by Assessment Type on the Assessments record.
    const integrityRun = (inspType === 'Onboarding' || inspType === 'Reassessment');

    // Fetch asset record
    const assetRes = await fetch(`https://api.airtable.com/v0/${baseId}/Assets/${assetId}`, { headers });
    const asset    = await assetRes.json();
    if (!asset || !asset.fields) return res.status(404).json({ error: 'Asset not found' });

    // Get asset class — field may be plain text or linked record array
    const assetClassRaw = asset.fields['Asset Class'];
    let assetClassName = '';

    if (!assetClassRaw || (Array.isArray(assetClassRaw) && !assetClassRaw.length)) {
      return res.status(400).json({ error: 'Asset has no Asset Class assigned — set Asset Class in Airtable' });
    }

    if (Array.isArray(assetClassRaw)) {
      const classRes    = await fetch(`https://api.airtable.com/v0/${baseId}/Asset%20Classes/${assetClassRaw[0]}`, { headers });
      const classRecord = await classRes.json();
      assetClassName    = (classRecord.fields && classRecord.fields['Asset Class Name']) || '';
    } else {
      assetClassName = String(assetClassRaw);
    }

    if (!assetClassName) {
      return res.status(400).json({ error: 'Could not resolve Asset Class name' });
    }

    const assetScore = parseFloat(asset.fields['Asset Health Score']) || 72;
    const assetName  = asset.fields['Asset Name'] || asset.fields['Name'] || 'Asset';

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

    // Look up the Asset Class record ID so we can match against questions
    // Questions store Asset Class as a linked record (array of record IDs)
    const allClassesRes  = await fetch(`https://api.airtable.com/v0/${baseId}/Asset%20Classes`, { headers });
    const allClassesData = await allClassesRes.json();
    const matchedClass   = (allClassesData.records || []).find(c =>
      (c.fields['Asset Class Name'] || '').toUpperCase().trim() === assetClassName.toUpperCase().trim()
    );

    if (!matchedClass) {
      return res.status(400).json({ error: 'Asset Class record not found in Asset Classes table: ' + assetClassName });
    }

    const assetClassRecordId = matchedClass.id;

    // Filter questions by Asset Class record ID, then by rubric type.
    // Single-select values are stored UPPERCASE in Airtable by convention,
    // so every comparison below normalises case before matching.
    const filtered = allQuestions.filter(q => {
      const qClassIds = q.fields['Asset Class'] || [];
      const classMatch = Array.isArray(qClassIds)
        ? qClassIds.includes(assetClassRecordId)
        : String(qClassIds).toUpperCase().trim() === assetClassName.toUpperCase().trim();
      if (!classMatch) return false;

      const rubricType = String(q.fields['Rubric Type'] || 'RECURRING').toUpperCase().trim();
      const qTier      = String(q.fields['Frequency Tier'] || '').toUpperCase().trim();

      if (integrityRun) return rubricType === 'ONBOARDING';
      return rubricType === 'RECURRING' && tiers.includes(qTier);
    });

    // Sort by tier then question ID
    // Onboarding questions carry no Frequency Tier, so they sort by Question ID
    // alone. Recurring questions sort by tier first, then ID.
    const tierOrder = ['W','M','Q','SA','A'];
    filtered.sort((a, b) => {
      if (!integrityRun) {
        const ao = tierOrder.indexOf(String(a.fields['Frequency Tier'] || '').toUpperCase().trim());
        const bo = tierOrder.indexOf(String(b.fields['Frequency Tier'] || '').toUpperCase().trim());
        if (ao !== bo) return ao - bo;
      }
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
      const qType = String(f['Question Type'] || 'CL').toUpperCase().trim();
      return {
        id:            q.id,
        questionId:    f['Question ID'],
        group:         f['Section']        || 'General',
        text:          f['Question Text']  || '',
        weight:        String(f['Score Weight'] || 'Medium').toLowerCase(),
        type:          qType,
        scoreTag:      String(f['Score Tag'] || 'H').toUpperCase(),
        frequencyTier: f['Frequency Tier'] || null,
        scope:         f['Question Scope'] || '',
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
  // Helper: safely uppercase for Airtable single-select fields
  // (MASSCORE convention: all single-select options are stored in all-caps for formula consistency)
  const upper = v => (v == null ? v : String(v).toUpperCase());

  try {
    const fetch  = (await import('node-fetch')).default;
    const baseId = process.env.AIRTABLE_BASE_ID;
    const apiKey = process.env.AIRTABLE_API_KEY;
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

    const { assetId, siteName, inspType, healthScore, responses, openObservation, urgency } = req.body;
    const now = new Date().toISOString();

    // ── STEP 1: Create Assessment record ───────────────────────
    const assessBody = {
      fields: {
        'Assessment Date':     now.split('T')[0],
        'Assessment Type':     upper(inspType),    // single-select → UPPERCASED
        'Asset':               [assetId],
        'Health Score Result': parseFloat(healthScore) || 0,
        'Status':              'COMPLETE',          // single-select → UPPERCASE literal
        'Notes':               openObservation || ''
      }
    };

    const assessRes = await fetch(`https://api.airtable.com/v0/${baseId}/Assessments`, {
      method: 'POST', headers, body: JSON.stringify(assessBody)
    });
    const assessment = await assessRes.json();

    if (!assessment.id) {
      console.error('[SUBMIT] STEP 1 failed — Assessment create:', JSON.stringify(assessment));
      return res.status(500).json({
        error: 'Failed to create assessment',
        step: 'STEP 1',
        detail: assessment.error || assessment
      });
    }
    const assessmentId = assessment.id;

    // ── STEP 2: Create Inspection Response records (batches of 10) ───
    const responseRecords = (responses || [])
      .filter(r => r.answerIndex !== null && r.answerIndex !== undefined)
      .map(r => ({
        fields: {
          'Assessment':               [assessmentId],
          'Rubric Question':          [r.questionId],
          'Asset':                    [assetId],
          'Response Condition Label': upper(r.answerLabel || ''),   // single-select → UPPERCASED
          'Score Contribution':       r.answerScore || 0,
          'Score Tag':                upper(r.scoreTag || 'H'),      // single-select → UPPERCASED
          'Submitted At':             now.split('T')[0]              // date-only (no time) — matches Airtable field type
        }
      }));

    const batchErrors = [];
    for (let i = 0; i < responseRecords.length; i += 10) {
      const batch = responseRecords.slice(i, i + 10);
      const batchRes = await fetch(`https://api.airtable.com/v0/${baseId}/Inspection%20Responses`, {
        method: 'POST', headers, body: JSON.stringify({ records: batch })
      });
      const batchBody = await batchRes.json();
      if (!batchRes.ok || batchBody.error) {
        batchErrors.push({ batchStartIndex: i, status: batchRes.status, error: batchBody.error || batchBody });
      }
    }

    if (batchErrors.length > 0) {
      console.error('[SUBMIT] STEP 2 failed — response batch errors:', JSON.stringify(batchErrors));
      return res.status(500).json({
        error: 'Failed to write inspection responses',
        step: 'STEP 2',
        assessmentId,
        batchErrors
      });
    }

    // ── STEP 3: Update asset last inspection date (non-fatal) ──────
    const dateFieldMap = {
      'Weekly':       'Last Weekly Inspection',
      'Monthly':      'Last Monthly Inspection',
      'Quarterly':    'Last Quarterly Inspection',
      'Semi Annual':  'Last Semi Annual Inspection',
      'Annual':       'Last Annual Inspection',
      'Onboarding':   'Last Onboarding',
      'Reassessment': 'Last Onboarding'
    };
    const dateField = dateFieldMap[inspType] || 'Last Weekly Inspection';

    // Onboarding also flags the asset as baselined.
    const patchFields = { [dateField]: now.split('T')[0] };
    if (inspType === 'Onboarding') patchFields['Onboarding Complete'] = true;

    const patchRes = await fetch(`https://api.airtable.com/v0/${baseId}/Assets/${assetId}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ fields: patchFields })
    });
    if (!patchRes.ok) {
      const patchBody = await patchRes.json().catch(() => ({}));
      console.warn('[SUBMIT] STEP 3 warning — asset date update failed (non-fatal):', JSON.stringify(patchBody));
      // Not fatal: inspection data is already saved. Just the asset's last-inspection-date didn't update.
    }

    console.log(`[SUBMIT] success — assessment ${assessmentId}, ${responseRecords.length} responses`);
    res.json({ success: true, assessmentId, responseCount: responseRecords.length });

  } catch (err) {
    console.error('[SUBMIT] UNCAUGHT ERROR:', err);
    res.status(500).json({ error: 'Failed to submit inspection', detail: err.message });
  }
});


// ── READINGS SUBMIT API ──────────────────────────────────
app.post('/api/readings/submit', requireAuth, async (req, res) => {
  try {
    const fetch  = (await import('node-fetch')).default;
    const baseId = process.env.AIRTABLE_BASE_ID;
    const apiKey = process.env.AIRTABLE_API_KEY;
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

    const { fields } = req.body;
    if (!fields) return res.status(400).json({ error: 'No fields provided' });

    const result = await fetch(`https://api.airtable.com/v0/${baseId}/Compressor%20Readings`, {
      method:  'POST',
      headers,
      body:    JSON.stringify({ fields })
    });
    const data = await result.json();

    if (!data.id) {
      console.error('[READINGS] Create failed:', JSON.stringify(data));
      return res.status(500).json({ error: 'Failed to save readings', detail: data.error || data });
    }

    res.json({ success: true, id: data.id });

  } catch (err) {
    console.error('[READINGS] Submit error:', err);
    res.status(500).json({ error: 'Failed to submit readings' });
  }
});

app.listen(port, () => {
  console.log(`MASSCORE running at http://localhost:${port}`);
});
