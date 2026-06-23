// ============================================================
//  Scaling with JB — AI Visibility Audit backend
//  Runs Sonnet 4.6 → builds report → emails it via Resend
//  Deploy to Railway with env vars:
//    ANTHROPIC_API_KEY, RESEND_API_KEY, ALLOWED_ORIGIN, FROM_EMAIL
// ============================================================
const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://scalingwithjb.com';
const FROM_EMAIL = process.env.FROM_EMAIL || 'Jen at Scaling with JB <hello@scalingwithjb.com>';
const MAX_SCANS_PER_DAY = 1;

// ---- simple in-memory IP rate limiter (1/day, same domain = free recheck) ----
const rateLimits = {};
function checkAndRecord(ip, domain) {
  const today = new Date().toDateString();
  if (!rateLimits[ip] || rateLimits[ip].date !== today) rateLimits[ip] = { date: today, count: 0, domains: [] };
  const d = rateLimits[ip];
  if (d.domains.includes(domain)) return true;
  if (d.count >= MAX_SCANS_PER_DAY) return false;
  d.count++; d.domains.push(domain); return true;
}
setInterval(() => {
  const today = new Date().toDateString();
  for (const ip in rateLimits) if (rateLimits[ip].date !== today) delete rateLimits[ip];
}, 3600000);

// ---- the Sonnet prompt ----
const PROMPT = (domain) => `You are an expert AI visibility and digital marketing analyst. Research the business at "${domain}" using web search.

Provide a realistic, honest, specific AI visibility audit for this exact business. Research thoroughly: what they do, where they're located, who their customers are, web presence, reviews, citations, and how AI assistants currently treat them.

SCORING — be precise and honest based on real signals found:
- Global household name (Nike, Amazon, Starbucks): 82-98, Strong
- Well-known regional/national brand with strong reviews + citations: 55-78, Moderate
- Local business with some online presence but limited AI signals: 28-52, Weak
- Brand with minimal verifiable online presence: 5-27, Absent

For platforms, base verdicts on how each AI sources recommendations. ChatGPT draws from training + web; Gemini ties to Google Business/Maps; Perplexity uses live web citations; Copilot uses Bing index.

Issues and opportunities must be SPECIFIC to what you actually found — not generic advice. For the full report, also provide deeper detail: competitor names if findable, citation sources to target, and a prioritised fix roadmap.

Return ONLY valid minified JSON — no markdown, no backticks, nothing else:
{"brand":"","category":"","location":"","overall_score":0,"verdict":"Strong|Moderate|Weak|Absent","summary":"2 sentences max, specific to this business","platforms":[{"name":"ChatGPT","verdict":"Strong|Moderate|Weak|Absent","reason":"specific 1 sentence"},{"name":"Gemini","verdict":"","reason":""},{"name":"Perplexity","verdict":"","reason":""},{"name":"Copilot","verdict":"","reason":""}],"issues":["specific issue 1 - max 15 words","specific issue 2","specific issue 3"],"opportunities":["specific opportunity 1 - max 15 words","specific opportunity 2","specific opportunity 3"],"competitors":["competitor or brand getting recommended instead 1","2","3"],"citation_sources":["source to get listed on 1","2","3"],"roadmap":[{"fix":"priority fix 1","impact":"High|Medium|Quick win"},{"fix":"priority fix 2","impact":""},{"fix":"priority fix 3","impact":""},{"fix":"priority fix 4","impact":""}]}`;

