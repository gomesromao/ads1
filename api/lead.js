// Vercel serverless function — port of Wix leads.web.js.
// POST /api/lead — JSON body: { name, email, company, apTool, phone, hiringTimeline, userAgent, stage }
// Stage flow: 'partial' (name+email) → 'partial2' (+company+apTool) → 'complete' (+phone+timeline).
// Always upserts to Supabase OS (RPC upsert_ad_lead). On 'complete': Slack + Resend + Meta CAPI.
// On 'partial' / 'partial2': lighter Slack + Resend only.

import crypto from 'node:crypto';

const LEAD_TAG    = 'Meta - Ramp/Brex Specialist';
const SOURCE_INFO = 'Meta Ads — /ad-expense-recon';
const PAGE_URL    = process.env.PAGE_URL || 'https://www.coconutva.com/ad-expense-recon';
const VALID_AP_TOOLS = ['Ramp', 'Brex', 'Bill.com', 'QuickBooks', 'NetSuite', 'Other'];
const VALID_TIMELINES = [
  'ASAP (within 2 weeks)',
  'Within the next month',
  '1 to 3 months',
  '3 to 6 months',
  'Just exploring for now'
];
const STAGES = ['partial', 'partial2', 'complete'];

const EMAIL_RECIPIENTS = [
  'tyler@coconutva.com',
  'daniel@coconutva.com',
  'conor@coconutva.com',
  'adell@coconutva.com'
];
const FROM_EMAIL = 'Coconut VA <notifications@coconutva.com>';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const raw = await readJson(req);
  const stage = STAGES.includes(raw && raw.stage) ? raw.stage : 'complete';
  const name = clean(raw && raw.name, 120);
  const email = clean(raw && raw.email, 160).toLowerCase();
  const company = clean(raw && raw.company, 160);
  const apTool = VALID_AP_TOOLS.includes(raw && raw.apTool) ? raw.apTool : null;
  const phone = clean(raw && raw.phone, 40);
  const hiringTimeline = VALID_TIMELINES.includes(raw && raw.hiringTimeline) ? raw.hiringTimeline : null;
  const userAgent = clean(raw && raw.userAgent, 400) || (req.headers['user-agent'] || '');

  if (!email || !isEmail(email)) return res.status(400).json({ ok: false, error: 'invalid_email' });
  if (!name) return res.status(400).json({ ok: false, error: 'missing_name' });

  const parts = name.split(/\s+/);
  const firstName = parts.shift() || null;
  const lastName = parts.length ? parts.join(' ') : null;

  // 1. Upsert no Coconut OS (sempre)
  let contactId = null;
  try {
    const supaUrl = process.env.SUPABASE_OS_URL;
    const supaKey = process.env.SUPABASE_OS_SERVICE_ROLE_KEY;
    if (!supaUrl || !supaKey) {
      console.error('SUPABASE env vars missing');
      return res.status(500).json({ ok: false, error: 'config_missing' });
    }
    const r = await fetch(`${supaUrl}/rest/v1/rpc/upsert_ad_lead`, {
      method: 'POST',
      headers: {
        apikey: supaKey,
        Authorization: `Bearer ${supaKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        p_email: email,
        p_full_name: name,
        p_first_name: firstName,
        p_last_name: lastName,
        p_company: company || null,
        p_ap_tool: apTool,
        p_lead_tag: LEAD_TAG,
        p_source_info: SOURCE_INFO,
        p_phone: phone || null,
        p_hiring_timeline: hiringTimeline
      })
    });
    if (!r.ok) {
      console.error('Supabase upsert failed', r.status, await r.text());
      return res.status(502).json({ ok: false, error: 'db_upsert_failed' });
    }
    const body = await r.json();
    contactId = typeof body === 'string' ? body : (body && body[0]) || null;
  } catch (e) {
    console.error('Supabase exception', e);
    return res.status(502).json({ ok: false, error: 'db_exception' });
  }

  const eventId = `lead_${contactId || Date.now()}`;

  if (stage === 'complete') {
    await safe(() => notifySlackComplete({ name, email, company, apTool, phone, hiringTimeline }), 'slack:complete');
    await safe(() => notifyEmailComplete({ name, email, company, apTool, phone, hiringTimeline }), 'email:complete');
    await safe(() => sendCapi({ email, phone, userAgent, eventId }), 'capi');
  } else if (stage === 'partial2') {
    await safe(() => notifySlackPartial2({ name, email, company, apTool }), 'slack:partial2');
    await safe(() => notifyEmailPartial2({ name, email, company, apTool }), 'email:partial2');
  } else {
    await safe(() => notifySlackPartial({ name, email }), 'slack:partial');
    await safe(() => notifyEmailPartial({ name, email }), 'email:partial');
  }

  return res.status(200).json({ ok: true, contactId, eventId, stage });
}

/* ===================== SIDE EFFECTS ===================== */

async function sendCapi({ email, phone, userAgent, eventId }) {
  const pixelId = process.env.META_PIXEL_ID;
  const token   = process.env.META_CAPI_ACCESS_TOKEN;
  if (!pixelId || !token) { console.warn('Meta secrets missing — CAPI skipped'); return; }
  const phoneDigits = digits(phone);
  const body = {
    data: [{
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_id: eventId,
      event_source_url: PAGE_URL,
      user_data: {
        em: [sha256(email)],
        ...(phoneDigits ? { ph: [sha256(phoneDigits)] } : {}),
        ...(userAgent ? { client_user_agent: userAgent } : {})
      },
      custom_data: { content_name: 'Ramp/Brex Specialist', content_category: 'Expense Recon Ad' }
    }]
  };
  const r = await fetch(`https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!r.ok) console.error('CAPI error', r.status, await r.text());
}

/* ===================== SLACK ===================== */

async function notifySlackComplete({ name, email, company, apTool, phone, hiringTimeline }) {
  const url = process.env.SLACK_WEBHOOK_AD_LEADS;
  if (!url) { console.warn('Slack webhook missing — complete skipped'); return; }
  await postSlack(url, {
    text: '🥥 New ad lead — Ramp/Brex Specialist',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '🥥 New ad lead — Ramp/Brex Specialist' } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Name:*\n${name}` },
        { type: 'mrkdwn', text: `*Work email:*\n${email}` },
        { type: 'mrkdwn', text: `*Company:*\n${company || '—'}` },
        { type: 'mrkdwn', text: `*AP tool:*\n${apTool || '—'}` },
        { type: 'mrkdwn', text: `*Phone:*\n${phone || '—'}` },
        { type: 'mrkdwn', text: `*Hiring:*\n${hiringTimeline || '—'}` }
      ]},
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Source: Meta Ads — /ad-expense-recon' }] }
    ]
  }, 'complete');
}

async function notifySlackPartial2({ name, email, company, apTool }) {
  const url = process.env.SLACK_WEBHOOK_AD_LEADS;
  if (!url) { console.warn('Slack webhook missing — partial2 skipped'); return; }
  await postSlack(url, {
    text: '🟠 Partial lead (step 2) — Ramp/Brex Specialist',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '🟠 Partial lead — step 2 of 3' } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Name:*\n${name}` },
        { type: 'mrkdwn', text: `*Work email:*\n${email}` },
        { type: 'mrkdwn', text: `*Company:*\n${company || '—'}` },
        { type: 'mrkdwn', text: `*AP tool:*\n${apTool || '—'}` }
      ]},
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Phone / hiring timeline not yet provided. Source: Meta Ads — /ad-expense-recon' }] }
    ]
  }, 'partial2');
}

