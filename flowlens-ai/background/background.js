// FlowLens AI - Background Service Worker (Manifest V3)

const API_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001'; // Using Haiku for speed + cost efficiency
const API_KEY_STORAGE_KEY = 'flowlens_api_key';
const REPORTS_STORAGE_KEY = 'flowlens_reports';
const RECORDING_STATE_KEY = 'flowlens_recording_state';

/**
 * Initialize badge on service worker startup
 */
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(RECORDING_STATE_KEY, (result) => {
    if (result[RECORDING_STATE_KEY]) {
      updateBadgeForRecording(true);
    }
  });
});

/**
 * Listen for messages from popup and content scripts
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender).then(sendResponse).catch((error) => {
    sendResponse({
      success: false,
      error: error.message || 'An unknown error occurred',
    });
  });
  return true; // Keep channel open for async response
});

/**
 * Main message handler
 */
async function handleMessage(request, sender) {
  switch (request.action) {
    case 'START_RECORDING':
      return handleStartRecording();

    case 'STOP_RECORDING':
      return handleStopRecording();

    case 'GENERATE_REPORT':
      return handleGenerateReport();

    case 'GET_REPORTS':
      return handleGetReports();

    case 'SET_API_KEY':
      return handleSetApiKey(request.apiKey);

    case 'CHECK_API_KEY':
      return handleCheckApiKey();

    case 'EXPORT_REPORT':
      return handleExportReport(request.reportId);

    case 'GET_RECORDING_STATE':
      return handleGetRecordingState();

    default:
      throw new Error(`Unknown action: ${request.action}`);
  }
}

/**
 * Handle START_RECORDING action
 */
async function handleStartRecording() {
  await chrome.storage.local.set({
    [RECORDING_STATE_KEY]: true,
  });
  updateBadgeForRecording(true);
  return { success: true, message: 'Recording started' };
}

/**
 * Handle STOP_RECORDING action
 */
async function handleStopRecording() {
  await chrome.storage.local.set({
    [RECORDING_STATE_KEY]: false,
  });
  updateBadgeForRecording(false);
  return { success: true, message: 'Recording stopped' };
}

/**
 * Handle GET_RECORDING_STATE action
 */
async function handleGetRecordingState() {
  const result = await chrome.storage.local.get(RECORDING_STATE_KEY);
  return {
    success: true,
    isRecording: result[RECORDING_STATE_KEY] || false,
  };
}

/**
 * Handle CHECK_API_KEY action
 */
async function handleCheckApiKey() {
  const result = await chrome.storage.local.get(API_KEY_STORAGE_KEY);
  return {
    success: true,
    hasKey: !!result[API_KEY_STORAGE_KEY],
  };
}

/**
 * Update badge based on recording state
 */
