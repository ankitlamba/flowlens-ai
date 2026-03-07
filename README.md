# FlowLens AI

A Chrome extension (Manifest V3) that automatically tracks user journeys on any website and generates UX teardown reports — powered by Claude AI when you choose, or running offline with deterministic scoring.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome) ![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue) ![Claude AI](https://img.shields.io/badge/Claude-Haiku%204.5-blueviolet) ![Privacy First](https://img.shields.io/badge/Privacy-First-green) ![MIT License](https://img.shields.io/badge/License-MIT-green)

---

## What It Does

FlowLens AI records your browser session and generates a professional UX analysis report. It detects friction signals in real-time and scores the product across four key dimensions.

**Friction signals detected:**
- Rage clicks (3+ rapid clicks on same element within 1 second)
- Dead clicks (clicks with no DOM change or navigation within 500ms)
- Hover hesitation (hovering interactive elements for 2+ seconds without clicking)
- High Time to First Action (no interaction within 5+ seconds)
- Idle clusters (15+ seconds of inactivity)
- Back navigation (returning to previously visited URLs)

**Then you choose:**
- **AI Mode (Optional)** — Send session data to Claude Haiku API for natural-language insights, improvement suggestions, and executive summary. Requires API key.
- **Offline Mode (Default)** — Pure deterministic scoring with transparent formulas. Works immediately, no API needed.

---

## Key Features

1. **One-click recording** — Start from the popup, browse naturally, stop when done
2. **SPA-compatible** — Works seamlessly with LinkedIn, Stripe, and other single-page applications via History API patching (pushState/replaceState), popstate, and URL polling
3. **Smart URL normalization** — Strips tracking parameters (utm_*, fbclid, gclid) while preserving state-bearing query params
4. **PAGE vs STEP detection** — Pathname changes trigger PAGE_CHANGE events; query-only changes trigger STEP_CHANGE (useful for filtered product listings or multi-step flows)
5. **Cross-page data continuity** — Click data and friction signals persist across SPA navigations automatically
6. **Click-triggered sync** — Data syncs 150ms after every click plus on pagehide and visibilitychange, ensuring no data loss during navigation
7. **4 UX dimension scores** (0-100 each with transparent penalty formulas):
   - **Navigation Score** — penalties for back navigation and rage clicks
   - **Clarity Score** — penalties for dead clicks, hover hesitation, and high TTFA
   - **Speed Feel Score** — based on average time per page and idle clusters
   - **Accessibility Score** — based on scroll depth and TTFA per page
   - **Overall Score** (weighted: nav×0.3 + clarity×0.3 + speed×0.2 + access×0.2)
8. **Past Reports** — Browse your full history of generated reports from the popup
9. **Report export** — Export reports as JSON or copy a shareable link
10. **Hostname-scoped recording** — Only the active tab's hostname is tracked; other tabs remain isolated

---

## Report Contents

FlowLens generates a professional, BCG consulting-style teardown with:

- **Score Cards** — Navigation, Clarity, Speed Feel, Accessibility, and Overall Score. Hover over any score to see the penalty breakdown formula.
- **Executive Summary** — AI-generated insights (AI mode only) or a structured summary of key findings
- **Navigation Flow Diagram** — Visual map of all PAGE and STEP transitions
- **Page Cards** — Detailed per-page breakdown with time spent, click count, key actions, and nested STEP states
- **Journey Table** — Granular step-by-step table with timestamps, clicks, and mutations
- **Friction Table** — Every detected friction signal with issue type, page, evidence, and severity rating
- **Metrics Table** — Grouped engagement stats, friction counts, and content reach
- **Methodology** — Transparent explanation of URL normalization rules, PAGE vs STEP logic, friction detection thresholds, and scoring formulas
- **Suggestions** — AI-generated improvement recommendations (AI mode only)

All data is presented in an easy-to-scan format suitable for sharing with product and design teams.

---

## Installation

### From Source (Developer Mode)

1. Clone the repository:
   ```bash
   git clone https://github.com/ankitlamba/flowlens-ai.git
   ```

2. Open Chrome and navigate to `chrome://extensions/`

3. Enable **Developer mode** (toggle in the top right corner)

4. Click **Load unpacked** and select the `flowlens-ai` folder

5. Pin the FlowLens AI extension to your toolbar for easy access

### Configure API Key (Optional)

FlowLens works offline by default. To enable AI-powered reports:

1. Get an [Anthropic API key](https://console.anthropic.com/) (free tier available)
2. Click the FlowLens AI icon in your toolbar
3. Click the ⚙️ Settings button in the popup
4. Paste your API key and save
5. Your key is stored locally in chrome.storage and never sent anywhere except Anthropic's servers

**No API key?** No problem — reports generate in offline mode with full scoring and friction analysis.

---

## Usage

1. Navigate to any website
2. Click the FlowLens AI icon in your toolbar
3. Click **Start Recording** — the extension begins tracking all interactions
4. Browse naturally — click around, navigate between pages, complete tasks
5. Click **Stop Recording** when finished (or just proceed to step 6)
6. Click **Generate Report** — opens your UX teardown in a new tab

### Tips

- Record for 2-3+ minutes for meaningful friction signal detection
- Visit multiple pages to generate a rich navigation journey map
- Complete a real task (e.g., checkout flow, signup, search) for best analysis
- Review the "Methodology" section in your report to understand the scoring

---

## Architecture

```
flowlens-ai/
├── manifest.json              # Manifest V3 configuration
├── popup/                     # Extension popup UI
│   ├── popup.html             # Recording controls, stats, settings
│   ├── popup.css              # Styled with accent gradients and animations
│   └── popup.js               # Recording toggle, live stats, report generation, settings
├── content/                   # Content script (bridge)
│   └── content.js             # Syncs FlowLensTracker ↔ chrome.storage.local
├── background/                # Service worker
│   └── background.js          # Report generation (AI + offline), scoring engine, Claude API calls
├── report/                    # Report viewer
│   ├── report.html            # BCG-style report layout
│   ├── report.css             # Professional report styling
│   └── report.js              # Renders scores, tables, journey flow, and methodology
├── utils/                     # Core tracking engine
│   └── tracker.js             # IIFE exposing window.FlowLensTracker API
└── icons/                     # Extension icons (16, 48, 128px)
```

### How It Works

**tracker.js** — Core engine (IIFE pattern)
- Exposes `window.FlowLensTracker` with methods: `start()`, `stop()`, `getData()`, `isActive()`, `reset()`, `importPreviousData()`
- Captures clicks on `window` in capture phase (not document) to avoid blocking by SPA listeners
- Detects friction signals independently from element enrichment (resilient to errors)
- Cross-page continuity via `importPreviousData()` for seamless SPA tracking

**content.js** — Bridge script
- Syncs FlowLensTracker data to chrome.storage.local every 1 second
- Click-triggered sync (debounced 150ms) ensures data survives navigation
- pagehide and visibilitychange handlers for last-chance saves
- Hostname-scoped to prevent tracking unrelated tabs

**background.js** — Service worker
- Generates reports in AI mode (Claude Haiku 4.5) or offline mode (deterministic)
- Transparent scoring with base 100 and itemized penalty breakdowns
- Graceful error handling for API failures (401, 403, 429, credit errors)
- Automatic fallback to offline mode if AI fails

**popup.js** — User interface
- Live stats dashboard (pages, clicks, friction signals, timer)
- Settings panel for API key management
- Past Reports history with timestamp and score summary
- Counters reset on report generation

---

## Tech Stack

- **Chrome Extension Manifest V3** — modern, secure extension architecture
- **Vanilla JavaScript** (ES5 in content scripts for compatibility, ES6+ elsewhere)
- **Claude Haiku 4.5 API** (Anthropic) — optional, for AI-powered analysis
- **chrome.storage.local** — all data persisted locally
- **Zero dependencies** — no frameworks, libraries, or external packages

---

## Privacy & Security

- **All data stays local** — tracking happens entirely in your browser
- **Data sent only on demand** — session data is only transmitted to Anthropic when you explicitly click "Generate Report" and have an API key configured
- **No analytics** — no telemetry, no usage tracking, no third-party integrations
- **API key stays local** — your Anthropic API key is stored in chrome.storage and never leaves your machine except when calling Anthropic's API
- **Open source** — audit the code yourself

---

## Design Decisions

- **Browser-level tracking only** — unlike ChatGPT which can't see real browser interactions, FlowLens has direct access to DOM mutations, navigation events, and user interactions
- **Offline-first** — the extension works without any API key; AI is an optional enhancement
- **Deterministic scoring** — even in offline mode, reports use transparent, reproducible formulas so you understand exactly how scores are calculated
- **SPA-aware** — History API patching ensures LinkedIn, Stripe, Gmail, and other single-page apps are tracked seamlessly
- **Friction as primary signal** — rage clicks, dead clicks, and hover hesitation are better indicators of UX problems than simple dwell time

---

## Roadmap

- [ ] Chrome Web Store listing
- [ ] PDF export for reports
- [ ] Heatmap overlay on pages
- [ ] Session comparison and A/B analysis
- [ ] Team sharing and collaborative reports
- [ ] Additional AI provider support (Claude 3+, GPT-4)

---

## Built By

**Ankit Lamba** — Product Manager building AI-powered tools.

[LinkedIn](https://linkedin.com/in/ankit5593)
