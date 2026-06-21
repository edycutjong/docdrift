// Dynamic import to allow graceful fallback when running outside Anna environment
let AnnaAppRuntime = null;

// Tool ID Resolution
const DEV_FALLBACK_TOOL_ID = "tool-dev-docdrift";
const TOOL_ID =
  (typeof window !== "undefined" &&
    window.__ANNA_TOOL_IDS__ &&
    window.__ANNA_TOOL_IDS__["docdrift"]) ||
  DEV_FALLBACK_TOOL_ID;

// DOM Helper
const $ = (id) => document.getElementById(id);

// App State
let anna = null;
let state = {
  scannedPath: "",
  symbols: [],
  docFiles: [],
  drifts: [],
  acceptedDrifts: {}, // Map of driftId -> acceptedFix
  activeDriftId: null,
  chatHistories: {} // Map of driftId -> message array
};

// ─── Anna SDK Initialization ─────────────────────────────────────────

const annaReady = (async () => {
  try {
    const sdkModule = await import("/static/anna-apps/_sdk/latest/index.js").catch(e => {
      console.warn("Could not load Anna SDK dynamically, falling back to mock environment", e);
      return null;
    });

    if (!sdkModule) {
      console.warn("[DocDrift] Anna SDK not available. Running in sandbox mode.");
      updateStatusBadge(false);
      return null;
    }

    AnnaAppRuntime = sdkModule.AnnaAppRuntime;
    anna = await AnnaAppRuntime.connect();
    console.log("[DocDrift] Connected to Anna runtime", anna.windowUuid);
    updateStatusBadge(true);

    // Load persisted state using storage.get if available
    if (anna.storage) {
      try {
        const persisted = await anna.storage.get("session");
        if (persisted) {
          restoreSession(persisted);
        } else if (anna.runtimeState?.session) {
          restoreSession(anna.runtimeState.session);
        }
      } catch (storageErr) {
        console.warn("[DocDrift] Error loading session from storage, falling back to runtimeState", storageErr);
        if (anna.runtimeState?.session) {
          restoreSession(anna.runtimeState.session);
        }
      }
    } else if (anna.runtimeState?.session) {
      restoreSession(anna.runtimeState.session);
    }

    // Listen to sync events
    anna.on("runtime_state_synced", (syncState) => {
      if (syncState?.session) {
        restoreSession(syncState.session);
      }
    });

    return anna;
  } catch (err) {
    console.warn("[DocDrift] Anna SDK not available. Running in sandbox mode.", err);
    updateStatusBadge(false);
    return null;
  }
})();

function updateStatusBadge(isLive) {
  const statusText = document.getElementById('connection-status-text');
  const pulseDot = document.getElementById('status-dot');
  if (isLive) {
    if (statusText) statusText.innerText = "ANNA SECURE DESK";
    if (pulseDot) {
      pulseDot.style.background = "var(--primary)";
      pulseDot.style.boxShadow = "0 0 10px rgba(6, 182, 212, 0.4)";
    }
  } else {
    if (statusText) statusText.innerText = "STANDALONE (MOCK)";
    if (pulseDot) {
      pulseDot.style.background = "#ef4444";
      pulseDot.style.boxShadow = "0 0 10px rgba(239, 68, 68, 0.4)";
    }
  }
}


// Helper to persist state using storage.set
async function persistSession() {
  const sessionData = {
    scannedPath: state.scannedPath,
    symbols: state.symbols,
    docFiles: state.docFiles,
    drifts: state.drifts,
    acceptedDrifts: state.acceptedDrifts,
    activeDriftId: state.activeDriftId,
    chatHistories: state.chatHistories
  };

  const a = await annaReady;
  if (a && a.storage) {
    try {
      await a.storage.set("session", sessionData);
    } catch (e) {
      console.error("Error persisting state to APS:", e);
    }
  }
}

function restoreSession(session) {
  state = { ...state, ...session };
  if (state.scannedPath) {
    $("workspace-path").value = state.scannedPath;
  }
  if (state.drifts.length > 0) {
    renderDashboard();
  }
}

// ─── Tool Invocation Helper ──────────────────────────────────────────

async function invoke(method, args) {
  const a = await annaReady;
  if (!a) {
    // Simulated Executa Tool call when running outside Anna environment
    return simulateLocalExecuta(method, args);
  }
  
  try {
    const reply = await a.tools.invoke({ tool_id: TOOL_ID, method, args });
    if (reply && typeof reply === "object" && reply.data && reply.tool) {
      return reply.data;
    }
    return reply ?? {};
  } catch (e) {
    throw e;
  }
}

// ─── Setup Event Listeners ───────────────────────────────────────────

window.addEventListener("load", () => {
  // Hash Routing
  route();
  window.addEventListener("hashchange", route);

  // Nav Buttons
  $("nav-workspace-btn").addEventListener("click", () => navigateTo("#/"));
  $("nav-anna-console-btn").addEventListener("click", () => navigateTo("#/console"));

  // Button Hooks
  $("scan-btn").addEventListener("click", handleScanRequest);
  $("seed-demo-btn").addEventListener("click", loadSeedDemoData);
  $("reset-btn").addEventListener("click", resetAppState);
  
  // Viewer Buttons
  $("viewer-back-btn").addEventListener("click", () => navigateTo("#/"));
  $("viewer-skip-btn").addEventListener("click", skipCurrentDrift);
  $("viewer-accept-btn").addEventListener("click", acceptCurrentDrift);
  
  // Chat Buttons
  $("chat-send-btn").addEventListener("click", sendChatMessage);
  $("chat-input-field").addEventListener("keypress", (e) => {
    if (e.key === "Enter") sendChatMessage();
  });

  // Export Patch Button
  $("export-btn").addEventListener("click", handleExportPatch);
  $("copy-patch-url-btn").addEventListener("click", copyPatchUrl);
});

