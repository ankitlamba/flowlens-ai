/**
 * FlowLens AI - Report Renderer
 * Manifest V3 CSP: string concatenation only, no template literals.
 */

document.addEventListener('DOMContentLoaded', function() {
    loadReport();
});

function esc(str) {
    if (str === null || str === undefined) return '';
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(String(str)));
    return d.innerHTML;
}

function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '0s';
    seconds = Math.round(seconds);
    if (seconds < 60) return seconds + 's';
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return s > 0 ? m + 'm ' + s + 's' : m + 'm';
}

function loadReport() {
    var params = new URLSearchParams(window.location.search);
    var reportId = params.get('id');

    if (!reportId) {
        document.getElementById('site-title').textContent = 'No report ID provided';
        return;
    }

    chrome.storage.local.get('flowlens_reports', function(result) {
        var reports = result.flowlens_reports || [];
        var report = null;
        for (var i = 0; i < reports.length; i++) {
            if (reports[i].id === reportId) {
                report = reports[i];
                break;
            }
        }

        if (!report) {
            document.getElementById('site-title').textContent = 'Report not found';
            return;
        }

        render(report);
    });
}

function render(report) {
    var sd = report.sessionData || {};
    var rpt = report.report || {};
    var session = sd.session || {};

    // Header
    document.getElementById('site-title').textContent = session.hostname || 'Unknown Site';

    var metaHtml = '';
    if (report.timestamp) {
        metaHtml += '<span>' + new Date(report.timestamp).toLocaleString() + '</span>';
    }
    if (session.duration) {
        metaHtml += '<span>Duration: ' + formatDuration(Math.round(session.duration / 1000)) + '</span>';
    }
    if (sd.metrics) {
        metaHtml += '<span>' + (sd.metrics.uniquePages || sd.metrics.totalPages || 0) + ' unique pages</span>';
        if (sd.metrics.totalPages && sd.metrics.totalPages > (sd.metrics.uniquePages || 0)) {
            metaHtml += '<span>' + sd.metrics.totalPages + ' navigations</span>';
        }
        metaHtml += '<span>' + (sd.metrics.totalClicks || 0) + ' clicks</span>';
    }
    document.getElementById('header-meta').innerHTML = metaHtml;

    // Scores
    if (rpt.scores) renderScores(rpt.scores);

    // Summary (now supports array of bullets or plain string)
    renderSummary(rpt.summary);

    // Navigation Flow
    renderNavFlow(sd.pages || [], rpt.journeyTable || []);

    // Page Cards
    renderPageCards(sd.pages || [], rpt.journeyTable || []);

    // Journey Table
    renderJourneyTable(rpt.journeyTable || []);

    // Friction Table
    renderFrictionTable(rpt.frictionTable || []);

    // Metrics
    renderMetrics(rpt.metricsTable || []);

    // Suggestions
    renderSuggestions(rpt.suggestions);

    // Methodology
    renderMethodology(rpt.methodology);

    // Export buttons
    setupButtons(report);
}

/* ── Scores ── */

function renderScores(scores) {
    renderScore('overall', scores.overall);
    renderScore('navigation', scores.navigation);
    renderScore('clarity', scores.clarity);
    renderScore('speedfeel', scores.speedFeel);
    renderScore('accessibility', scores.accessibility);
}

function renderScore(type, scoreObj) {
    var valueEl = document.getElementById('score-' + type + '-value');
    var cardEl = document.getElementById('score-card-' + type);
    var tipEl = document.getElementById('tip-' + type);

    if (!valueEl) return;

    var raw = 0;
    var formula = '';
    var penaltyTexts = [];

    if (typeof scoreObj === 'number') {
        raw = scoreObj;
    } else if (scoreObj && typeof scoreObj.final === 'number') {
        raw = scoreObj.final;
        formula = scoreObj.formula || '';
        if (scoreObj.penalties && scoreObj.penalties.length > 0) {
            for (var i = 0; i < scoreObj.penalties.length; i++) {
                var p = scoreObj.penalties[i];
                if (typeof p === 'string') {
                    penaltyTexts.push(p);
                } else if (p.reason) {
                    penaltyTexts.push(p.reason + ' (-' + p.amount + ')');
                }
            }
        }
    }

    var display = Math.round(raw / 10);
    valueEl.textContent = display;

    if (cardEl) {
        if (display >= 8) cardEl.className = 'score-card score-green';
        else if (display >= 5) cardEl.className = 'score-card score-yellow';
        else cardEl.className = 'score-card score-red';
    }

    if (tipEl) {
        var tip = '';
        if (formula) tip += 'Formula: ' + formula;
        if (penaltyTexts.length > 0) {
            if (tip) tip += ' | ';
            tip += 'Penalties: ' + penaltyTexts.join('; ');
        }
        if (!tip) tip = 'Score: ' + raw + '/100';
        tipEl.setAttribute('data-tooltip', tip);
    }
}