async function notifySlackPartial({ name, email }) {
  const url = process.env.SLACK_WEBHOOK_AD_LEADS;
  if (!url) { console.warn('Slack webhook missing — partial skipped'); return; }
  await postSlack(url, {
    text: '🟡 Partial lead (step 1) — Ramp/Brex Specialist',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '🟡 Partial lead — step 1 of 3' } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Name:*\n${name}` },
        { type: 'mrkdwn', text: `*Work email:*\n${email}` }
      ]},
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Name + email captured. Source: Meta Ads — /ad-expense-recon' }] }
    ]
  }, 'partial');
}

async function postSlack(url, payload, tag) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) console.error(`Slack webhook (${tag}) error`, r.status, await r.text());
}

/* ===================== EMAIL (Resend) ===================== */

async function notifyEmailComplete({ name, email, company, apTool, phone, hiringTimeline }) {
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0B1E3F;line-height:1.5">
      <h2 style="color:#0B1E3F;margin:0 0 12px">🥥 New ad lead — Ramp/Brex Specialist</h2>
      <p style="margin:4px 0"><strong>Name:</strong> ${esc(name)}</p>
      <p style="margin:4px 0"><strong>Work email:</strong> ${esc(email)}</p>
      <p style="margin:4px 0"><strong>Company:</strong> ${esc(company || '—')}</p>
      <p style="margin:4px 0"><strong>AP tool:</strong> ${esc(apTool || '—')}</p>
      <p style="margin:4px 0"><strong>Phone:</strong> ${esc(phone || '—')}</p>
      <p style="margin:4px 0"><strong>Hiring:</strong> ${esc(hiringTimeline || '—')}</p>
      <p style="margin:16px 0 0;color:#888;font-size:12px">Source: Meta Ads — /ad-expense-recon</p>
    </div>`;
  await sendEmail(`New ad lead — ${name}${company ? ' @ ' + company : ''}`, html, 'complete');
}

async function notifyEmailPartial2({ name, email, company, apTool }) {
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0B1E3F;line-height:1.5">
      <h2 style="color:#0B1E3F;margin:0 0 12px">🟠 Partial lead (step 2 of 3) — Ramp/Brex Specialist</h2>
      <p style="margin:4px 0"><strong>Name:</strong> ${esc(name)}</p>
      <p style="margin:4px 0"><strong>Work email:</strong> ${esc(email)}</p>
      <p style="margin:4px 0"><strong>Company:</strong> ${esc(company || '—')}</p>
      <p style="margin:4px 0"><strong>AP tool:</strong> ${esc(apTool || '—')}</p>
      <p style="margin:16px 0 0;color:#888;font-size:12px">Phone / hiring timeline not yet provided. Source: Meta Ads — /ad-expense-recon</p>
    </div>`;
  await sendEmail(`Partial lead (step 2) — ${name}`, html, 'partial2');
}

async function notifyEmailPartial({ name, email }) {
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0B1E3F;line-height:1.5">
      <h2 style="color:#0B1E3F;margin:0 0 12px">🟡 Partial lead (step 1 of 3) — Ramp/Brex Specialist</h2>
      <p style="margin:4px 0"><strong>Name:</strong> ${esc(name)}</p>
      <p style="margin:4px 0"><strong>Work email:</strong> ${esc(email)}</p>
      <p style="margin:4px 0;color:#888;font-size:12px">Name + email captured. Source: Meta Ads — /ad-expense-recon</p>
    </div>`;
  await sendEmail(`Partial lead (step 1) — ${name}`, html, 'partial');
}

async function sendEmail(subject, html, tag) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn(`Resend key missing — email ${tag} skipped`); return; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to: EMAIL_RECIPIENTS, subject, html })
  });
  if (!r.ok) console.error(`Resend (${tag}) error`, r.status, await r.text());
}

/* ===================== HELPERS ===================== */

function clean(v, max) { return (typeof v === 'string' ? v : '').trim().slice(0, max); }
function isEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function digits(s) { return String(s || '').replace(/\D/g, ''); }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

async function safe(fn, tag) {
  try { await fn(); } catch (e) { console.error(`Side-effect ${tag} failed`, e); }
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