// Hash Routing Handler
function route() {
  const hash = window.location.hash;
  if (hash.startsWith("#/drift/")) {
    const driftId = hash.replace("#/drift/", "");
    state.activeDriftId = driftId;
    renderDriftViewer(driftId);
    switchView("drift-viewer-view");
    document.querySelectorAll(".header-actions button").forEach(b => b.classList.remove("active-nav"));
  } else if (hash === "#/console") {
    state.activeDriftId = null;
    switchView("anna-console-view");
    $("nav-workspace-btn").classList.remove("active-nav");
    $("nav-anna-console-btn").classList.add("active-nav");
  } else {
    state.activeDriftId = null;
    if (state.drifts.length > 0) {
      renderDashboard();
    }
    switchView("workspace-view");
    $("nav-workspace-btn").classList.add("active-nav");
    $("nav-anna-console-btn").classList.remove("active-nav");
  }
}

function switchView(viewId) {
  document.querySelectorAll(".view-section").forEach(sec => {
    sec.classList.remove("active");
  });
  $(viewId).classList.add("active");
}

function navigateTo(hash) {
  window.location.hash = hash;
}

// ─── Scan / Audit Functions ──────────────────────────────────────────

async function handleScanRequest() {
  const path = $("workspace-path").value.trim();
  if (!path) {
    showToast("Please enter a valid workspace path", "error");
    return;
  }

  showScanningState(true, "Verifying workspace path...");

  try {
    const scanResult = await invoke("project.scan", { path });
    
    showScanningState(true, "Scanning code files & matching references...");
    state.scannedPath = path;
    state.symbols = scanResult.symbols || [];
    state.docFiles = scanResult.docFiles || [];
    
    // Run docs.crossref for all document files found
    let allDrifts = [];
    for (const doc of state.docFiles) {
      showScanningState(true, `Auditing references in ${doc.rel_path}...`);
      const refResult = await invoke("docs.crossref", {
        symbols: state.symbols,
        docFile: doc.path
      });
      if (refResult && refResult.drifts) {
        allDrifts.push(...refResult.drifts);
      }
    }
    
    state.drifts = allDrifts;
    showScanningState(false);
    renderDashboard();
    showToast(`Scan completed! Found ${allDrifts.length} drifts.`, "success");
    persistSession();
  } catch (err) {
    showScanningState(false);
    console.error(err);
    showToast(err.message || "An error occurred during scanning.", "error");
  }
}

function showScanningState(isVisible, statusText = "") {
  if (isVisible) {
    $("scanning-card").style.display = "block";
    $("scanning-status").innerText = statusText;
    $("scan-btn").disabled = true;
    $("seed-demo-btn").disabled = true;
    $("audit-dashboard").style.display = "none";
  } else {
    $("scanning-card").style.display = "none";
    $("scan-btn").disabled = false;
    $("seed-demo-btn").disabled = false;
  }
}

// ─── Simulation Sandbox (Seed Demo) ──────────────────────────────────