/* ── Executive Summary ── */

function renderSummary(summary) {
    var container = document.getElementById('summary-content');

    if (!summary) {
        container.textContent = 'No summary available.';
        return;
    }

    // Handle array of bullets (BCG style)
    if (Array.isArray(summary)) {
        var html = '<ul class="summary-bullets">';
        for (var i = 0; i < summary.length; i++) {
            html += '<li>' + esc(summary[i]) + '</li>';
        }
        html += '</ul>';
        container.innerHTML = html;
    } else {
        // Plain string fallback
        container.textContent = summary;
    }
}

/* ── Navigation Flow ── */

function renderNavFlow(pages, journeyTable) {
    var container = document.getElementById('nav-flow');
    if (!pages || pages.length === 0) {
        container.innerHTML = '<p class="empty">No navigation data.</p>';
        return;
    }

    var html = '';
    var source = journeyTable.length > 0 ? journeyTable : pages;

    for (var i = 0; i < source.length; i++) {
        var item = source[i];
        var pathname = item.pathname || '/';
        var isStep = (item.changeType === 'STEP_CHANGE');
        var cls = isStep ? 'nav-node nav-step' : 'nav-node';

        if (i > 0) {
            // Show different arrow for step vs page transitions
            var arrowLabel = isStep ? 'nav-arrow nav-arrow-step' : 'nav-arrow';
            html += '<span class="' + arrowLabel + '">' + (isStep ? '\u21BB' : '\u2192') + '</span>';
        }
        html += '<span class="' + cls + '">';
        var displayPath = pathname.length > 40 ? pathname.substring(0, 37) + '...' : pathname;
        html += '<span class="nav-node-path">' + esc(displayPath) + '</span>';
        if (isStep && item.queryState && item.queryState !== '' && item.queryState !== '-') {
            var navQuery = item.queryState.length > 40 ? item.queryState.substring(0, 37) + '...' : item.queryState;
            html += '<span class="nav-node-query">?' + esc(navQuery) + '</span>';
        }
        html += '</span>';
    }

    container.innerHTML = html;
}

/* ── Page Cards ── */

function renderPageCards(pages, journeyTable) {
    var container = document.getElementById('page-cards');
    var source = journeyTable.length > 0 ? journeyTable : null;

    if ((!source && pages.length === 0) || (source && source.length === 0)) {
        container.innerHTML = '<p class="empty">No page data available.</p>';
        return;
    }

    var items = source || pages;
    var html = '';

    // Group steps under their parent pages for clearer display
    var i = 0;
    while (i < items.length) {
        var item = items[i];
        var changeType = item.changeType || 'START';
        var isPageOrStart = (changeType === 'PAGE_CHANGE' || changeType === 'START');

        // Collect consecutive steps that follow this page
        var steps = [];
        if (isPageOrStart) {
            var j = i + 1;
            while (j < items.length && items[j].changeType === 'STEP_CHANGE') {
                steps.push(items[j]);
                j++;
            }
        }

        // Render the page card
        html += renderOnePageCard(item, i, items, changeType, steps);

        // Skip past grouped steps
        if (steps.length > 0) {
            i += 1 + steps.length;
        } else {
            i++;
        }
    }

    container.innerHTML = html;
}

