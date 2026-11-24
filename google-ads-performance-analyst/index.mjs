// Google Ads Performance Analyst: a Druve agent ported by hand from the n8n
// template "Automate monthly Google Ads performance analysis with GPT-4o,
// Sheets & Slack" by Nikan Noorafkan (https://n8n.io/workflows/10062).
// Draft for Nikan to check. Listed on Druve only by Nikan, under his own name.
//
// What it keeps, unchanged: the GAQL query word for word (ad id, RSA headlines,
// ad group name, impressions, clicks, CTR, last 30 days, impressions > 100,
// ordered by clicks, limit 1000), the "Prepare Performance Data" logic
// (group by ad group, first headline, the 100-impression floor, the theme list
// vegan / organic / natural / premium / sale / new / free shipping, top and
// bottom 5), the analyst system message and analysis prompt verbatim, the
// recommendation parsing, and the markdown report layout.
// What changes: no n8n credentials. The buyer either pastes the Google Ads
// search response (or simple rows / CSV), or passes their own Google Ads
// access token and developer token so the agent runs the same query itself.
// Instead of a Google Sheet, the report comes back as JSON and markdown; an
// optional Slack incoming-webhook URL posts it like the template's Slack node.
//
// Input (JSON), one of:
//   {"results": [ ...Google Ads googleAds:search results... ]}
//   {"rows": [{"ad_group": "Shoes", "headline": "Vegan running shoes", "impressions": 1200, "clicks": 60}]}
//   {"csv": "ad_group,headline,impressions,clicks\nShoes,Vegan running shoes,1200,60"}
//   {"google_ads": {"customer_id": "1234567890", "developer_token": "...", "access_token": "...",
//                   "login_customer_id": "optional", "api_version": "v18"}}
// Optional: "themes": ["..."] to replace the template's theme list,
//           "slack_webhook_url": "https://hooks.slack.com/services/..."
//
// Data-fetch hosts to declare when publishing: googleads.googleapis.com, hooks.slack.com
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", and publish. It runs on each
// buyer's own model key and Google Ads account, so it costs you nothing to run.

import { getModelClient } from '@druve/cli/providers';

// Author's query, verbatim (n8n node "Get Performance Data").
const GAQL = 'SELECT ad_group_ad.ad.id, ad_group_ad.ad.responsive_search_ad.headlines, ad_group.name, metrics.impressions, metrics.clicks, metrics.ctr FROM ad_group_ad WHERE segments.date DURING LAST_30_DAYS AND metrics.impressions > 100 ORDER BY metrics.clicks DESC LIMIT 1000';
// Author's system message, verbatim (n8n node "AI Agent - Analyze Performance").
const SYSTEM = 'You are a Google Ads performance analyst. Analyze the data and provide specific, actionable recommendations. Return valid JSON only.';
const THEMES = ['vegan', 'organic', 'natural', 'premium', 'sale', 'new', 'free shipping'];

function parseCsv(text) {
  const lines = String(text).trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const split = (l) => (l.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || [])
    .map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim());
  const head = split(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  return lines.slice(1).map((l) => {
    const cells = split(l);
    return Object.fromEntries(head.map((h, i) => [h, cells[i]]));
  });
}

// Simple rows are turned into the same shape the Google Ads API returns.
function rowsToResults(rows) {
  return rows.map((r) => ({
    adGroup: { name: r.ad_group || r.adgroup || r.category || r.campaign || 'Unknown' },
    adGroupAd: { ad: { responsiveSearchAd: { headlines: [{ text: r.headline || r.headline_1 || '' }] } } },
    metrics: {
      impressions: String(r.impressions ?? 0).replace(/,/g, ''),
      clicks: String(r.clicks ?? 0).replace(/,/g, ''),
      ctr: r.ctr ?? (Number(r.impressions) ? Number(r.clicks) / Number(r.impressions) : 0),
    },
  }));
}