// ---- call Anthropic ----
function runSonnet(domain) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: PROMPT(domain) }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }]
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(payload)
      }
    }, apiRes => {
      let data = '';
      apiRes.on('data', c => data += c);
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = (parsed.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
          const clean = text.replace(/```json|```/g, '').trim();
          const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
          if (s < 0 || e < 0) throw new Error('no JSON in model response');
          resolve(JSON.parse(clean.slice(s, e + 1)));
        } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

// ---- build the branded HTML report email ----
function buildReportEmail(r, name, domain) {
  const peri = '#7C6CF2', ink = '#16162B', slate = '#5A5A72', line = '#ECE9F7';
  const vColor = v => v === 'Strong' ? '#16A34A' : v === 'Moderate' ? '#B7791F' : v === 'Weak' ? '#DC4A3D' : '#9CA3AF';
  const score = Math.max(3, Math.min(99, parseInt(r.overall_score) || 40));
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const platRows = (r.platforms || []).map(p => `
    <tr><td style="padding:11px 0;border-bottom:1px solid ${line}">
      <strong style="color:${ink};font-size:15px">${esc(p.name)}</strong><br>
      <span style="color:${slate};font-size:13px">${esc(p.reason)}</span>
    </td><td style="padding:11px 0;border-bottom:1px solid ${line};text-align:right;vertical-align:top">
      <span style="background:${vColor(p.verdict)}1A;color:${vColor(p.verdict)};font-size:12px;font-weight:700;padding:4px 11px;border-radius:20px">${esc(p.verdict)}</span>
    </td></tr>`).join('');
  const li = (arr, color) => (arr || []).map(t => `<tr><td style="padding:6px 0;vertical-align:top;width:18px"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${color};margin-top:7px"></span></td><td style="padding:6px 0;color:${ink};font-size:14px;line-height:1.5">${esc(t)}</td></tr>`).join('');
  const road = (r.roadmap || []).map((x, i) => `<tr><td style="padding:9px 0;border-bottom:1px solid ${line};vertical-align:top;width:30px"><span style="display:inline-block;width:24px;height:24px;border-radius:7px;background:${peri};color:#fff;font-size:13px;font-weight:700;text-align:center;line-height:24px">${i + 1}</span></td><td style="padding:9px 0;border-bottom:1px solid ${line};color:${ink};font-size:14px;font-weight:600">${esc(x.fix)}</td><td style="padding:9px 0;border-bottom:1px solid ${line};text-align:right;color:${slate};font-size:12px;font-weight:700">${esc(x.impact)}</td></tr>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#EEECF7;font-family:'Helvetica Neue',Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEECF7;padding:28px 14px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;max-width:600px;width:100%">
  <tr><td style="background:linear-gradient(120deg,#1B1838,#2D2858);padding:30px 34px">
    <div style="color:#A99BFF;font-size:12px;font-weight:700;letter-spacing:.12em">SCALING WITH JB</div>
    <div style="color:#fff;font-size:23px;font-weight:800;margin-top:8px">Your AI Visibility Report</div>
    <div style="color:#A9A4CE;font-size:13px;margin-top:4px">Prepared for ${esc(r.brand || domain)}</div>
  </td></tr>
  <tr><td style="padding:30px 34px">
    <p style="color:${ink};font-size:15px;line-height:1.6;margin:0 0 22px">Hi ${esc(name)},<br><br>Here's your full AI Visibility Report for <strong>${esc(domain)}</strong>. This shows how visible your business is when customers ask AI assistants like ChatGPT and Gemini for recommendations — and exactly what to improve.</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F0FF;border-radius:14px;margin-bottom:24px"><tr>
      <td style="padding:22px 26px;vertical-align:middle;width:120px">
        <div style="font-size:44px;font-weight:800;color:${vColor(r.verdict)};line-height:1">${score}</div>
        <div style="font-size:12px;color:${slate};font-weight:700;letter-spacing:.05em">OUT OF 100</div>
      </td>
      <td style="padding:22px 26px 22px 0;vertical-align:middle">
        <div style="font-size:13px;font-weight:800;color:${vColor(r.verdict)};text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px">${esc(r.verdict)} visibility</div>
        <div style="font-size:14px;color:${ink};line-height:1.5">${esc(r.summary)}</div>
      </td>
    </tr></table>

    <div style="font-size:12px;font-weight:800;color:${peri};text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Visibility across AI assistants</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">${platRows}</table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px"><tr>
      <td width="50%" style="vertical-align:top;padding-right:10px">
        <div style="font-size:12px;font-weight:800;color:#DC4A3D;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Top issues</div>
        <table role="presentation" cellpadding="0" cellspacing="0">${li(r.issues, '#DC4A3D')}</table>
      </td>
      <td width="50%" style="vertical-align:top;padding-left:10px">
        <div style="font-size:12px;font-weight:800;color:#16A34A;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Opportunities</div>
        <table role="presentation" cellpadding="0" cellspacing="0">${li(r.opportunities, '#16A34A')}</table>
      </td>
    </tr></table>

    ${(r.roadmap && r.roadmap.length) ? `<div style="font-size:12px;font-weight:800;color:${peri};text-transform:uppercase;letter-spacing:.06em;margin:24px 0 8px">Your priority fix roadmap</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px">${road}</table>` : ''}

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;background:#1B1838;border-radius:14px"><tr><td style="padding:26px 28px;text-align:center">
      <div style="color:#fff;font-size:18px;font-weight:800;margin-bottom:8px">Want help turning this into real growth?</div>
      <div style="color:#C4BFDF;font-size:14px;line-height:1.55;margin-bottom:18px">Book a free 15-minute strategy call and we'll review your audit together — then map out a plan across AI visibility, paid ads, content and tracking.</div>
      <a href="https://scalingwithjb.com/ai-visibility.html" style="display:inline-block;background:${peri};color:#fff;text-decoration:none;font-size:15px;font-weight:700;padding:14px 28px;border-radius:11px">Book your free 15-min call</a>
    </td></tr></table>

    <p style="color:${slate};font-size:13px;line-height:1.6;margin:24px 0 0">Talk soon,<br><strong style="color:${ink}">Jen</strong><br>Scaling with JB</p>
  </td></tr>
  <tr><td style="background:#16162B;padding:18px 34px;text-align:center">
    <span style="color:#8B86B8;font-size:12px">hello@scalingwithjb.com &nbsp;·&nbsp; scalingwithjb.com</span>
  </td></tr>
</table></td></tr></table></body></html>`;
}

// ---- send via Resend ----
function sendReport(toEmail, name, html) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      from: FROM_EMAIL, to: [toEmail],
      subject: 'Your AI Visibility Report is ready',
      html: html
    });
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + RESEND_KEY,
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => (res.statusCode < 300 ? resolve(data) : reject(new Error('Resend ' + res.statusCode + ': ' + data))));
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

// ---- HTTP server ----
const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('AI Visibility API running'); return; }
  if (req.method !== 'POST' || req.url !== '/api/scan') { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    let domain, name, email;
    try {
      const p = JSON.parse(body);
      domain = (p.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*/, '');
      name = (p.name || 'there').trim().slice(0, 60);
      email = (p.email || '').trim();
      if (!domain || !/^([a-z0-9](-?[a-z0-9])*\.)+[a-z]{2,}$/.test(domain)) throw new Error('bad domain');
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid request' })); return;
    }

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    if (!checkAndRecord(ip, domain)) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Daily limit reached' })); return; }

    try {
      const result = await runSonnet(domain);
      // Return the snapshot to the page right away
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      // Then email the full report in the background (don't block the response)
      if (email && RESEND_KEY) {
        const html = buildReportEmail(result, name, domain);
        sendReport(email, name, html).catch(err => console.error('Email failed:', err.message));
      }
    } catch (e) {
      console.error('Scan failed:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Audit failed', detail: e.message }));
    }
  });
});
server.listen(PORT, () => console.log('AI Visibility API on port ' + PORT));