function renderOnePageCard(item, index, items, changeType, steps) {
    var pathname = item.pathname || '/';
    var badgeClass = 'badge-page';
    var badgeText = 'PAGE';
    if (changeType === 'STEP_CHANGE') { badgeClass = 'badge-step'; badgeText = 'STEP'; }
    else if (changeType === 'START') { badgeClass = 'badge-start'; badgeText = 'ENTRY'; }

    // Use referrer from journey data, or calculate from previous
    var referrer = item.referrer || 'Direct';
    if (referrer === 'Direct' && index > 0) {
        referrer = items[index - 1].pathname || '/';
    }

    var timeSpent = item.timeSpent || 0;
    var totalClicks = item.clickCount || 0;

    // If there are steps, compute total time and clicks across parent + all steps
    var totalTime = timeSpent;
    if (steps && steps.length > 0) {
        for (var st = 0; st < steps.length; st++) {
            totalTime += (steps[st].timeSpent || 0);
            totalClicks += (steps[st].clickCount || 0);
        }
    }

    var keyAction = item.keyAction || item.keySignals || 'Browsed';

    var html = '';
    html += '<div class="page-card' + (steps && steps.length > 0 ? ' page-card-with-steps' : '') + '">';
    html += '<div class="page-card-header">';
    html += '<span class="page-card-title">' + esc(pathname) + '</span>';
    html += '<span class="page-card-badge ' + badgeClass + '">' + badgeText + '</span>';
    html += '</div>';

    html += '<div class="page-card-meta">';
    html += '<div class="meta-item"><span class="meta-label">Referrer</span><span class="meta-value">' + esc(referrer) + '</span></div>';

    // Show total time if steps exist, with initial state time noted
    if (steps && steps.length > 0) {
        html += '<div class="meta-item"><span class="meta-label">Total Time</span><span class="meta-value">' + formatDuration(totalTime) + '</span></div>';
    } else {
        html += '<div class="meta-item"><span class="meta-label">Time on Page</span><span class="meta-value">' + formatDuration(timeSpent) + '</span></div>';
    }

    html += '<div class="meta-item"><span class="meta-label">Total Clicks</span><span class="meta-value">' + totalClicks + '</span></div>';
    html += '</div>';

    if (keyAction && keyAction !== 'Browsed' && keyAction !== 'No friction') {
        html += '<div class="page-card-actions">Key action: ' + esc(keyAction) + '</div>';
    }

    // Render nested steps if any
    if (steps && steps.length > 0) {
        html += '<div class="page-card-steps">';
        html += '<div class="steps-header">' + (steps.length + 1) + ' state(s) within this view</div>';
        // First: the initial state (the parent page itself)
        html += '<div class="step-row">';
        html += '<span class="step-query">Initial' + (item.queryState ? ' ?' + esc(item.queryState) : '') + '</span>';
        html += '<span class="step-detail">' + formatDuration(item.timeSpent || 0) + '</span>';
        html += '<span class="step-detail">' + (item.clickCount || 0) + ' clicks</span>';
        html += '</div>';
        // Then: each step change
        for (var s = 0; s < steps.length; s++) {
            var step = steps[s];
            html += '<div class="step-row">';
            html += '<span class="step-query">?' + esc(step.queryState || '') + '</span>';
            html += '<span class="step-detail">' + formatDuration(step.timeSpent || 0) + '</span>';
            html += '<span class="step-detail">' + (step.clickCount || 0) + ' clicks</span>';
            if (step.keyAction && step.keyAction !== 'Browsed') {
                html += '<span class="step-detail step-action">' + esc(step.keyAction) + '</span>';
            }
            html += '</div>';
        }
        html += '</div>';
    }

    html += '</div>';
    return html;
}

/* ── Journey Table ── */

