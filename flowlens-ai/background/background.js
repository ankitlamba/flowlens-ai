// FlowLens AI - Background Service Worker (Manifest V3)
// Processes real user session data via Claude Haiku API

const API_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const API_KEY_STORAGE_KEY = 'flowlens_api_key';
const REPORTS_STORAGE_KEY = 'flowlens_reports';
const SESSION_DATA_KEY = 'flowlens_session_data';
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
 * Reads session data via getData() from storage, tries AI analysis, falls back to offline
 */
async function handleGenerateReport() {
  try {
    // 1. Read session data from storage (via tracker's getData() output)
    // Handle both stringified and object formats
    const storage = await chrome.storage.local.get(SESSION_DATA_KEY);
    let sessionData = storage[SESSION_DATA_KEY];
    if (typeof sessionData === 'string') {
      try {
        sessionData = JSON.parse(sessionData);
      } catch (e) {
        sessionData = null;
      }
    }
    if (!sessionData || typeof sessionData !== 'object') {
      sessionData = null;
    }

    if (!sessionData || !sessionData.session) {
      throw new Error('No session data found. Please record a session first.');
    }

    // Validate required data
    if (!sessionData.pages || sessionData.pages.length === 0) {
      throw new Error('No pages recorded in session. Recording must capture at least one page.');
    }

    // 2. Try AI-powered analysis, fall back to offline
    let report;
    let reportMode = 'ai';
    let apiErrorMessage = null;

    const keyResult = await chrome.storage.local.get(API_KEY_STORAGE_KEY);
    const apiKey = keyResult[API_KEY_STORAGE_KEY];

    if (apiKey) {
      try {
        const prompt = buildAIAnalysisPrompt(sessionData);
        const response = await callClaudeAPI(apiKey, prompt);
        // Extract JSON object from response (non-greedy, handles text before/after)
        const jsonMatch = response.match(/\{(?:[^{}]|(?:\{[^{}]*\}))*\}/);
        if (jsonMatch) {
          try {
            report = JSON.parse(jsonMatch[0]);
          } catch (parseError) {
            console.log('JSON parse failed, trying to extract valid JSON:', parseError.message);
            // Fallback: try to find a valid JSON object by balance checking
            report = extractValidJSON(response);
            if (!report) {
              apiErrorMessage = 'AI response was malformed. Using offline analysis instead.';
              report = generateOfflineReport(sessionData);
              reportMode = 'offline';
            }
          }
        } else {
          apiErrorMessage = 'AI response did not contain valid JSON. Using offline analysis instead.';
          report = generateOfflineReport(sessionData);
          reportMode = 'offline';
        }
      } catch (aiError) {
        apiErrorMessage = 'AI analysis error: ' + (aiError.message || 'Unknown error') + '. Using offline analysis instead.';
        console.log('AI analysis failed, using offline mode:', aiError.message);
        report = generateOfflineReport(sessionData);
        reportMode = 'offline';
      }
    } else {
      report = generateOfflineReport(sessionData);
      reportMode = 'offline';
    }

    // 3. Save report
    const reportId = generateReportId();
    const reportData = {
      id: reportId,
      timestamp: new Date().toISOString(),
      hostname: sessionData.session.hostname,
      url: sessionData.session.url,
      sessionData: sessionData,
      report: report,
      mode: reportMode,
      apiError: apiErrorMessage,
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
 * sessionData: { session, rawEvents, pages, signals, navigations, metrics }
 */
function generateOfflineReport(sessionData) {
  const { session, pages = [], signals = [], navigations = [], metrics = {} } = sessionData;
  const hostname = session.hostname || 'the website';
  const duration = Math.round((session.endTime - session.startTime) / 1000);

  // Calculate metrics from pages array
  const avgTimePerPage = pages.length > 0
    ? Math.round(pages.reduce((sum, p) => sum + (p.timeSpent || 0), 0) / pages.length / 1000)
    : 0;

  const avgScrollDepth = pages.length > 0
    ? Math.round(pages.reduce((sum, p) => sum + (p.maxScrollDepth || 0), 0) / pages.length)
    : 0;

  const avgTTFA = pages.length > 0
    ? Math.round(pages.reduce((sum, p) => sum + (p.ttfa || 0), 0) / pages.length / 1000)
    : 0;

  const rageClickCount = metrics.rageClickCount || 0;
  const deadClickCount = metrics.deadClickCount || 0;
  const backNavigationCount = metrics.backNavigationCount || 0;
  const hoverHesitationCount = metrics.hoverHesitationCount || 0;
  const idleClusterCount = metrics.idleClusterCount || 0;
  const totalClicks = metrics.totalClicks || 0;
  const uniquePages = metrics.uniquePages || metrics.totalPages || pages.length;
  const totalPages = metrics.totalPages || pages.length;
  const totalSteps = metrics.totalSteps || navigations.length;

  // Calculate scores (0-100 base, then penalties) — return as objects
  const navigationScore = calculateNavigationScore(backNavigationCount, rageClickCount, totalPages);
  const clarityScore = calculateClarityScore(deadClickCount, hoverHesitationCount, avgTTFA);
  const speedFeelScore = calculateSpeedFeel(avgTimePerPage, idleClusterCount);
  const accessibilityScore = calculateAccessibility(pages);
  const overallFinal = Math.round(
    navigationScore.final * 0.3 + clarityScore.final * 0.3 + speedFeelScore.final * 0.2 + accessibilityScore.final * 0.2
  );
  const overallScore = {
    base: 100,
    penalties: [],
    final: overallFinal,
    formula: 'nav*0.3 + clarity*0.3 + speed*0.2 + access*0.2'
  };

  // Build friction table from signals array
  const frictionTable = buildFrictionTable(signals, pages);

  // Build journey table
  const journeyTable = buildJourneyTable(pages, navigations);

  // Build metrics table
  const metricsTable = buildMetricsTable(metrics, pages, avgTimePerPage, avgTTFA);

  // Build summary
  const summary = buildSummary(hostname, uniquePages, duration, totalClicks, rageClickCount, deadClickCount, overallScore, backNavigationCount, {
    navigation: navigationScore,
    clarity: clarityScore,
    speedFeel: speedFeelScore,
    accessibility: accessibilityScore
  });

  // Methodology
  const methodology = {
    urlNormalization: 'URLs are normalized by stripping tracking parameters (utm_*, fbclid, gclid) while preserving state-bearing query params. Two URLs that differ only in tracking params are treated as the same page.',
    pageVsStep: 'A PAGE transition occurs when the URL pathname changes (e.g., /jobs/ → /jobs/collections/recommended/). A STEP transition occurs when the pathname stays the same but the query parameters change (e.g., ?currentJobId=123 → ?currentJobId=456). Steps represent state changes within the same view — like browsing through a list of items. Pages represent moving to a different section of the site.',
    frictionRules: 'Rage Click: 3+ rapid clicks on the same element within 1 second. Dead Click: Click with no DOM mutation or navigation within 500ms. Hover Hesitation: Hovering over an interactive element for 2+ seconds without clicking. Idle Cluster: No user interaction for 15+ seconds. Back Navigation: User navigated back to a previously visited URL.',
    scoringFormulas: {
      navigation: 'base 100: -10 per back nav (max 30), -5 per rage click for first 3 then -2 each (max 30), -5 if single page',
      clarity: 'base 100: -12 per dead click (max 36), -8 per hover hesitation (max 24), -5 if avg TTFA > 8s',
      speedFeel: 'base 100: -3 per second over 15s avg time/page, -10 per idle cluster',
      accessibility: 'base 100: -5 per page with < 25% scroll depth, -3 per page with TTFA > 8s'
    }
  };

  return {
    summary,
    journeyTable,
    frictionTable,
    scores: {
      navigation: navigationScore,
      clarity: clarityScore,
      speedFeel: speedFeelScore,
      accessibility: accessibilityScore,
      overall: overallScore
    },
    metricsTable,
    methodology
  };
}

/**
 * Calculate navigation score (0-100)
 * Base: 100, penalties: -15 per back nav, -10 per rage click, -5 if only 1 page
 * Returns { base, penalties, final, formula }
 */
function calculateNavigationScore(backNavCount, rageClickCount, totalPages) {
  let score = 100;
  const penalties = [];
  if (backNavCount > 0) {
    // Cap at -30 max for back nav
    const penalty = Math.min(backNavCount * 10, 30);
    penalties.push({ reason: `${backNavCount} back navigation(s)`, amount: penalty });
    score -= penalty;
  }
  if (rageClickCount > 0) {
    // Diminishing: first 3 rage clicks are -5 each, after that -2 each, cap at -30
    const basePenalty = Math.min(rageClickCount, 3) * 5;
    const extraPenalty = Math.max(0, rageClickCount - 3) * 2;
    const penalty = Math.min(basePenalty + extraPenalty, 30);
    penalties.push({ reason: `${rageClickCount} rage click(s)`, amount: penalty });
    score -= penalty;
  }
  if (totalPages <= 1) {
    penalties.push({ reason: 'Single page session', amount: 5 });
    score -= 5;
  }
  return {
    base: 100,
    penalties,
    final: Math.max(0, score),
    formula: '100 - backnavs(10ea, max 30) - rage(5ea first 3, 2ea after, max 30) - 1page(5)'
  };
}

/**
 * Calculate clarity score (0-100)
 * Base: 100, penalties: -12 per dead click (max 36), -8 per hover hesitation (max 24), -5 if avg TTFA > 8s
 * Returns { base, penalties, final, formula }
 */
function calculateClarityScore(deadClickCount, hoverHesitationCount, avgTTFA) {
  let score = 100;
  const penalties = [];
  if (deadClickCount > 0) {
    const penalty = Math.min(deadClickCount * 12, 36);
    penalties.push({ reason: `${deadClickCount} dead click(s)`, amount: penalty });
    score -= penalty;
  }
  if (hoverHesitationCount > 0) {
    const penalty = Math.min(hoverHesitationCount * 8, 24);
    penalties.push({ reason: `${hoverHesitationCount} hover hesitation(s)`, amount: penalty });
    score -= penalty;
  }
  if (avgTTFA > 8) {
    penalties.push({ reason: 'High avg TTFA (>8s)', amount: 5 });
    score -= 5;
  }
  return {
    base: 100,
    penalties,
    final: Math.max(0, score),
    formula: '100 - (dead*12, max 36) - (hover*8, max 24) - (ttfa>8s*5)'
  };
}

/**
 * Calculate speed/feel score (0-100)
 * Base: 100, penalties: -3 per second over 15s avg, -10 per idle cluster
 * Returns { base, penalties, final, formula }
 */
function calculateSpeedFeel(avgTimePerPage, idleClusterCount) {
  let score = 100;
  const penalties = [];
  if (avgTimePerPage > 15) {
    const excessSeconds = avgTimePerPage - 15;
    const penalty = excessSeconds * 3;
    penalties.push({ reason: `Avg time ${avgTimePerPage}s (${excessSeconds}s over 15s)`, amount: penalty });
    score -= penalty;
  }
  if (idleClusterCount > 0) {
    const penalty = idleClusterCount * 10;
    penalties.push({ reason: `${idleClusterCount} idle cluster(s)`, amount: penalty });
    score -= penalty;
  }
  return {
    base: 100,
    penalties,
    final: Math.max(0, score),
    formula: '100 - (sec>15s*3) - (idle*10)'
  };
}

/**
 * Calculate accessibility score (0-100)
 * Base: 100, penalties: -5 per page < 25% scroll, -3 per page TTFA > 8s
 * Returns { base, penalties, final, formula }
 */
function calculateAccessibility(pages) {
  let score = 100;
  const penalties = [];
  const lowScrollPages = pages.filter(p => (p.maxScrollDepth || 0) < 25).length;
  const highTTFAPages = pages.filter(p => (p.ttfa || 0) > 8000).length;
  if (lowScrollPages > 0) {
    const penalty = lowScrollPages * 5;
    penalties.push({ reason: `${lowScrollPages} page(s) <25% scroll`, amount: penalty });
    score -= penalty;
  }
  if (highTTFAPages > 0) {
    const penalty = highTTFAPages * 3;
    penalties.push({ reason: `${highTTFAPages} page(s) TTFA >8s`, amount: penalty });
    score -= penalty;
  }
  return {
    base: 100,
    penalties,
    final: Math.max(0, score),
    formula: '100 - (scroll<25%*5) - (ttfa>8s*3)'
  };
}

/**
 * Truncate long query strings to keep UI readable
 */
function truncateQuery(query) {
  if (!query || query.length <= 60) return query;
  // Show first meaningful param and count of others
  var params = query.split('&');
  if (params.length <= 1) return query.substring(0, 57) + '...';
  var first = params[0];
  if (first.length > 40) first = first.substring(0, 37) + '...';
  return first + ' (+' + (params.length - 1) + ' more)';
}

/**
 * Build journey table from pages and navigations
 */
function buildJourneyTable(pages, navigations) {
  return pages.map((page, index) => {
    // Match navigation by normalized URL (pathname + queryState)
    const pageUrl = page.queryState ? page.pathname + '?' + page.queryState : page.pathname;
    const nav = navigations.find(n => n.to === pageUrl || n.to === page.pathname);

    // Determine change type
    let changeType;
    if (index === 0) {
      changeType = 'PAGE_CHANGE'; // First page is always a PAGE, not a step
    } else if (nav) {
      changeType = nav.changeType;
    } else {
      // Fallback: compare pathnames with previous page
      const prevPage = pages[index - 1];
      changeType = (prevPage && prevPage.pathname === page.pathname) ? 'STEP_CHANGE' : 'PAGE_CHANGE';
    }

    // Build key action from click actions (CTA names) and friction signals
    const keyActions = [];

    // Add friction signals first (most important)
    if (page.frictionSignals && page.frictionSignals.length > 0) {
      page.frictionSignals.forEach(sig => {
        if (sig.signalType === 'rage_click') keyActions.push('Rage click on ' + formatEvidence(sig.evidence));
        else if (sig.signalType === 'dead_click') keyActions.push('Dead click on ' + formatEvidence(sig.evidence));
        else if (sig.signalType === 'back_navigation') keyActions.push('Back navigation');
        else if (sig.signalType === 'hover_hesitation') keyActions.push('Hover hesitation on ' + formatEvidence(sig.evidence));
        else if (sig.signalType === 'idle_cluster') keyActions.push('Idle (' + (sig.evidence && sig.evidence.idleDuration ? Math.round(sig.evidence.idleDuration / 1000) + 's' : '15s+') + ')');
        else if (sig.signalType === 'high_ttfa') keyActions.push('Slow first action');
      });
    }

    // If no friction, show what user clicked (CTA names)
    if (keyActions.length === 0 && page.clickActions && page.clickActions.length > 0) {
      var meaningfulClicks = page.clickActions
        .filter(c => c.text || c.ariaLabel)
        .slice(0, 3); // Show up to 3 click actions

      if (meaningfulClicks.length > 0) {
        meaningfulClicks.forEach(c => {
          const label = c.text || c.ariaLabel || '';
          const truncated = label.length > 40 ? label.substring(0, 37) + '...' : label;
          const elType = c.elementType === 'link' ? 'Clicked link' :
                         c.elementType === 'button' ? 'Clicked button' :
                         'Clicked';
          keyActions.push(elType + ': "' + truncated + '"');
        });
      }
    }

    // Fallback: show click count if > 0
    if (keyActions.length === 0 && (page.clickCount || 0) > 0) {
      keyActions.push(page.clickCount + ' click(s)');
    }
    // Last resort: show "Browsed"
    if (keyActions.length === 0) keyActions.push('Browsed');

    // Determine referrer
    var referrer = 'Direct';
    if (nav && nav.from) {
      referrer = nav.from;
    } else if (index > 0) {
      referrer = pages[index - 1].pathname || '/';
    }

    return {
      stepNumber: index + 1,
      pathname: page.pathname,
      queryState: truncateQuery(page.queryState || ''),
      changeType: changeType,
      timeSpent: page.timeSpent ? Math.round(page.timeSpent / 1000) : 0,
      scrollDepth: page.maxScrollDepth || 0,
      hasScrolled: page.hasScrolled || false,
      ttfa: page.ttfa ? Math.round(page.ttfa / 1000) : null,
      clickCount: page.clickCount || 0,
      keyAction: keyActions[0],
      allActions: keyActions,
      referrer: referrer,
      queryDisplay: (changeType === 'STEP_CHANGE' && page.queryState) ? '?' + page.queryState : ''
    };
  });
}

/**
 * Build friction table from signals array
 */
function buildFrictionTable(signals, pages) {
  return signals.map(signal => {
    const page = pages.find(p => p.pageId === signal.pageRef);
    const severity = signal.severity || 'medium';

    let issue = signal.signalType;
    if (signal.signalType === 'rage_click') issue = 'Rage Click';
    if (signal.signalType === 'dead_click') issue = 'Dead Click';
    if (signal.signalType === 'hover_hesitation') issue = 'Hover Hesitation';
    if (signal.signalType === 'idle_cluster') issue = 'Idle Period';
    if (signal.signalType === 'back_navigation') issue = 'Back Navigation';
    if (signal.signalType === 'high_ttfa') issue = 'Slow First Action';

    // Convert evidence object to readable string
    const evidenceStr = formatEvidence(signal.evidence);

    return {
      issue,
      page: page ? page.pathname : 'Unknown',
      evidence: evidenceStr,
      severity
    };
  });
}

/**
 * Convert evidence object to a human-readable string
 * NEVER shows evidence.selector (internal technical detail)
 */
function formatEvidence(evidence) {
  if (!evidence) return 'Detected by rule';
  if (typeof evidence === 'string') return evidence;
  if (typeof evidence !== 'object') return String(evidence);

  var parts = [];
  // Human-readable element description (priority)
  if (evidence.elementDescription) parts.push(evidence.elementDescription);
  // Numeric context
  if (evidence.clickCount) parts.push(evidence.clickCount + ' clicks');
  if (evidence.hoverDuration) parts.push(Math.round(evidence.hoverDuration / 1000) + 's hover');
  if (evidence.idleDuration) parts.push(Math.round(evidence.idleDuration / 1000) + 's idle');
  if (evidence.ttfa) parts.push('TTFA: ' + Math.round(evidence.ttfa / 1000) + 's');
  if (evidence.fromUrl) parts.push('from ' + evidence.fromUrl);
  if (evidence.toUrl) parts.push('to ' + evidence.toUrl);
  // NEVER show evidence.selector — it's internal technical detail
  return parts.length > 0 ? parts.join(', ') : 'Detected by rule';
}

/**
 * Build metrics table
 */
function buildMetricsTable(metrics, pages, avgTimePerPage, avgTTFA) {
  return [
    { metric: 'Unique Pages', value: metrics.uniquePages || metrics.totalPages || pages.length, howMeasured: 'Distinct URL pathnames visited' },
    { metric: 'Total Navigations', value: metrics.totalPages || pages.length, howMeasured: 'All page/step transitions including revisits' },
    { metric: 'Total Steps', value: metrics.totalSteps || 0, howMeasured: 'Navigation transitions between pages' },
    { metric: 'Total Clicks', value: metrics.totalClicks || 0, howMeasured: 'All recorded click events' },
    { metric: 'Rage Clicks', value: metrics.rageClickCount || 0, howMeasured: '3+ rapid clicks on same element within 1s' },
    { metric: 'Dead Clicks', value: metrics.deadClickCount || 0, howMeasured: 'Clicks with no visible response' },
    { metric: 'Back Navigations', value: metrics.backNavigationCount || 0, howMeasured: 'User pressed back button' },
    { metric: 'Hover Hesitations', value: metrics.hoverHesitationCount || 0, howMeasured: 'Long hover without click' },
    { metric: 'Idle Clusters', value: metrics.idleClusterCount || 0, howMeasured: '30s+ inactivity periods' },
    { metric: 'Avg Time per Page', value: `${avgTimePerPage}s`, howMeasured: 'Mean session time / number of pages' },
    { metric: 'Avg TTFA', value: `${avgTTFA}s`, howMeasured: 'Mean time to first action across pages' },
    { metric: 'Stripped Tracking Params', value: metrics.totalStrippedParams || 0, howMeasured: 'UTM and utm-like query params removed' }
  ];
}

/**
 * Build summary text
 */
function buildSummary(hostname, totalPages, duration, totalClicks, rageClickCount, deadClickCount, overallScore, backNavCount, scores) {
  const finalScore = typeof overallScore === 'object' ? overallScore.final : overallScore;
  const displayScore = Math.round(finalScore / 10);

  // BCG-style bullet points as array
  const bullets = [];

  // Headline
  bullets.push(`Analyzed ${hostname} across ${totalPages} page(s) over ${duration}s with ${totalClicks} interactions. Overall UX score: ${displayScore}/10.`);

  // Navigation insight
  if (scores && scores.navigation) {
    const navDisplay = Math.round((typeof scores.navigation === 'object' ? scores.navigation.final : scores.navigation) / 10);
    if (navDisplay <= 5) {
      bullets.push(`Navigation friction is high (${navDisplay}/10)${backNavCount > 0 ? ' — ' + backNavCount + ' back navigation(s) suggest users are losing their way' : ''}.`);
    } else {
      bullets.push(`Navigation flow is ${navDisplay >= 8 ? 'smooth' : 'adequate'} (${navDisplay}/10) with ${totalPages} pages visited sequentially.`);
    }
  }

  // Friction signals
  if (rageClickCount > 0 || deadClickCount > 0) {
    let frictionNote = 'Friction detected: ';
    const parts = [];
    if (rageClickCount > 0) parts.push(`${rageClickCount} rage click(s) indicating unresponsive or confusing elements`);
    if (deadClickCount > 0) parts.push(`${deadClickCount} dead click(s) on non-interactive elements`);
    frictionNote += parts.join('; ') + '.';
    bullets.push(frictionNote);
  }

  // (Scroll depth removed — not reliable on SPAs)

  return bullets;
}

/**
 * Build AI analysis prompt from session data
 * Instructs Claude to ONLY reference recorded data, cite exact numbers, say "Insufficient evidence" if unsupported
 */
function buildAIAnalysisPrompt(sessionData) {
  const { session, pages = [], signals = [], navigations = [], metrics = {} } = sessionData;
  const duration = Math.round((session.endTime - session.startTime) / 1000);

  // Build page journey summary
  const pagesSummary = pages.map((p, i) => {
    const timeSpent = p.timeSpent ? `${Math.round(p.timeSpent / 1000)}s` : 'unknown';
    const scrollDepth = p.maxScrollDepth || 0;
    const ttfa = p.ttfa ? `${Math.round(p.ttfa / 1000)}s` : 'unknown';
    return `  ${i + 1}. ${p.pathname} (${timeSpent}, ${p.clickCount || 0} clicks, scroll: ${scrollDepth}%, TTFA: ${ttfa})`;
  }).join('\n');

  // Build signal summary (from signals array)
  const rageSummary = signals
    .filter(s => s.signalType === 'rage_click')
    .map(s => `  - ${s.evidence || 'Rage click detected'}`)
    .join('\n') || '  None detected';

  const deadSummary = signals
    .filter(s => s.signalType === 'dead_click')
    .map(s => `  - ${s.evidence || 'Dead click detected'}`)
    .join('\n') || '  None detected';

  const hoverHesitationSummary = signals
    .filter(s => s.signalType === 'hover_hesitation')
    .map(s => `  - ${s.evidence || 'Hover hesitation detected'}`)
    .join('\n') || '  None detected';

  const idleClusterSummary = signals
    .filter(s => s.signalType === 'idle_cluster')
    .map(s => `  - ${s.evidence || 'Idle cluster detected'}`)
    .join('\n') || '  None detected';

  // Build navigation flow
  const navFlow = navigations.map((n, i) => {
    const changeType = n.changeType || 'TRANSITION';
    return `  ${i + 1}. ${n.fromNormalized || n.from} → ${n.toNormalized || n.to} (${changeType})`;
  }).join('\n') || '  Single page session';

  return `You are FlowLens AI, analyzing REAL user session data. CRITICAL RULES:
- ONLY reference data present in this report
- Cite EXACT numbers from the metrics below
- If data doesn't support a claim, respond "Insufficient evidence"
- Output JSON only, no markdown

WEBSITE: ${session.hostname}
SESSION DURATION: ${duration} seconds
RECORDING WINDOW: ${new Date(session.startTime).toISOString()} to ${new Date(session.endTime).toISOString()}

EXACT METRICS:
- Total Pages: ${metrics.totalPages || pages.length}
- Total Clicks: ${metrics.totalClicks || 0}
- Rage Clicks: ${metrics.rageClickCount || 0}
- Dead Clicks: ${metrics.deadClickCount || 0}
- Back Navigations: ${metrics.backNavigationCount || 0}
- Hover Hesitations: ${metrics.hoverHesitationCount || 0}
- Idle Clusters: ${metrics.idleClusterCount || 0}
- Avg Time/Page: ${pages.length > 0 ? Math.round(pages.reduce((sum, p) => sum + (p.timeSpent || 0), 0) / pages.length / 1000) : 0}s
- Avg TTFA: ${pages.length > 0 ? Math.round(pages.reduce((sum, p) => sum + (p.ttfa || 0), 0) / pages.length / 1000) : 0}s
- Avg Scroll Depth: ${pages.length > 0 ? Math.round(pages.reduce((sum, p) => sum + (p.maxScrollDepth || 0), 0) / pages.length) : 0}%

PAGES VISITED (in order):
${pagesSummary}

NAVIGATION FLOW:
${navFlow}

FRICTION SIGNALS:
Rage Clicks (3+ rapid clicks on same element):
${rageSummary}

Dead Clicks (non-responsive elements):
${deadSummary}

Hover Hesitations (long hover without click):
${hoverHesitationSummary}

Idle Clusters (30s+ inactivity):
${idleClusterSummary}

Return ONLY this JSON structure (no markdown):
{
  "summary": ["sentence 1 of summary", "sentence 2 of summary", "sentence 3 of summary"],
  "journeyTable": [
    {"stepNumber": 1, "pathname": "/path", "queryState": "state", "changeType": "PAGE_CHANGE|STEP_CHANGE", "timeSpent": 10, "keyAction": "friction signals or 'No friction'"},
    ...
  ],
  "frictionTable": [
    {"issue": "Issue type", "page": "/pathname", "evidence": "exact data from metrics", "detectionRule": "rule name", "severity": "high|medium|low"},
    ...
  ],
  "suggestions": [
    "actionable recommendation 1 based on data",
    "actionable recommendation 2 based on data",
    "actionable recommendation 3 based on data"
  ],
  "scores": {
    "navigation": {"base": 100, "penalties": ["penalty description"], "final": X, "formula": "100 - (backnavs*15) - (rage*10) - (1page*5)"},
    "clarity": {"base": 100, "penalties": ["penalty"], "final": X, "formula": "100 - (dead*12) - (hover*8) - (ttfa>8s*5)"},
    "speedFeel": {"base": 100, "penalties": ["penalty"], "final": X, "formula": "100 - (sec>15s*3) - (idle*10)"},
    "accessibility": {"base": 100, "penalties": ["penalty"], "final": X, "formula": "100 - (scroll<25%*5) - (ttfa>8s*3)"},
    "overall": {"base": 100, "penalties": [], "final": X, "formula": "nav*0.3 + clarity*0.3 + speed*0.2 + access*0.2"}
  },
  "metricsTable": [
    {"metric": "name", "value": "value", "howMeasured": "method"},
    ...
  ],
  "methodology": {
    "urlNormalization": "pathname + queryState",
    "pageVsStep": "pages are URLs; steps are transitions",
    "frictionRules": "based on recorded signals",
    "scoringFormulas": {"navigation": "...", "clarity": "...", ...}
  }
}`;
}

/**
 * Utilities
 */

/**
 * Extract valid JSON object from text by matching braces with balance
 * Handles cases where Claude adds text before/after the JSON
 */
function extractValidJSON(text) {
  const startIdx = text.indexOf('{');
  if (startIdx === -1) return null;

  let braceCount = 0;
  let endIdx = -1;

  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === '{') braceCount++;
    else if (text[i] === '}') {
      braceCount--;
      if (braceCount === 0) {
        endIdx = i;
        break;
      }
    }
  }

  if (endIdx === -1) return null;

  try {
    return JSON.parse(text.substring(startIdx, endIdx + 1));
  } catch (e) {
    return null;
  }
}

/**
 * Call Claude API with session data
 * Model: claude-haiku-4-5-20251001, max_tokens: 3000
 * Handles 401, 403, 429, and credit errors with helpful messages
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
      max_tokens: 3000,
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
        errorMessage = 'API access denied. Your API key may not have permission for Claude Haiku.';
      } else if (response.status === 429) {
        errorMessage = 'Rate limit reached. Please wait a minute and try again.';
      } else if (errorMessage.includes('credit') || errorMessage.includes('billing')) {
        errorMessage = 'Insufficient credits. Please add credits at console.anthropic.com/settings/billing.';
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

/**
 * Generate unique report ID
 */
function generateReportId() {
  return `report_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Safe JSON parse with fallback
 */
function safeParseJSON(str, fallback) {
  if (!str) return fallback;
  if (typeof str === 'object') return str; // Already parsed
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}
