const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ─────────────────────────────────────────────────────────────

const HS_BASE = 'https://api.hubapi.com';

function hsHeaders() {
  return {
    Authorization: `Bearer ${HUBSPOT_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

/** Normalize a phone string to E.164 (US default) */
function normalizePhone(raw) {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

/** Map bookmarklet disposition to HubSpot call status */
function mapDisposition(disp) {
  if (!disp) return 'NO_ANSWER';
  if (disp.includes('Connected')) return 'COMPLETED';
  if (disp.includes('Voicemail')) return 'COMPLETED';
  if (disp.includes('Callback'))  return 'COMPLETED';
  if (disp.includes('No Answer')) return 'NO_ANSWER';
  return 'NO_ANSWER';
}

/** Search HubSpot for a contact by phone number */
async function findContactByPhone(phone) {
  const e164 = normalizePhone(phone);
  const last10 = e164.replace(/\D/g, '').slice(-10);

  // Try exact match on phone property first
  let res = await fetch(`${HS_BASE}/crm/v3/objects/contacts/search`, {
    method: 'POST',
    headers: hsHeaders(),
    body: JSON.stringify({
      filterGroups: [{
        filters: [{
          propertyName: 'phone',
          operator: 'EQ',
          value: e164,
        }],
      }],
      limit: 1,
    }),
  });

  let data = await res.json();
  if (data.total > 0) return data.results[0];

  // Fallback: search calculated phone number with last 10 digits
  res = await fetch(`${HS_BASE}/crm/v3/objects/contacts/search`, {
    method: 'POST',
    headers: hsHeaders(),
    body: JSON.stringify({
      filterGroups: [{
        filters: [{
          propertyName: 'hs_searchable_calculated_phone_number',
          operator: 'CONTAINS_TOKEN',
          value: last10,
        }],
      }],
      limit: 1,
    }),
  });

  data = await res.json();
  if (data.total > 0) return data.results[0];

  return null;
}

// ── Routes ──────────────────────────────────────────────────────────────

/** Health check */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/** POST /api/calls — Log a call to HubSpot */
app.post('/api/calls', async (req, res) => {
  try {
    const { phone, name, company, title, disposition, notes, duration, linkedin } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'phone is required' });
    }

    const e164 = normalizePhone(phone);
    const hsStatus = mapDisposition(disposition);

    // Find matching contact
    const contact = await findContactByPhone(phone);

    // Build call properties
    const callBody = {
      properties: {
        hs_timestamp: new Date().toISOString(),
        hs_call_title: `Clipbook Dialer — ${name || 'Unknown'}`,
        hs_call_body: [
          notes || '',
          disposition ? `Disposition: ${disposition}` : '',
          company ? `Company: ${company}` : '',
          title ? `Title: ${title}` : '',
          linkedin ? `LinkedIn: ${linkedin}` : '',
        ].filter(Boolean).join('\n'),
        hs_call_duration: String((duration || 0) * 1000),
        hs_call_to_number: e164,
        hs_call_direction: 'OUTBOUND',
        hs_call_status: hsStatus,
      },
    };

    // Associate with contact if found
    if (contact) {
      callBody.associations = [{
        to: { id: contact.id },
        types: [{
          associationCategory: 'HUBSPOT_DEFINED',
          associationTypeId: 194,
        }],
      }];
    }

    const hsRes = await fetch(`${HS_BASE}/crm/v3/objects/calls`, {
      method: 'POST',
      headers: hsHeaders(),
      body: JSON.stringify(callBody),
    });

    const hsData = await hsRes.json();

    if (!hsRes.ok) {
      console.error('HubSpot create call error:', hsData);
      return res.status(hsRes.status).json({ error: 'HubSpot API error', details: hsData });
    }

    res.json({
      success: true,
      hubspotCallId: hsData.id,
      contactId: contact ? contact.id : null,
    });
  } catch (err) {
    console.error('POST /api/calls error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** GET /api/calls/history?phone=... — Check call history for a phone number */
app.get('/api/calls/history', async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) {
      return res.status(400).json({ error: 'phone query param is required' });
    }

    const e164 = normalizePhone(phone);

    const hsRes = await fetch(`${HS_BASE}/crm/v3/objects/calls/search`, {
      method: 'POST',
      headers: hsHeaders(),
      body: JSON.stringify({
        filterGroups: [{
          filters: [{
            propertyName: 'hs_call_to_number',
            operator: 'EQ',
            value: e164,
          }],
        }],
        sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
        properties: ['hs_call_title', 'hs_call_body', 'hs_call_status', 'hs_timestamp',
                     'hs_call_duration', 'hs_call_to_number'],
        limit: 1,
      }),
    });

    const data = await hsRes.json();

    if (!data.total || data.total === 0) {
      return res.json({ found: false });
    }

    const call = data.results[0].properties;
    res.json({
      found: true,
      callId: data.results[0].id,
      status: call.hs_call_status,
      title: call.hs_call_title,
      body: call.hs_call_body,
      date: call.hs_timestamp,
      duration: call.hs_call_duration,
    });
  } catch (err) {
    console.error('GET /api/calls/history error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** GET /api/calls/log — Full call log from HubSpot */
app.get('/api/calls/log', async (req, res) => {
  try {
    const hsRes = await fetch(`${HS_BASE}/crm/v3/objects/calls/search`, {
      method: 'POST',
      headers: hsHeaders(),
      body: JSON.stringify({
        filterGroups: [{
          filters: [
            {
              propertyName: 'hs_call_direction',
              operator: 'EQ',
              value: 'OUTBOUND',
            },
            {
              propertyName: 'hs_call_title',
              operator: 'CONTAINS_TOKEN',
              value: 'Clipbook Dialer',
            },
          ],
        }],
        sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
        properties: ['hs_call_title', 'hs_call_body', 'hs_call_status', 'hs_timestamp',
                     'hs_call_duration', 'hs_call_to_number', 'hs_call_direction'],
        limit: 100,
      }),
    });

    const data = await hsRes.json();

    const calls = (data.results || []).map(c => {
      const p = c.properties;
      // Parse name from title "Clipbook Dialer — Name"
      const namePart = (p.hs_call_title || '').replace('Clipbook Dialer — ', '');
      // Parse structured fields from body
      const body = p.hs_call_body || '';
      const lines = body.split('\n');
      let notes = '', disp = '', company = '', title = '', linkedin = '';
      const structured = [];
      lines.forEach(line => {
        if (line.startsWith('Disposition: ')) { disp = line.replace('Disposition: ', ''); structured.push(line); }
        else if (line.startsWith('Company: ')) { company = line.replace('Company: ', ''); structured.push(line); }
        else if (line.startsWith('Title: ')) { title = line.replace('Title: ', ''); structured.push(line); }
        else if (line.startsWith('LinkedIn: ')) { linkedin = line.replace('LinkedIn: ', ''); structured.push(line); }
      });
      // Notes are any lines that aren't structured metadata
      notes = lines.filter(l => !structured.includes(l)).join('\n').trim();

      return {
        id: c.id,
        name: namePart,
        phone: p.hs_call_to_number || '',
        company,
        title,
        linkedin,
        disp: disp || p.hs_call_status || '',
        notes,
        duration: p.hs_call_duration ? Math.round(Number(p.hs_call_duration) / 1000) : 0,
        date: p.hs_timestamp,
      };
    });

    res.json({ calls });
  } catch (err) {
    console.error('GET /api/calls/log error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Start ───────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Clipbook Dialer backend running on port ${PORT}`);
  if (!HUBSPOT_API_KEY) {
    console.warn('WARNING: HUBSPOT_API_KEY environment variable is not set!');
  }
});