function updateBadgeForRecording(isRecording) {
  if (isRecording) {
    chrome.action.setBadgeText({ text: 'REC' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF0000' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

/**
 * Handle GENERATE_REPORT action
 * Reads tracking data from storage, tries AI analysis, falls back to offline analysis
 */
async function handleGenerateReport() {
  try {
    // 1. Read tracking data from storage
    const storage = await chrome.storage.local.get([
      'flowlens_clicks',
      'flowlens_pages_visited',
      'flowlens_rage_clicks',
      'flowlens_dead_clicks',
      'flowlens_navigations',
      'flowlens_last_session_data',
      'flowlens_start_time',
      'flowlens_session_id',
      'flowlens_url_metrics'
    ]);

    const clicks = safeParseJSON(storage.flowlens_clicks, []);
    const pages = safeParseJSON(storage.flowlens_pages_visited, []);
    const rageClicks = safeParseJSON(storage.flowlens_rage_clicks, []);
    const deadClicks = safeParseJSON(storage.flowlens_dead_clicks, []);
    const navigations = safeParseJSON(storage.flowlens_navigations, []);
    const lastSessionData = safeParseJSON(storage.flowlens_last_session_data, null);
    const urlMetrics = safeParseJSON(storage.flowlens_url_metrics, {});

    // Ensure startTime is numeric
    const startTime = storage.flowlens_start_time
      ? parseInt(storage.flowlens_start_time, 10)
      : (lastSessionData?.startTime || Date.now());

    // Calculate average scroll depth from URL metrics or lastSessionData
    let avgScrollDepthAcrossPages = lastSessionData?.avgScrollDepthAcrossPages || 0;
    if (!avgScrollDepthAcrossPages && urlMetrics && Object.keys(urlMetrics).length > 0) {
      const depths = Object.values(urlMetrics).map(m => m.maxScrollDepth || 0);
      avgScrollDepthAcrossPages = depths.length > 0
        ? Math.round(depths.reduce((a, b) => a + b, 0) / depths.length)
        : 0;
    }

    const trackingData = {
      sessionId: storage.flowlens_session_id || 'unknown',
      startTime: startTime,
      endTime: Date.now(),
      totalClicks: clicks.length,
      totalPages: pages.length,
      totalRageClicks: rageClicks.length,
      totalDeadClicks: deadClicks.length,
      totalNavigations: navigations.length,
      totalScrollEvents: lastSessionData?.totalScrollEvents || lastSessionData?.scrollEvents || 0,
      avgScrollDepthAcrossPages: avgScrollDepthAcrossPages,
      clicks: clicks.slice(0, 50),
      pages: pages,
      rageClicks: rageClicks,
      deadClicks: deadClicks,
      navigations: navigations,
      urlMetrics: urlMetrics,
      hostname: lastSessionData?.hostname || getHostnameFromPages(pages),
      url: lastSessionData?.url || pages[0]?.url || 'unknown'
    };

    if (clicks.length === 0 && pages.length === 0) {
      throw new Error('No tracking data found. Please record a session first.');
    }

    // 2. Try AI-powered analysis, fall back to offline
    let report;
    let reportMode = 'ai';

    const keyResult = await chrome.storage.local.get(API_KEY_STORAGE_KEY);
    const apiKey = keyResult[API_KEY_STORAGE_KEY];

    if (apiKey) {
      try {
        const prompt = buildAnalysisPrompt(trackingData);
        const response = await callClaudeAPI(apiKey, prompt);
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          report = JSON.parse(jsonMatch[0]);
        } else {
          report = generateOfflineReport(trackingData);
          reportMode = 'offline';
        }
      } catch (aiError) {
        console.log('AI analysis failed, using offline mode:', aiError.message);
        report = generateOfflineReport(trackingData);
        reportMode = 'offline';
      }
    } else {
      report = generateOfflineReport(trackingData);
      reportMode = 'offline';
    }

    // 3. Save report
    const reportId = generateReportId();
    const reportData = {
      id: reportId,
      timestamp: new Date().toISOString(),
      hostname: trackingData.hostname,
      url: trackingData.url,
      trackingData: trackingData,
      report: report,
      mode: reportMode,
    };

    const reportsResult = await chrome.storage.local.get(REPORTS_STORAGE_KEY);
    const reports = reportsResult[REPORTS_STORAGE_KEY] || [];
    reports.push(reportData);
    await chrome.storage.local.set({ [REPORTS_STORAGE_KEY]: reports });

    // 4. Open report page
    const reportUrl = chrome.runtime.getURL('report/report.html') + '?id=' + reportId;
    chrome.tabs.create({ url: reportUrl });

    return { success: true, reportId, message: `Report generated (${reportMode} mode)` };
  } catch (error) {
    throw error;
  }
}

/**
 * Generate a report offline using pure data analysis (no AI API needed)
 */
function generateOfflineReport(data) {
  const hostname = data.hostname || 'the website';
  const duration = data.startTime ? Math.round((data.endTime - parseInt(data.startTime)) / 1000) : 0;
  const avgTimePerPage = data.pages.length > 0
    ? Math.round(data.pages.reduce((sum, p) => sum + (p.timeSpent || 0), 0) / data.pages.length / 1000)
    : 0;

  // Calculate scores based on real data
  const rageClickRatio = data.totalClicks > 0 ? data.totalRageClicks / data.totalClicks : 0;
  const deadClickRatio = data.totalClicks > 0 ? data.totalDeadClicks / data.totalClicks : 0;
  const avgScrollDepth = data.pages.length > 0
    ? Math.round(data.pages.reduce((sum, p) => sum + (p.scrollDepth || 0), 0) / data.pages.length)
    : 0;

  const navigationScore = Math.max(2, Math.round(10 - (rageClickRatio * 30) - (data.totalNavigations < 2 ? 2 : 0)));
  const clarityScore = Math.max(2, Math.round(10 - (deadClickRatio * 25)));
  const speedScore = Math.max(2, Math.round(avgTimePerPage < 10 ? 8 : avgTimePerPage < 30 ? 6 : 4));
  const accessibilityScore = Math.max(2, Math.round(avgScrollDepth > 50 ? 7 : 5));
  const overallScore = Math.round((navigationScore + clarityScore + speedScore + accessibilityScore) / 4);

  // Build pain points from real data
  const painPoints = [];

  if (data.totalRageClicks > 0) {
    const topRage = data.rageClicks[0];
    painPoints.push({
      title: `Rage clicks detected (${data.totalRageClicks} instances)`,
      description: `Users rapidly clicked on elements ${data.totalRageClicks} time(s), indicating frustration with unresponsive or confusing UI elements.`,
      severity: data.totalRageClicks >= 3 ? 'high' : 'medium',
      evidence: topRage ? `Element "${topRage.text || topRage.selector}" (${topRage.role}) received ${topRage.clickCount} rapid clicks on ${shortenUrl(topRage.url)}` : 'Multiple rage click events detected'
    });
  }

  if (data.totalDeadClicks > 0) {
    const topDead = data.deadClicks[0];
    painPoints.push({
      title: `Dead clicks found (${data.totalDeadClicks} instances)`,
      description: `${data.totalDeadClicks} click(s) on elements that produced no visible response. This suggests misleading UI elements that look clickable but aren't.`,
      severity: data.totalDeadClicks >= 5 ? 'high' : 'medium',
      evidence: topDead ? `Element "${topDead.text || topDead.selector}" (${topDead.role}) on ${shortenUrl(topDead.url)} did not respond to click` : 'Multiple non-responsive elements found'
    });
  }

  if (avgTimePerPage > 30) {
    painPoints.push({
      title: 'High average dwell time per page',
      description: `Users spent an average of ${avgTimePerPage}s per page, which may indicate difficulty finding information or confusing layout.`,
      severity: 'medium',
      evidence: `Average time per page: ${avgTimePerPage}s across ${data.totalPages} pages`
    });
  }

  if (data.totalPages <= 1) {
    painPoints.push({
      title: 'Single page session',
      description: 'The user only visited one page, which could indicate poor discoverability of other content or features.',
      severity: 'low',
      evidence: `Only ${data.totalPages} page(s) visited in ${duration}s session`
    });
  }

  // Analyze URL-level metrics for additional pain points
  if (data.urlMetrics && typeof data.urlMetrics === 'object') {
    Object.entries(data.urlMetrics).forEach(([urlPath, metrics]) => {
      // Check for repeated visits (navigation confusion)
      if (metrics.visitCount >= 3) {
        painPoints.push({
          title: `Users repeatedly returned to ${shortenUrl(urlPath)}`,
          description: `The page "${metrics.title || shortenUrl(urlPath)}" was visited ${metrics.visitCount} times, suggesting users may be confused about navigation or content location.`,
          severity: 'medium',
          evidence: `Page visited ${metrics.visitCount} times with total engagement time: ${metrics.totalTimeSpent ? Math.round(metrics.totalTimeSpent / 1000) : 0}s`
        });
      }

      // Check for low scroll depth
      if (metrics.maxScrollDepth !== undefined && metrics.maxScrollDepth < 20 && metrics.visitCount > 0) {
        painPoints.push({
          title: `Low scroll engagement on ${shortenUrl(urlPath)}`,
          description: `Users rarely scrolled past the fold on "${metrics.title || shortenUrl(urlPath)}" (${metrics.maxScrollDepth}% max depth), indicating the content may not be compelling or discoverable.`,
          severity: 'medium',
          evidence: `Max scroll depth: ${metrics.maxScrollDepth}%, ${metrics.visitCount} visit(s)`
        });
      }

      // Check for dead end pages (no interactions)
      if (metrics.clickCount === 0 && metrics.visitCount > 0) {
        painPoints.push({
          title: `Dead end page: ${shortenUrl(urlPath)}`,
          description: `"${metrics.title || shortenUrl(urlPath)}" received no clicks during ${metrics.visitCount} visit(s), suggesting it may be a content dead end with no clear next action.`,
          severity: 'low',
          evidence: `${metrics.visitCount} visit(s) with 0 interactions`
        });
      }

      // Check for high dead click rates on specific URLs
      if (metrics.deadClickCount > 0) {
        painPoints.push({
          title: `High dead click rate on ${shortenUrl(urlPath)}`,
          description: `${metrics.deadClickCount} non-responsive click(s) detected on "${metrics.title || shortenUrl(urlPath)}", indicating misleading UI elements.`,
          severity: 'medium',
          evidence: `${metrics.deadClickCount} dead click(s) out of ${metrics.clickCount} total clicks`
        });
      }
    });
  }

  if (painPoints.length === 0) {
    painPoints.push({
      title: 'No major issues detected',
      description: 'The user journey was relatively smooth with no rage clicks or excessive dead clicks.',
      severity: 'low',
      evidence: `${data.totalClicks} clicks across ${data.totalPages} pages with ${data.totalRageClicks} rage clicks`
    });
  }

  // Build suggestions
  const suggestions = [];

  if (data.totalDeadClicks > 0) {
    // Find URLs with high dead click counts for specific recommendations
    let deadClickUrls = [];
    if (data.urlMetrics && typeof data.urlMetrics === 'object') {
      deadClickUrls = Object.entries(data.urlMetrics)
        .filter(([_, m]) => m.deadClickCount > 0)
        .map(([url, m]) => `${shortenUrl(url)} (${m.deadClickCount} dead clicks)`);
    }
    const urlReference = deadClickUrls.length > 0 ? ` especially on ${deadClickUrls.slice(0, 2).join(', ')}` : '';
    suggestions.push({
      title: 'Fix non-responsive clickable elements',
      description: `Review the ${data.totalDeadClicks} dead click elements${urlReference} and either make them interactive or change their visual style to not appear clickable.`,
      impact: 'high',
      effort: 'low'
    });
  }

  if (data.totalRageClicks > 0) {
    suggestions.push({
      title: 'Improve click feedback on interactive elements',
      description: 'Add visual feedback (loading states, hover effects, click animations) to elements where rage clicks occurred.',
      impact: 'high',
      effort: 'low'
    });
  }

  // URL-based suggestions
  if (data.urlMetrics && typeof data.urlMetrics === 'object') {
    const repeatedVisitUrls = Object.entries(data.urlMetrics)
      .filter(([_, m]) => m.visitCount >= 3)
      .map(([url, _]) => shortenUrl(url));

    if (repeatedVisitUrls.length > 0) {
      suggestions.push({
        title: 'Improve navigation to reduce repeated page visits',
        description: `Users revisited ${repeatedVisitUrls.slice(0, 2).join(' and ')} multiple times. Review site navigation, add clearer links, or improve search to help users find content faster.`,
        impact: 'medium',
        effort: 'medium'
      });
    }
  }

  suggestions.push({
    title: 'Add breadcrumb navigation',
    description: `With ${data.totalPages} pages in the journey, clear breadcrumb navigation would help users understand where they are in the flow.`,
    impact: 'medium',
    effort: 'medium'
  });

  suggestions.push({
    title: 'Reduce page load friction',
    description: 'Consider lazy loading, skeleton screens, and optimistic UI updates to make the experience feel faster.',
    impact: 'medium',
    effort: 'medium'
  });

  // Build mermaid diagram
  const mermaidDiagram = generateFallbackMermaid(data);

  // Build summary
  const summary = `Analysis of ${hostname}: User visited ${data.totalPages} page(s) over ${duration} seconds, making ${data.totalClicks} clicks. ${data.totalRageClicks > 0 ? `Detected ${data.totalRageClicks} rage click(s) indicating frustration. ` : ''}${data.totalDeadClicks > 0 ? `Found ${data.totalDeadClicks} dead click(s) on non-responsive elements. ` : ''}Overall UX score: ${overallScore}/10.`;

  return {
    summary,
    mermaidDiagram,
    painPoints,
    suggestions,
    scores: {
      navigation: navigationScore,
      clarity: clarityScore,
      speedFeel: speedScore,
      accessibility: accessibilityScore,
      overall: overallScore
    }
  };
}

/**
 * Build analysis prompt from tracking data
 */
function buildAnalysisPrompt(data) {
  // Build page journey summary
  const pagesSummary = data.pages.map((p, i) => {
    const timeSpent = p.timeSpent ? `${Math.round(p.timeSpent / 1000)}s` : 'unknown';
    return `  ${i + 1}. ${p.title || p.url} (${timeSpent}, ${p.clickCount || 0} clicks, scroll: ${p.scrollDepth || 0}%)`;
  }).join('\n');

  // Build rage click summary
  const rageSummary = data.rageClicks.map(r =>
    `  - "${r.text || r.selector}" (${r.role}) on ${r.url} — ${r.clickCount} rapid clicks`
  ).join('\n') || '  None detected';

  // Build dead click summary
  const deadSummary = data.deadClicks.map(d =>
    `  - "${d.text || d.selector}" (${d.role}) on ${d.url}`
  ).join('\n') || '  None detected';

  // Build navigation flow
  const navFlow = data.navigations.map(n => {
    const from = shortenUrl(n.from);
    const to = shortenUrl(n.to);
    return `  ${from} → ${to}`;
  }).join('\n') || '  Single page session';

  return `You are FlowLens AI, a senior product manager analyzing real user journey data captured from a website browsing session.

WEBSITE ANALYZED: ${data.hostname || 'Unknown'}
SESSION DURATION: ${data.startTime ? Math.round((data.endTime - parseInt(data.startTime)) / 1000) : 'unknown'} seconds

SUMMARY STATS:
- Total clicks: ${data.totalClicks}
- Pages visited: ${data.totalPages}
- Rage clicks (frustration signals): ${data.totalRageClicks}
- Dead clicks (clicks on non-responsive elements): ${data.totalDeadClicks}
- Page navigations: ${data.totalNavigations}

PAGES VISITED (in order):
${pagesSummary || '  No page data captured'}

NAVIGATION FLOW:
${navFlow}

RAGE CLICKS (user frustration — 3+ rapid clicks on same element):
${rageSummary}

DEAD CLICKS (clicks that triggered no response):
${deadSummary}

TOP CLICKED ELEMENTS:
${getTopClickedElements(data.clicks)}

Please generate a detailed product teardown analysis. Return ONLY valid JSON (no markdown wrapping) in this exact format:
{
  "summary": "2-3 sentence executive summary of the user experience on this website",
  "mermaidDiagram": "flowchart TD\\n  A[Page 1] --> B[Page 2]\\n  B --> C[Page 3]",
  "painPoints": [
    {
      "title": "Short pain point title",
      "description": "Detailed description of the issue",
      "severity": "high",
      "evidence": "Data-backed evidence from the tracking data"
    }
  ],
  "suggestions": [
    {
      "title": "Short suggestion title",
      "description": "Specific, actionable UX improvement",
      "impact": "high",
      "effort": "low"
    }
  ],
  "scores": {
    "navigation": 7,
    "clarity": 6,
    "speedFeel": 8,
    "accessibility": 5,
    "overall": 7
  }
}

IMPORTANT:
- Base scores on actual data (rage clicks = lower navigation score, dead clicks = lower clarity score)
- The mermaid diagram should show the actual page flow with proper Mermaid flowchart TD syntax
- Include at least 2-3 pain points and 2-3 suggestions
- If no rage/dead clicks were found, note that positively but still suggest improvements based on the flow`;
}

/**
 * Get top clicked elements summary
 */
function getTopClickedElements(clicks) {
  const elementCounts = {};
  clicks.forEach(c => {
    const key = `${c.role}: "${c.text || c.selector}"`;
    elementCounts[key] = (elementCounts[key] || 0) + 1;
  });

  return Object.entries(elementCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([el, count]) => `  - ${el} (${count} clicks)`)
    .join('\n') || '  No click data';
}

/**
 * Shorten URL for display
 */
function shortenUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? u.hostname : u.pathname;
  } catch {
    return url;
  }
}

/**
 * Generate fallback mermaid diagram from navigation data
 */
function generateFallbackMermaid(data) {
  if (data.pages.length === 0) return 'flowchart TD\n  A[No pages recorded]';

  // Try to use navigations with urlPath data if available
  let nodePath = [];
  if (data.navigations && data.navigations.length > 0) {
    // Use navigation flow with urlPath if available
    nodePath.push(data.navigations[0].from || data.pages[0]?.url);
    data.navigations.forEach(nav => {
      if (!nodePath.includes(nav.to)) {
        nodePath.push(nav.to);
      }
    });
  } else {
    // Fall back to pages array
    nodePath = data.pages.map(p => p.url);
  }

  const nodes = nodePath.map((url, i) => {
    const pageData = data.pages.find(p => p.url === url);
    const label = pageData?.title || shortenUrl(url) || `Page ${i + 1}`;
    return { id: String.fromCharCode(65 + i), label: label.substring(0, 30), url };
  });

  let diagram = 'flowchart TD\n';
  nodes.forEach((node, i) => {
    diagram += `  ${node.id}["${node.label}"]\n`;
    if (i > 0) {
      diagram += `  ${nodes[i - 1].id} --> ${node.id}\n`;
    }
  });
  return diagram;
}

/**
 * Call Claude API
 */
async function callClaudeAPI(apiKey, userPrompt) {
  const response = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    let errorMessage = `API request failed with status ${response.status}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.error?.message || errorMessage;

      // Provide helpful messages for common errors
      if (response.status === 401) {
        errorMessage = 'Invalid API key. Please check your key in Settings (⚙️).';
      } else if (response.status === 403) {
        errorMessage = 'API access denied. Your API key may not have permission for this model.';
      } else if (response.status === 429) {
        errorMessage = 'Rate limit reached. Please wait a minute and try again.';
      } else if (errorMessage.includes('credit') || errorMessage.includes('billing')) {
        errorMessage = 'Insufficient credits. Please add credits at console.anthropic.com/settings/billing';
      }
    } catch (e) {
      // Could not parse error response
    }
    throw new Error(errorMessage);
  }

  const data = await response.json();

  if (!data.content || !data.content[0]) {
    throw new Error('Invalid response from Claude API');
  }

  return data.content[0].text;
}

/**
 * Handle GET_REPORTS action
 */
async function handleGetReports() {
  const storage = await chrome.storage.local.get(REPORTS_STORAGE_KEY);
  return { success: true, reports: storage[REPORTS_STORAGE_KEY] || [] };
}

/**
 * Handle SET_API_KEY action
 */
async function handleSetApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('Invalid API key provided');
  }
  await chrome.storage.local.set({ [API_KEY_STORAGE_KEY]: apiKey.trim() });
  return { success: true, message: 'API key saved successfully' };
}

/**
 * Handle EXPORT_REPORT action
 */
async function handleExportReport(reportId) {
  if (!reportId) throw new Error('Report ID is required');

  const storage = await chrome.storage.local.get(REPORTS_STORAGE_KEY);
  const reports = storage[REPORTS_STORAGE_KEY] || [];
  const report = reports.find((r) => r.id === reportId);

  if (!report) throw new Error(`Report with ID ${reportId} not found`);

  const jsonString = JSON.stringify(report, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const timestamp = new Date(report.timestamp).toISOString().split('T')[0];
  const filename = `flowlens-report-${reportId.substring(0, 8)}-${timestamp}.json`;

  await chrome.downloads.download({ url, filename, saveAs: true });
  return { success: true, message: 'Report exported', filename };
}

// ── Utilities ──

function generateReportId() {
  return `report_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function safeParseJSON(str, fallback) {
  if (!str) return fallback;
  if (typeof str === 'object') return str; // Already parsed
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function getHostnameFromPages(pages) {
  if (pages.length === 0) return 'unknown';
  try {
    return new URL(pages[0].url).hostname;
  } catch {
    return 'unknown';
  }
}