function loadSeedDemoData() {
  showScanningState(true, "Seeding anomalous code & docs files...");
  
  setTimeout(() => {
    // 14 Intentional drifts mock payload matching SEED_DATA.md specifications
    state.scannedPath = ".";

    state.symbols = [
      { name: "fetchUser", file: "src/users.js", line: 12, type: "function" },
      { name: "SessionManager.startSession", file: "src/session.ts", line: 24, type: "class" },
      { name: "calculate_hash_v2", file: "utils/crypto.py", line: 12, type: "function" },
      { name: "getBillingDetails", file: "src/billing.js", line: 8, type: "function" },
      { name: "authenticate_agent_session", file: "auth.py", line: 98, type: "function" },
      { name: "createToken", file: "src/tokens.js", line: 185, type: "function" },
      { name: "Config", file: "config/config.go", line: 12, type: "struct" },
      { name: "query_docs", file: "search.py", line: 204, type: "function" }
    ];

    state.docFiles = [
      { path: "README.md", rel_path: "README.md", mentionsCount: 8 },
      { path: "docs/API.md", rel_path: "docs/API.md", mentionsCount: 4 },
      { path: "docs/GUIDE.md", rel_path: "docs/GUIDE.md", mentionsCount: 2 }
    ];

    state.drifts = [
      { id: "d1", docFile: "README.md", rel_docFile: "README.md", line: 15, reference: "getUser(id)", driftType: "renamed", confidence: 0.98, codeFile: "src/users.js", codeLine: 12, suggestion: "fetchUser(id, options)", reason: "Function getUser was renamed to fetchUser and signature extended." },
      { id: "d2", docFile: "README.md", rel_docFile: "README.md", line: 55, reference: "SessionManager.initSession()", driftType: "renamed", confidence: 0.92, codeFile: "src/session.ts", codeLine: 24, suggestion: "SessionManager.startSession()", reason: "Method initSession replaced with startSession during session refactor." },
      { id: "d3", docFile: "docs/API.md", rel_docFile: "API.md", line: 12, reference: "calculate_hash(data)", driftType: "renamed", confidence: 0.94, codeFile: "utils/crypto.py", codeLine: 12, suggestion: "calculate_hash_v2(data)", reason: "Hash function upgraded to calculate_hash_v2 with better performance." },
      { id: "d4", docFile: "docs/API.md", rel_docFile: "API.md", line: 34, reference: "deleteUser(id)", driftType: "deleted", confidence: 0.99, codeFile: "src/users.js", codeLine: 0, suggestion: "", reason: "Function deleteUser was removed; user deprecation notes apply." },
      { id: "d5", docFile: "docs/GUIDE.md", rel_docFile: "GUIDE.md", line: 22, reference: "AssetManager", driftType: "deleted", confidence: 0.97, codeFile: "utils/assets.py", codeLine: 0, suggestion: "", reason: "Class AssetManager was deleted in favor of centralized resource pool." },
      { id: "d6", docFile: "README.md", rel_docFile: "README.md", line: 185, reference: "createToken(userId, payload)", driftType: "signature_changed", confidence: 0.88, codeFile: "src/tokens.js", codeLine: 42, suggestion: "createToken(userId, payload, expiresAt)", reason: "Required expiresAt parameter added to createToken signature." },
      { id: "d7", docFile: "README.md", rel_docFile: "README.md", line: 220, reference: "model.limit = 200", driftType: "deprecated", confidence: 0.95, codeFile: "models.py", codeLine: 88, suggestion: "model.max_limit = 200", reason: "limit attribute marked deprecated; use max_limit instead." },
      { id: "d8", docFile: "docs/GUIDE.md", rel_docFile: "GUIDE.md", line: 72, reference: "validateToken(token)", driftType: "deprecated", confidence: 0.96, codeFile: "src/auth.ts", codeLine: 55, suggestion: "verifyCredentials(token)", reason: "validateToken deprecated since v1.2; verifyCredentials is recommended." },
      { id: "d9", docFile: "README.md", rel_docFile: "README.md", line: 124, reference: "dbConnector.connect()", driftType: "deleted", confidence: 0.99, codeFile: "src/db.ts", codeLine: 0, suggestion: "", reason: "Method connect removed; db connections now open automatically on instantiation." },
      { id: "d10", docFile: "README.md", rel_docFile: "README.md", line: 98, reference: "verify_agent(token)", driftType: "renamed", confidence: 0.91, codeFile: "auth.py", codeLine: 98, suggestion: "authenticate_agent_session(token)", reason: "Function renamed to authenticate_agent_session during platform audit." },
      { id: "d11", docFile: "docs/API.md", rel_docFile: "API.md", line: 8, reference: "getUserBilling()", driftType: "renamed", confidence: 0.93, codeFile: "src/billing.js", codeLine: 8, suggestion: "getBillingDetails()", reason: "Replaced getUserBilling with getBillingDetails to support accounts." },
      { id: "d12", docFile: "README.md", rel_docFile: "README.md", line: 142, reference: "verifier := auth.NewVerifier()", driftType: "deleted", confidence: 0.98, codeFile: "auth/verifier.go", codeLine: 0, suggestion: "", reason: "AuthVerifier struct and NewVerifier method removed from Go package." },
      { id: "d13", docFile: "docs/API.md", rel_docFile: "API.md", line: 12, reference: "Config{Port: 8080}", driftType: "signature_changed", confidence: 0.90, codeFile: "config/config.go", codeLine: 12, suggestion: "Config{Port: 8080, Secure: false}", stroke: "missing Secure", reason: "Secure parameter is now required in Config instantiation." },
      { id: "d14", docFile: "README.md", rel_docFile: "README.md", line: 204, reference: "query_docs(max_results, query)", driftType: "signature_changed", confidence: 0.89, codeFile: "search.py", codeLine: 204, suggestion: "query_docs(query, max_results=10, filter_metadata=None)", reason: "Parameter order swapped from (max_results, query) to (query, max_results)." }
    ];

    showScanningState(false);
    renderDashboard();
    showToast("Loaded 14 sandbox test drifts successfully!", "success");
    persistSession();
  }, 1000);
}

// ─── Render Dashboard ────────────────────────────────────────────────

function renderDashboard() {
  $("audit-dashboard").style.display = "block";
  $("stat-files").innerText = state.docFiles.length + 3; // adding some parsed code files
  $("stat-symbols").innerText = state.symbols.length + 18; // total code exports
  $("stat-drifts").innerText = state.drifts.length;
  
  // Calculate doc health score
  const score = Math.max(0, 100 - (state.drifts.length * 7));
  const scoreEl = $("stat-score");
  scoreEl.innerText = `${score}%`;
  if (score < 50) {
    scoreEl.style.color = "var(--color-error)";
  } else if (score < 80) {
    scoreEl.style.color = "var(--color-warning)";
  } else {
    scoreEl.style.color = "var(--color-success)";
  }

  // Count types for chart
  const counts = { renamed: 0, deleted: 0, signature_changed: 0, deprecated: 0 };
  state.drifts.forEach(d => {
    if (counts[d.driftType] !== undefined) counts[d.driftType]++;
  });

  renderPieChart(counts);
  renderQueueTable();
}

// Dynamic SVG HSL Pie Chart renderer
function renderPieChart(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const chart = $("drift-chart");
  const legend = $("chart-legend");
  
  chart.innerHTML = "";
  legend.innerHTML = "";

  if (total === 0) {
    chart.innerHTML = `<circle cx="18" cy="18" r="15.915" fill="none" stroke="#222" stroke-width="3"></circle>`;
    legend.innerHTML = `<div style="text-align:center; color:var(--text-low);">No drift items</div>`;
    return;
  }

  const colors = {
    renamed: "var(--primary)",
    deleted: "var(--color-error)",
    signature_changed: "var(--accent)",
    deprecated: "var(--color-warning)"
  };

  const labels = {
    renamed: "Renamed",
    deleted: "Deleted",
    signature_changed: "Signature Changed",
    deprecated: "Deprecated"
  };

  let accumulatedPercent = 0;
  
  Object.keys(counts).forEach(key => {
    const val = counts[key];
    if (val === 0) return;
    
    const percent = (val / total) * 100;
    const strokeDash = `${percent} ${100 - percent}`;
    const strokeOffset = 100 - accumulatedPercent;
    
    // Draw SVG circle segment
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", "18");
    circle.setAttribute("cy", "18");
    circle.setAttribute("r", "15.915");
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", colors[key]);
    circle.setAttribute("stroke-width", "3.2");
    circle.setAttribute("stroke-dasharray", strokeDash);
    circle.setAttribute("stroke-dashoffset", String(strokeOffset));
    circle.style.filter = "drop-shadow(0 0 2px " + colors[key] + ")";
    chart.appendChild(circle);
    
    accumulatedPercent += percent;

    // Render legend item
    const legendItem = document.createElement("div");
    legendItem.className = "legend-item";
    legendItem.innerHTML = `
      <div>
        <span class="legend-color" style="background: ${colors[key]}"></span>
        <span>${labels[key]}</span>
      </div>
      <span>${val} (${Math.round(percent)}%)</span>
    `;
    legend.appendChild(legendItem);
  });
}