async function fetchResults(g) {
  const ver = g.api_version || 'v18';
  const id = String(g.customer_id || '').replace(/-/g, '');
  const headers = {
    Authorization: `Bearer ${g.access_token}`,
    'developer-token': g.developer_token,
    'Content-Type': 'application/json',
  };
  if (g.login_customer_id) headers['login-customer-id'] = String(g.login_customer_id).replace(/-/g, '');
  const res = await fetch(`https://googleads.googleapis.com/${ver}/customers/${id}/googleAds:search`, {
    method: 'POST', headers, body: JSON.stringify({ query: GAQL }),
  });
  if (!res.ok) throw new Error(`Google Ads API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).results || [];
}

// "Prepare Performance Data", kept as the author wrote it.
function prepare(results, themes) {
  const categoryData = {};
  const themeData = {};
  results.forEach((result) => {
    const category = result.adGroup?.name || 'Unknown';
    const headlines = result.adGroupAd?.ad?.responsiveSearchAd?.headlines || [];
    const headline = headlines[0]?.text || '';
    const ctr = parseFloat(result.metrics?.ctr || 0);
    const impressions = parseInt(result.metrics?.impressions || 0);
    const clicks = parseInt(result.metrics?.clicks || 0);
    if (impressions < 100) return;
    if (!categoryData[category]) categoryData[category] = { impressions: 0, clicks: 0, ads: [] };
    categoryData[category].impressions += impressions;
    categoryData[category].clicks += clicks;
    categoryData[category].ads.push({ headline, ctr, impressions, clicks });
    themes.forEach((theme) => {
      if (headline.toLowerCase().includes(theme)) {
        if (!themeData[theme]) themeData[theme] = { impressions: 0, clicks: 0, count: 0 };
        themeData[theme].impressions += impressions;
        themeData[theme].clicks += clicks;
        themeData[theme].count += 1;
      }
    });
  });
  const categoryAnalysis = Object.entries(categoryData).map(([cat, data]) => ({
    category: cat,
    ctr: ((data.clicks / data.impressions) * 100).toFixed(2),
    total_impressions: data.impressions,
    total_clicks: data.clicks,
    ad_count: data.ads.length,
  })).sort((a, b) => parseFloat(b.ctr) - parseFloat(a.ctr));
  const themeAnalysis = Object.entries(themeData).map(([theme, data]) => ({
    theme,
    ctr: ((data.clicks / data.impressions) * 100).toFixed(2),
    total_impressions: data.impressions,
    ad_count: data.count,
  })).sort((a, b) => parseFloat(b.ctr) - parseFloat(a.ctr));
  return {
    total_ads_analyzed: results.length,
    date_range: 'Last 30 days',
    top_categories: categoryAnalysis.slice(0, 5),
    bottom_categories: categoryAnalysis.slice(-5),
    top_themes: themeAnalysis.slice(0, 5),
    bottom_themes: themeAnalysis.slice(-5),
    analysis_prompt: `Analyze this Google Ads performance data and provide actionable insights:\n\nTop Performing Categories:\n${JSON.stringify(categoryAnalysis.slice(0, 5), null, 2)}\n\nBottom Performing Categories:\n${JSON.stringify(categoryAnalysis.slice(-5), null, 2)}\n\nTop Performing Themes:\n${JSON.stringify(themeAnalysis.slice(0, 5), null, 2)}\n\nBottom Performing Themes:\n${JSON.stringify(themeAnalysis.slice(-5), null, 2)}\n\nProvide 3-5 specific recommendations for improving ad copy. Include estimated impact percentages. Format as: {'recommendations': [{'action': '...', 'expected_impact': '...', 'priority': 'HIGH/MEDIUM/LOW'}]}`,
  };
}

// "Generate Report", kept as the author wrote it (last line names Druve instead of n8n).
function report(aiOutput, performanceData) {
  let recommendations;
  try {
    const jsonMatch = aiOutput.match(/```json\s*([\s\S]*?)```/) || aiOutput.match(/{[\s\S]*}/);
    recommendations = JSON.parse(jsonMatch ? jsonMatch[1] || jsonMatch[0] : aiOutput);
  } catch (e) {
    recommendations = { recommendations: [{ action: aiOutput, priority: 'HIGH' }] };
  }
  const md = `# 30-Day Performance Analysis Report

## Executive Summary
Analyzed: ${performanceData.total_ads_analyzed} ads
Period: ${performanceData.date_range}
Date: ${new Date().toISOString().split('T')[0]}

## Top Performing Categories
${performanceData.top_categories.map((c) => `- ${c.category}: ${c.ctr}% CTR (${c.ad_count} ads)`).join('\n')}

## Top Performing Themes
${performanceData.top_themes.map((t) => `- "${t.theme}" messaging: ${t.ctr}% CTR (${t.ad_count} ads)`).join('\n')}

## AI-Powered Recommendations
${(recommendations.recommendations || []).map((r, i) => `${i + 1}. [${r.priority}] ${r.action}\n   Expected Impact: ${r.expected_impact || 'TBD'}`).join('\n\n')}

## Next Steps
1. Update ad copy to emphasize top-performing themes
2. A/B test recommendations
3. Review again in 30 days

---
Generated by Nikan Noorafkan's Google Ads Performance Analyst on Druve
`;
  return {
    report_markdown: md,
    recommendations: recommendations.recommendations || [],
    top_themes: performanceData.top_themes,
    generated_at: new Date().toISOString(),
  };
}

export async function handleMessage(input, providerConfig) {
  const raw = String(input || '').trim();
  let p = null;
  try { p = JSON.parse(raw); } catch { p = raw.includes(',') ? { csv: raw } : null; }
  if (!p || typeof p !== 'object') {
    return JSON.stringify({ error: 'Send {"results": [...]}, {"rows": [...]}, {"csv": "..."} or {"google_ads": {...}}. See the header of this file.' });
  }

  let results;
  try {
    if (Array.isArray(p.results)) results = p.results;
    else if (Array.isArray(p.rows)) results = rowsToResults(p.rows);
    else if (p.csv) results = rowsToResults(parseCsv(p.csv));
    else if (p.google_ads) results = await fetchResults(p.google_ads);
    else return JSON.stringify({ error: 'No ad data found in the input.' });
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
  if (!results.length) return JSON.stringify({ error: 'No ads with data were found.' });

  const themes = Array.isArray(p.themes) && p.themes.length ? p.themes.map((t) => String(t).toLowerCase()) : THEMES;
  const data = prepare(results, themes);
  const model = getModelClient(providerConfig);
  const out = await model.complete(`${SYSTEM}\n\n${data.analysis_prompt}`);
  const rep = report(String(out), data);

  if (p.slack_webhook_url && /^https:\/\/hooks\.slack\.com\//.test(p.slack_webhook_url)) {
    try {
      const s = await fetch(p.slack_webhook_url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: rep.report_markdown }),
      });
      rep.slack = s.ok ? 'sent' : `HTTP ${s.status}`;
    } catch (e) { rep.slack = `error: ${e.message}`; }
  }
  return JSON.stringify(rep);
}