function renderJourneyTable(journeyTable) {
    var tbody = document.getElementById('journey-body');

    if (!journeyTable || journeyTable.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">No journey data.</td></tr>';
        return;
    }

    var html = '';
    var currentParentPathname = null;

    for (var i = 0; i < journeyTable.length; i++) {
        var row = journeyTable[i];
        var isStep = (row.changeType === 'STEP_CHANGE');
        var isStart = (row.changeType === 'START');

        // Track parent page for step grouping
        if (!isStep) {
            currentParentPathname = row.pathname;
        }

        var rowClass = isStep ? ' class="journey-row-step"' : '';

        html += '<tr' + rowClass + '>';

        // Step number column — with visual grouping
        if (isStep) {
            html += '<td class="step-num-cell"><span class="step-indent-num">' + (i + 1) + '</span></td>';
        } else {
            html += '<td class="step-num-cell"><span class="page-num">' + (i + 1) + '</span></td>';
        }

        // Page column — show pathname for pages, query change for steps
        if (isStep) {
            html += '<td class="journey-page journey-step-page">';
            if (row.queryState && row.queryState !== '' && row.queryState !== '\u2014') {
                var displayQuery = row.queryState.length > 50 ? row.queryState.substring(0, 47) + '...' : row.queryState;
                html += '<span class="step-change-label">?' + esc(displayQuery) + '</span>';
            } else {
                html += '<span class="step-change-label">State change</span>';
            }
            html += '</td>';
        } else {
            html += '<td class="journey-page">' + esc(row.pathname) + '</td>';
        }

        // State column
        html += '<td class="journey-state">' + esc(row.queryState || '\u2014') + '</td>';

        // Time
        html += '<td>' + formatDuration(row.timeSpent) + '</td>';

        // Key Action
        html += '<td class="journey-action">' + esc(row.keyAction || row.keySignals || 'Browsed') + '</td>';

        html += '</tr>';
    }

    tbody.innerHTML = html;
}

/* ── Friction Table ── */

function renderFrictionTable(frictionTable) {
    var tbody = document.getElementById('friction-body');

    if (!frictionTable || frictionTable.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty">No friction signals detected.</td></tr>';
        return;
    }

    var html = '';
    for (var i = 0; i < frictionTable.length; i++) {
        var row = frictionTable[i];
        var sev = row.severity || 'medium';
        var sevClass = 'severity-' + sev.replace('-', '');

        // Ensure evidence is a string
        var evidence = row.evidence;
        if (typeof evidence === 'object' && evidence !== null) {
            var parts = [];
            if (evidence.elementDescription) parts.push(evidence.elementDescription);
            if (evidence.clickCount) parts.push(evidence.clickCount + ' clicks');
            if (evidence.hoverDuration) parts.push(Math.round(evidence.hoverDuration / 1000) + 's hover');
            if (evidence.idleDuration) parts.push(Math.round(evidence.idleDuration / 1000) + 's idle');
            if (evidence.fromUrl) parts.push('from ' + evidence.fromUrl);
            if (evidence.toUrl) parts.push('to ' + evidence.toUrl);
            // NEVER show evidence.selector
            evidence = parts.length > 0 ? parts.join(', ') : 'Detected by rule';
        }

        html += '<tr>';
        html += '<td><strong>' + esc(row.issue) + '</strong></td>';
        html += '<td class="journey-page">' + esc(row.page) + '</td>';
        html += '<td style="font-size:12px;color:var(--text-secondary)">' + esc(evidence) + '</td>';
        html += '<td><span class="severity-dot ' + sevClass + '"></span><span class="severity-text">' + esc(sev) + '</span></td>';
        html += '</tr>';
    }

    tbody.innerHTML = html;
}

/* ── Metrics ── */

function renderMetrics(metricsTable) {
    var container = document.getElementById('metrics-content');

    if (!metricsTable || metricsTable.length === 0) {
        container.innerHTML = '<p class="empty">No metrics available.</p>';
        return;
    }

    var groups = {
        'Engagement': ['Total Pages', 'Total Steps', 'Total Clicks', 'Avg Time per Page'],
        'Friction Signals': ['Rage Clicks', 'Dead Clicks', 'Back Navigations', 'Hover Hesitations'],
        'Content Reach': ['Avg Scroll Depth', 'Avg TTFA']
    };

    var excluded = ['Stripped Tracking Params', 'Idle Clusters'];

    var html = '';
    var groupNames = Object.keys(groups);

    for (var g = 0; g < groupNames.length; g++) {
        var groupName = groupNames[g];
        var metricNames = groups[groupName];
        var groupItems = [];

        for (var m = 0; m < metricNames.length; m++) {
            for (var t = 0; t < metricsTable.length; t++) {
                if (metricsTable[t].metric === metricNames[m]) {
                    var val = metricsTable[t].value;
                    if (val === 0 || val === '0' || val === '0s' || val === '0%') continue;
                    var skip = false;
                    for (var e = 0; e < excluded.length; e++) {
                        if (metricsTable[t].metric === excluded[e]) { skip = true; break; }
                    }
                    if (!skip) groupItems.push(metricsTable[t]);
                }
            }
        }

        if (groupItems.length === 0) continue;

        html += '<div class="metrics-group">';
        html += '<div class="metrics-group-title">' + esc(groupName) + '</div>';
        html += '<div class="metrics-grid">';

        for (var j = 0; j < groupItems.length; j++) {
            html += '<div class="metric-item">';
            html += '<span class="metric-name">' + esc(groupItems[j].metric) + '</span>';
            html += '<span class="metric-val">' + esc(groupItems[j].value) + '</span>';
            html += '</div>';
        }

        html += '</div></div>';
    }

    if (html === '') {
        html = '<p class="empty">No significant metrics recorded.</p>';
    }

    container.innerHTML = html;
}