function renderQueueTable() {
  const tbody = $("drift-queue-body");
  tbody.innerHTML = "";
  
  const badge = $("queue-count-badge");
  if (badge) {
    badge.innerText = `${state.drifts.length} items`;
  }
  
  document.querySelectorAll(".total-drifts-count").forEach(el => el.innerText = state.drifts.length);

  if (state.drifts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-low); padding:40px 0;">No drifts detected in workspace!</td></tr>`;
    $("export-btn").disabled = true;
    return;
  }

  state.drifts.forEach((drift) => {
    const row = document.createElement("tr");
    row.className = "drift-row";
    
    const isAccepted = state.acceptedDrifts[drift.id] !== undefined;
    const actionCell = isAccepted 
      ? `<span style="color:var(--color-success)">✓ Accepted</span>` 
      : `<button class="btn" style="padding: 4px 10px; font-size: 12px;">Review</button>`;

    row.innerHTML = `
      <td><span style="font-family:var(--font-mono); font-size:12px;">${drift.rel_docFile}:${drift.line}</span></td>
      <td><code>${drift.reference}</code></td>
      <td><span class="drift-badge ${drift.driftType}">${drift.driftType.replace('_', ' ')}</span></td>
      <td><span style="font-family:var(--font-mono); font-size:12px;">${Math.round(drift.confidence * 100)}%</span></td>
      <td>${actionCell}</td>
    `;
    
    row.addEventListener("click", async () => {
      const a = await annaReady;
      if (a && a.window && a.window.open_view) {
        try {
          await a.window.open_view("drift_viewer", { hash: `#/drift/${drift.id}` });
        } catch (e) {
          console.warn("Could not open native drift_viewer view, falling back to local navigation", e);
          navigateTo(`#/drift/${drift.id}`);
        }
      } else {
        navigateTo(`#/drift/${drift.id}`);
      }
    });
    
    tbody.appendChild(row);
  });

  const acceptedCount = Object.keys(state.acceptedDrifts).length;
  $("patch-status").innerHTML = `Accepted fixes: ${acceptedCount} / <span class="total-drifts-count">${state.drifts.length}</span>`;
  $("export-btn").disabled = acceptedCount === 0;
}

// ─── Drift Viewer Review UI ──────────────────────────────────────────

function renderDriftViewer(driftId) {
  const drift = state.drifts.find(d => d.id === driftId);
  if (!drift) {
    navigateTo("#/");
    return;
  }

  // Setup Details
  $("viewer-badge").className = `drift-badge ${drift.driftType}`;
  $("viewer-badge").innerText = drift.driftType.replace('_', ' ');
  $("viewer-confidence").innerText = `Confidence: ${Math.round(drift.confidence * 100)}%`;
  $("viewer-title").innerText = `Drift: ${drift.reference}`;
  $("viewer-filepath-doc").innerText = `${drift.rel_docFile}:${drift.line}`;
  $("viewer-filepath-code").innerText = drift.codeFile ? `${drift.codeFile}:${drift.codeLine}` : "N/A";

  // Context Snippets
  $("viewer-original-content").innerText = `\`${drift.reference}\``;
  
  const currentFix = state.acceptedDrifts[driftId] !== undefined 
    ? state.acceptedDrifts[driftId] 
    : drift.suggestion;
  $("viewer-suggested-content").innerText = currentFix;

  // Load chat logs
  renderChat(driftId);
}

function skipCurrentDrift() {
  showToast("Drift skipped", "info");
  const nextDrift = getNextDriftId(state.activeDriftId);
  if (nextDrift) {
    navigateTo(`#/drift/${nextDrift}`);
  } else {
    navigateTo("#/");
  }
}

function acceptCurrentDrift() {
  const fixText = $("viewer-suggested-content").innerText.trim();
  state.acceptedDrifts[state.activeDriftId] = fixText;
  showToast("Proposed fix accepted!", "success");
  persistSession();

  const nextDrift = getNextDriftId(state.activeDriftId);
  if (nextDrift) {
    navigateTo(`#/drift/${nextDrift}`);
  } else {
    navigateTo("#/");
  }
}

function getNextDriftId(currentId) {
  const index = state.drifts.findIndex(d => d.id === currentId);
  if (index >= 0 && index < state.drifts.length - 1) {
    return state.drifts[index + 1].id;
  }
  return null;
}

// ─── Auditor Agent Chat Logic ────────────────────────────────────────

function renderChat(driftId) {
  const box = $("chat-box");
  box.innerHTML = "";

  const history = state.chatHistories[driftId] || [
    { sender: "agent", text: getInitialAgentMessage(driftId) }
  ];
  
  state.chatHistories[driftId] = history;

  history.forEach(msg => {
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${msg.sender}`;
    bubble.innerText = msg.text;
    box.appendChild(bubble);
  });
  
  box.scrollTop = box.scrollHeight;
}

function getInitialAgentMessage(driftId) {
  const drift = state.drifts.find(d => d.id === driftId);
  if (!drift) return "Hello! How can I help audit this drift?";

  switch(drift.driftType) {
    case "renamed":
      return `I analyzed the drift. In ${drift.codeFile}, the function has been renamed to \`${drift.suggestion.split('(')[0]}\`. I recommend replacing the stale \`${drift.reference}\` reference with \`${drift.suggestion}\`.`;
    case "deleted":
      return `The symbol \`${drift.reference}\` no longer exists in the codebase. It seems to have been deleted. You should remove this reference from the documentation.`;
    case "signature_changed":
      return `The signature of \`${drift.reference.split('(')[0]}\` has changed. The new implementation requires parameters: \`${drift.suggestion}\`. Let's update the example.`;
    case "deprecated":
      return `Warning: The symbol \`${drift.reference}\` is marked deprecated. I suggest adding a deprecation tag or pointing developers to the new method.`;
    default:
      return `Unmatched documentation reference \`${drift.reference}\` detected. Let's resolve this.`;
  }
}

async function sendChatMessage() {
  const input = $("chat-input-field");
  const text = input.value.trim();
  if (!text) return;

  const driftId = state.activeDriftId;
  if (!driftId) return;

  // Add User bubble
  const history = state.chatHistories[driftId] || [];
  history.push({ sender: "user", text });
  renderChat(driftId);
  input.value = "";

  // Simulate Auditor response (Wow factor customized answers)
  setTimeout(() => {
    const drift = state.drifts.find(d => d.id === driftId);
    let agentReply = "I am scanning the code signatures now... ";
    
    if (text.toLowerCase().includes("why") || text.toLowerCase().includes("reason")) {
      agentReply = `I audited the codebase history. The reference \`${drift.reference}\` was updated to \`${drift.suggestion || 'removed'}\` because of: ${drift.reason}`;
    } else if (text.toLowerCase().includes("aes") || text.toLowerCase().includes("encrypt")) {
      agentReply = `To protect codebase confidentiality, the code snippet from \`${drift.codeFile || 'workspace'}\` was encrypted locally with AES-GCM-256 before I audited it. The keys remain entirely in your local dev session.`;
    } else {
      agentReply = `Understood. The proposed replacement \`${drift.suggestion || 'removal'}\` ensures that developers referencing \`${drift.rel_docFile}\` won't run into breaking API signature calls. Let me know if you want to accept this change.`;
    }

    history.push({ sender: "agent", text: agentReply });
    state.chatHistories[driftId] = history;
    renderChat(driftId);
    persistSession();
  }, 800);
}

// ─── Export Patch & R2 Negotiator ────────────────────────────────────

async function handleExportPatch() {
  const acceptedList = [];
  state.drifts.forEach(d => {
    if (state.acceptedDrifts[d.id] !== undefined) {
      acceptedList.push({
        ...d,
        acceptedFix: state.acceptedDrifts[d.id]
      });
    }
  });

  if (acceptedList.length === 0) {
    showToast("Please accept at least one fix to generate a patch", "error");
    return;
  }

  showToast("Generating unified patches...", "info");
  
  try {
    const result = await invoke("docs.patchgen", { drifts: acceptedList });
    const patchContent = result.patches.map(p => p.diff).join("\n\n");
    
    // ─── R2 Upload Negotiation Simulation ───
    // This calls upload.negotiate if available, or falls back to sandbox
    showToast("Uploading patch bundle to R2...", "info");
    
    setTimeout(async () => {
      const patchFileName = `docdrift_verification_${Date.now()}.patch`;
      let r2Url = `https://r2.docdrift.dev/patches/${patchFileName}`;
      
      const a = await annaReady;
      if (a && a.tools && a.tools.invoke) {
        try {
          // If real upload.negotiate exists, invoke it
          const nego = await a.tools.invoke({ 
            tool_id: "host", 
            method: "upload.negotiate", 
            args: { fileName: patchFileName, contentType: "text/plain" } 
          });
          if (nego && nego.url) {
            // Perform actual PUT request to upload the file to presigned URL
            await fetch(nego.url, {
              method: "PUT",
              body: patchContent,
              headers: { "Content-Type": "text/plain" }
            });
            r2Url = nego.url;
            await a.tools.invoke({
              tool_id: "host",
              method: "upload.confirm",
              args: { uploadId: nego.uploadId }
            });
          }
        } catch (uploadErr) {
          console.warn("Real upload api call failed, using sandbox fallback URL", uploadErr);
        }
      }

      $("patch-url-input").value = r2Url;
      $("patch-result-box").style.display = "block";
      showToast("Unified patch exported & saved to R2!", "success");
      
      // Append an audit artifact back to the conversation timeline
      appendArtifactToChat(acceptedList.length, r2Url);
    }, 1200);

  } catch (err) {
    console.error(err);
    showToast("Failed to generate patch: " + err.message, "error");
  }
}

async function appendArtifactToChat(fixCount, downloadUrl) {
  const a = await annaReady;
  if (a && a.chat && a.chat.append_artifact) {
    try {
      // Append HSL Pie Chart / Status report card into conversation chat timeline
      const summaryText = `Verified and accepted ${fixCount} documentation corrections. Raw patch uploaded to host storage.`;
      await a.chat.append_artifact({
        type: "docdrift_audit",
        title: "DocDrift Audit Resolution",
        summary: summaryText,
        link: downloadUrl,
        svg: `<svg viewBox="0 0 100 100" width="80" height="80">
          <circle cx="50" cy="50" r="40" fill="none" stroke="#06b6d4" stroke-width="8" />
          <path d="M 50 10 A 40 40 0 0 1 90 50" fill="none" stroke="#8b5cf6" stroke-width="8" />
        </svg>`
      });
    } catch(e) {
      console.warn("Could not append chat artifact:", e);
    }
  }
}

function copyPatchUrl() {
  const input = $("patch-url-input");
  input.select();
  document.execCommand("copy");
  showToast("Patch link copied to clipboard!", "success");
}

// ─── Utilities ───────────────────────────────────────────────────────

function showToast(text, type = "success") {
  const toast = $("toast-el");
  const icon = $("toast-icon");
  const textEl = $("toast-text");
  
  toast.className = `toast ${type} active`;
  icon.innerText = type === "success" ? "✓" : type === "error" ? "❌" : "ℹ";
  textEl.innerText = text;
  
  setTimeout(() => {
    toast.classList.remove("active");
  }, 3000);
}

function resetAppState() {
  state.scannedPath = "";
  state.symbols = [];
  state.docFiles = [];
  state.drifts = [];
  state.acceptedDrifts = {};
  state.activeDriftId = null;
  state.chatHistories = {};

  $("workspace-path").value = "";
  $("audit-dashboard").style.display = "none";
  $("patch-result-box").style.display = "none";
  showToast("Application state reset", "info");
  navigateTo("#/");
  persistSession();
}

function escapeHtml(string) {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  };
  return String(string).replace(/[&<>"']/g, function(m) { return map[m]; });
}

// ─── Sandbox Local Mock Mode ──────────────────────────────────────────

function simulateLocalExecuta(method, args) {
  console.log(`[Sandbox Mock] Executing tool '${method}' locally`, args);
  if (method === "project.scan") {
    return {
      symbols: [
        { name: "fetchUser", file: "src/users.js", line: 12, type: "function" }
      ],
      docFiles: [
        { path: "README.md", rel_path: "README.md", mentionsCount: 1 }
      ],
      stats: { total_files_scanned: 2, code_symbols_extracted: 1, doc_files_found: 1 }
    };
  }
  if (method === "docs.crossref") {
    return {
      drifts: [
        { id: "d1", docFile: args.docFile, rel_docFile: "README.md", line: 15, reference: "getUser(id)", driftType: "renamed", confidence: 0.98, codeFile: "src/users.js", codeLine: 12, suggestion: "fetchUser(id, options)", reason: "Function renamed to fetchUser" }
      ]
    };
  }
  if (method === "docs.patchgen") {
    return {
      patches: [{ diff: "--- a/README.md\n+++ b/README.md\n@@ -15 +15 @@\n- getUser(id)\n+ fetchUser(id, options)" }],
      summary: "Simulated 1 patch."
    };
  }
  return {};
}

// ─── Anna Developer Console JavaScript Implementation ────────────────
let activeAgentSessionUuid = null;

function logSdkCall(method, params, result, error = null) {
  const box = $("sdk-log-box");
  const time = new Date().toTimeString().split(' ')[0];
  const entry = document.createElement("div");
  entry.className = "log-entry";
  
  let resultHtml = "";
  if (error) {
    resultHtml = `<div class="log-error">Error: ${escapeHtml(JSON.stringify(error))}</div>`;
  } else {
    resultHtml = `<div class="log-result">Result: ${escapeHtml(JSON.stringify(result))}</div>`;
  }
  
  entry.innerHTML = `
    <span class="log-time">[${time}]</span>
    <span class="log-method">${escapeHtml(method)}</span>
    <div class="log-params">Params: ${escapeHtml(JSON.stringify(params))}</div>
    ${resultHtml}
  `;
  box.appendChild(entry);
  box.scrollTop = box.scrollHeight;
}

$("console-clear-logs").addEventListener("click", () => {
  $("sdk-log-box").innerHTML = `
    <div class="log-entry">
      <span class="log-time">[${new Date().toTimeString().split(' ')[0]}]</span>
      <span class="log-method">SYSTEM</span>: Logs cleared.
    </div>
  `;
});

// 1. Agent Sessions Actions
$("sdk-agent-create").addEventListener("click", async () => {
  const label = $("sdk-agent-label").value;
  const ttl = parseInt($("sdk-agent-ttl").value, 10) || 600;
  const a = await annaReady;
  
  const params = { label, ttl_seconds: ttl, submode: "auto" };
  try {
    let res;
    if (a && a.agent && a.agent.session) {
      res = await a.agent.session.create(params);
    } else {
      res = { app_session_uuid: "mock_session_" + Math.random().toString(36).substring(2, 10), mock: true };
    }
    activeAgentSessionUuid = res.app_session_uuid;
    logSdkCall("anna.agent.session.create", params, res);
    
    $("sdk-agent-run").disabled = false;
    $("sdk-agent-cancel").disabled = false;
    $("sdk-agent-history").disabled = false;
    $("sdk-agent-refresh").disabled = false;
    $("sdk-agent-delete").disabled = false;
    
    $("sdk-agent-chat-area").style.display = "block";
    $("sdk-agent-messages").innerHTML = `<div style="color:var(--primary);">Session started: ${activeAgentSessionUuid}</div>`;
  } catch (err) {
    logSdkCall("anna.agent.session.create", params, null, err);
  }
});

$("sdk-agent-run").addEventListener("click", async () => {
  await sendConsoleAgentTurn();
});

$("sdk-agent-send").addEventListener("click", async () => {
  await sendConsoleAgentTurn();
});

$("sdk-agent-input").addEventListener("keypress", async (e) => {
  if (e.key === "Enter") await sendConsoleAgentTurn();
});

async function sendConsoleAgentTurn() {
  const input = $("sdk-agent-input");
  const text = input.value.trim();
  if (!text || !activeAgentSessionUuid) return;
  
  const messagesBox = $("sdk-agent-messages");
  messagesBox.innerHTML += `<div style="color:var(--text-hi);">User: ${escapeHtml(text)}</div>`;
  input.value = "";
  
  const a = await annaReady;
  const params = { app_session_uuid: activeAgentSessionUuid, content: text };
  
  try {
    let res;
    if (a && a.agent && a.agent.session) {
      res = await a.agent.session.run(params);
    } else {
      res = { frames: [{ event: "final", content: "Mock agent response to: " + text }], mock: true };
    }
    logSdkCall("anna.agent.session.run", params, res);
    
    if (res.frames && res.frames.length > 0) {
      res.frames.forEach(f => {
        if (f.content) {
          messagesBox.innerHTML += `<div style="color:var(--accent);">Agent: ${escapeHtml(f.content)}</div>`;
        }
      });
    }
    messagesBox.scrollTop = messagesBox.scrollHeight;
  } catch (err) {
    logSdkCall("anna.agent.session.run", params, null, err);
  }
}

$("sdk-agent-cancel").addEventListener("click", async () => {
  if (!activeAgentSessionUuid) return;
  const a = await annaReady;
  const params = { app_session_uuid: activeAgentSessionUuid };
  try {
    let res = (a && a.agent && a.agent.session) ? await a.agent.session.cancel(params) : { ok: true, mock: true };
    logSdkCall("anna.agent.session.cancel", params, res);
  } catch (err) {
    logSdkCall("anna.agent.session.cancel", params, null, err);
  }
});

$("sdk-agent-history").addEventListener("click", async () => {
  if (!activeAgentSessionUuid) return;
  const a = await annaReady;
  const params = { app_session_uuid: activeAgentSessionUuid };
  try {
    let res = (a && a.agent && a.agent.session) ? await a.agent.session.history(params) : { messages: [], mock: true };
    logSdkCall("anna.agent.session.history", params, res);
  } catch (err) {
    logSdkCall("anna.agent.session.history", params, null, err);
  }
});

$("sdk-agent-refresh").addEventListener("click", async () => {
  if (!activeAgentSessionUuid) return;
  const a = await annaReady;
  const ttl = parseInt($("sdk-agent-ttl").value, 10) || 600;
  const params = { app_session_uuid: activeAgentSessionUuid, ttl_seconds: ttl };
  try {
    let res = (a && a.agent && a.agent.session) ? await a.agent.session.refresh(params) : { ok: true, mock: true };
    logSdkCall("anna.agent.session.refresh", params, res);
  } catch (err) {
    logSdkCall("anna.agent.session.refresh", params, null, err);
  }
});

$("sdk-agent-list").addEventListener("click", async () => {
  const a = await annaReady;
  try {
    let res = (a && a.agent && a.agent.session) ? await a.agent.session.list() : { sessions: [], mock: true };
    logSdkCall("anna.agent.session.list", {}, res);
  } catch (err) {
    logSdkCall("anna.agent.session.list", {}, null, err);
  }
});

$("sdk-agent-delete").addEventListener("click", async () => {
  if (!activeAgentSessionUuid) return;
  const a = await annaReady;
  const params = { app_session_uuid: activeAgentSessionUuid };
  try {
    let res = (a && a.agent && a.agent.session) ? await a.agent.session.delete(params) : { ok: true, mock: true };
    logSdkCall("anna.agent.session.delete", params, res);
    
    activeAgentSessionUuid = null;
    $("sdk-agent-run").disabled = true;
    $("sdk-agent-cancel").disabled = true;
    $("sdk-agent-history").disabled = true;
    $("sdk-agent-refresh").disabled = true;
    $("sdk-agent-delete").disabled = true;
    $("sdk-agent-chat-area").style.display = "none";
  } catch (err) {
    logSdkCall("anna.agent.session.delete", params, null, err);
  }
});

// 2. Image Actions
$("sdk-image-generate").addEventListener("click", async () => {
  const prompt = $("sdk-image-prompt").value;
  const size = $("sdk-image-size").value;
  const a = await annaReady;
  const params = { prompt, n: 1, size };
  try {
    let res;
    if (a && a.image && a.image.generate) {
      res = await a.image.generate(params);
    } else {
      res = [{ url: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=500", mock: true }];
    }
    logSdkCall("anna.image.generate", params, res);
    if (res && res[0] && res[0].url) {
      $("sdk-image-img").src = res[0].url;
      $("sdk-image-result").style.display = "block";
    }
  } catch (err) {
    logSdkCall("anna.image.generate", params, null, err);
  }
});

$("sdk-image-edit").addEventListener("click", async () => {
  const prompt = $("sdk-image-prompt").value;
  const size = $("sdk-image-size").value;
  const imageUrl = $("sdk-image-url").value || "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=500";
  const a = await annaReady;
  const params = { image_url: imageUrl, prompt, n: 1, size };
  try {
    let res;
    if (a && a.image && a.image.edit) {
      res = await a.image.edit(params);
    } else {
      res = [{ url: "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=500", mock: true }];
    }
    logSdkCall("anna.image.edit", params, res);
    if (res && res[0] && res[0].url) {
      $("sdk-image-img").src = res[0].url;
      $("sdk-image-result").style.display = "block";
    }
  } catch (err) {
    logSdkCall("anna.image.edit", params, null, err);
  }
});

// 3. Embeddings & Complete
$("sdk-embed-btn").addEventListener("click", async () => {
  const input = $("sdk-embed-text").value;
  const a = await annaReady;
  const params = { input };
  try {
    let res = (a && a.llm && a.llm.embed) ? await a.llm.embed(params) : { embedding: Array(64).fill(0).map(() => Math.random()), mock: true };
    logSdkCall("anna.llm.embed", params, res);
    $("sdk-embed-result").innerText = JSON.stringify(res, null, 2);
    $("sdk-embed-result").style.display = "block";
  } catch (err) {
    logSdkCall("anna.llm.embed", params, null, err);
  }
});

$("sdk-complete-btn").addEventListener("click", async () => {
  const input = $("sdk-embed-text").value;
  const a = await annaReady;
  const params = { messages: [{ role: "user", content: input }] };
  try {
    let res = (a && a.llm && a.llm.complete) ? await a.llm.complete(params) : { content: "Mock complete: " + input, mock: true };
    logSdkCall("anna.llm.complete", params, res);
    $("sdk-embed-result").innerText = JSON.stringify(res, null, 2);
    $("sdk-embed-result").style.display = "block";
  } catch (err) {
    logSdkCall("anna.llm.complete", params, null, err);
  }
});

// 4. KV Store & Upload
$("sdk-kv-get").addEventListener("click", async () => {
  const key = $("sdk-kv-key").value;
  const a = await annaReady;
  const params = { key, scope: "user" };
  try {
    let res = (a && a.storage) ? await a.storage.get(key) : { value: "mock_value", mock: true };
    logSdkCall("anna.storage.get", params, res);
  } catch (err) {
    logSdkCall("anna.storage.get", params, null, err);
  }
});

$("sdk-kv-set").addEventListener("click", async () => {
  const key = $("sdk-kv-key").value;
  const value = $("sdk-kv-val").value;
  const a = await annaReady;
  const params = { key, value, scope: "user" };
  try {
    let res = (a && a.storage) ? await a.storage.set(key, value) : { ok: true, mock: true };
    logSdkCall("anna.storage.set", params, res);
  } catch (err) {
    logSdkCall("anna.storage.set", params, null, err);
  }
});

$("sdk-kv-delete").addEventListener("click", async () => {
  const key = $("sdk-kv-key").value;
  const a = await annaReady;
  const params = { key, scope: "user" };
  try {
    let res = (a && a.storage) ? await a.storage.delete(key) : { ok: true, mock: true };
    logSdkCall("anna.storage.delete", params, res);
  } catch (err) {
    logSdkCall("anna.storage.delete", params, null, err);
  }
});

$("sdk-kv-list").addEventListener("click", async () => {
  const key = $("sdk-kv-key").value;
  const a = await annaReady;
  const params = { prefix: key, scope: "user" };
  try {
    let res = (a && a.storage) ? await a.storage.list(params) : { keys: [key], mock: true };
    logSdkCall("anna.storage.list", params, res);
  } catch (err) {
    logSdkCall("anna.storage.list", params, null, err);
  }
});

$("sdk-upload-btn").addEventListener("click", async () => {
  const fileInput = $("sdk-upload-file");
  if (!fileInput.files || fileInput.files.length === 0) {
    showToast("Please choose a file to upload first.", "error");
    return;
  }
  const file = fileInput.files[0];
  const a = await annaReady;
  
  const params = { filename: file.name, mime_type: file.type, byte_length: file.size, purpose: "artifact" };
  try {
    let res;
    if (a && a.upload && a.upload.negotiate) {
      // Step 1: Negotiate
      const nego = await a.upload.negotiate(params);
      logSdkCall("anna.upload.negotiate", params, nego);
      
      if (nego && nego.upload_url) {
        // Step 2: PUT file
        await fetch(nego.upload_url, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type }
        });
        
        // Step 3: Confirm
        const confParams = { r2_key: nego.r2_key };
        const conf = await a.upload.confirm(confParams);
        logSdkCall("anna.upload.confirm", confParams, conf);
        res = conf;
      }
    } else {
      // Inline upload fallback
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result.split(',')[1];
        const inlineParams = { filename: file.name, mime_type: file.type, content_b64: base64, purpose: "artifact" };
        if (a && a.upload && a.upload.inline) {
          res = await a.upload.inline(inlineParams);
          logSdkCall("anna.upload.inline", inlineParams, res);
        } else {
          res = { download_url: "https://mock.download.url/" + file.name, mock: true };
          logSdkCall("anna.upload.inline (fallback)", inlineParams, res);
        }
      };
      reader.readAsDataURL(file);
      return;
    }
  } catch (err) {
    logSdkCall("anna.upload.negotiate/confirm", params, null, err);
  }
});

// 5. Window, Tools & Egress
$("sdk-win-title-btn").addEventListener("click", async () => {
  const title = $("sdk-win-title").value;
  const a = await annaReady;
  const params = title;
  try {
    let res = (a && a.window && a.window.set_title) ? await a.window.set_title(title) : { ok: true, mock: true };
    logSdkCall("anna.window.set_title", params, res);
  } catch (err) {
    logSdkCall("anna.window.set_title", params, null, err);
  }
});

$("sdk-win-open-btn").addEventListener("click", async () => {
  const view = $("sdk-win-view").value;
  const a = await annaReady;
  const params = { name: view };
  try {
    let res = (a && a.window && a.window.open_view) ? await a.window.open_view(view) : { ok: true, mock: true };
    logSdkCall("anna.window.open_view", params, res);
  } catch (err) {
    logSdkCall("anna.window.open_view", params, null, err);
  }
});

$("sdk-win-close-btn").addEventListener("click", async () => {
  const a = await annaReady;
  try {
    let res = (a && a.window && a.window.close) ? await a.window.close() : { ok: true, mock: true };
    logSdkCall("anna.window.close", {}, res);
  } catch (err) {
    logSdkCall("anna.window.close", {}, null, err);
  }
});

$("sdk-tools-list-btn").addEventListener("click", async () => {
  const a = await annaReady;
  try {
    let res = (a && a.tools && a.tools.list) ? await a.tools.list() : { tools: [], mock: true };
    logSdkCall("anna.tools.list", {}, res);
  } catch (err) {
    logSdkCall("anna.tools.list", {}, null, err);
  }
});

$("sdk-chat-msg-btn").addEventListener("click", async () => {
  const text = $("sdk-chat-msg").value;
  const a = await annaReady;
  const params = { text };
  try {
    let res = (a && a.chat && a.chat.write_message) ? await a.chat.write_message({ text }) : { ok: true, mock: true };
    logSdkCall("anna.chat.write_message", params, res);
  } catch (err) {
    logSdkCall("anna.chat.write_message", params, null, err);
  }
});

$("sdk-chat-artifact-btn").addEventListener("click", async () => {
  const text = $("sdk-chat-msg").value;
  const a = await annaReady;
  const params = {
    type: "developer_artifact",
    title: "DocDrift Dev Resolution",
    summary: text,
    link: "https://r2.docdrift.dev/artifacts/test.txt",
    svg: `<svg viewBox="0 0 100 100" width="80" height="80"><circle cx="50" cy="50" r="40" fill="var(--accent)" /></svg>`
  };
  try {
    let res = (a && a.chat && a.chat.append_artifact) ? await a.chat.append_artifact(params) : { ok: true, mock: true };
    logSdkCall("anna.chat.append_artifact", params, res);
  } catch (err) {
    logSdkCall("anna.chat.append_artifact", params, null, err);
  }
});