/* ── Suggestions ── */

function renderSuggestions(suggestions) {
    var section = document.getElementById('suggestions-section');
    var container = document.getElementById('suggestions-content');

    if (!suggestions || suggestions.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';
    var html = '<ul style="padding-left:18px;font-size:13px;line-height:1.7">';
    for (var i = 0; i < suggestions.length; i++) {
        var s = suggestions[i];
        if (typeof s === 'string') {
            html += '<li>' + esc(s) + '</li>';
        } else if (s.title) {
            html += '<li><strong>' + esc(s.title) + '</strong>: ' + esc(s.description || '') + '</li>';
        }
    }
    html += '</ul>';
    container.innerHTML = html;
}

/* ── Methodology ── */

function renderMethodology(methodology) {
    var container = document.getElementById('methodology-content');

    if (!methodology) {
        container.innerHTML = '<p class="empty">Methodology not available.</p>';
        return;
    }

    var html = '';

    if (methodology.urlNormalization) {
        html += '<div class="method-section">';
        html += '<div class="method-section-title">URL Normalization</div>';
        html += '<p>' + esc(methodology.urlNormalization) + '</p>';
        html += '</div>';
    }

    if (methodology.pageVsStep) {
        html += '<div class="method-section">';
        html += '<div class="method-section-title">Page vs Step Detection</div>';
        html += '<p>' + esc(methodology.pageVsStep) + '</p>';
        html += '</div>';
    }

    if (methodology.frictionRules) {
        html += '<div class="method-section">';
        html += '<div class="method-section-title">Friction Detection Rules</div>';
        html += '<p>' + esc(methodology.frictionRules) + '</p>';
        html += '</div>';
    }

    if (methodology.scoringFormulas) {
        html += '<div class="method-section">';
        html += '<div class="method-section-title">Scoring Formulas</div>';

        if (typeof methodology.scoringFormulas === 'object') {
            var keys = Object.keys(methodology.scoringFormulas);
            for (var k = 0; k < keys.length; k++) {
                html += '<code class="method-formula"><strong>' + esc(keys[k]) + ':</strong> ' + esc(methodology.scoringFormulas[keys[k]]) + '</code>';
            }
        } else {
            html += '<code class="method-formula">' + esc(methodology.scoringFormulas) + '</code>';
        }

        html += '</div>';
    }

    if (html === '') {
        html = '<p class="empty">Methodology not available.</p>';
    }

    container.innerHTML = html;
}

/* ── Buttons ── */

function setupButtons(report) {
    var jsonBtn = document.getElementById('exportJson');
    var linkBtn = document.getElementById('copyLink');

    if (jsonBtn) {
        jsonBtn.addEventListener('click', function() {
            var blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'flowlens-report-' + (report.id || 'unknown') + '.json';
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    if (linkBtn) {
        linkBtn.addEventListener('click', function() {
            var reportUrl = window.location.origin + window.location.pathname + '?id=' + (report.id || '');
            navigator.clipboard.writeText(reportUrl).then(function() {
                linkBtn.textContent = 'Copied!';
                setTimeout(function() { linkBtn.textContent = 'Copy Link'; }, 1500);
            });
        });
    }
}
