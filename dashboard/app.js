/**
 * ACCESS-MOPPy QC Registry Dashboard
 * Vanilla JS — no build step required.
 * Reads registry.json (compiled by scripts/compile_registry.py).
 */

// ── Configuration ──────────────────────────────────────────────────────────
const GITHUB_REPO = "rbeucher/access-moppy-qc-registry";
const REGISTRY_URL = "registry.json";

// ── Status display helpers ──────────────────────────────────────────────────
const STATUS_LABELS = {
  required:        "✓",
  optional:        "◎",
  proposed:        "?",
  "wont-fix":      "✗",
  "not-applicable":"—",
  global:          "G",   // synthetic: inherited from global wildcard
  missing:         "",    // not mentioned at all
};

const STATUS_TITLE = {
  required:        "Required",
  optional:        "Optional (advisory)",
  proposed:        "Proposed — under discussion",
  "wont-fix":      "Won't fix",
  "not-applicable":"Not applicable",
  global:          "Required (global default)",
  missing:         "Not specified",
};

// ── App state ───────────────────────────────────────────────────────────────
let registry = null;
let currentView = "matrix";

// ── Bootstrap ───────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // Wire nav buttons
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentView = btn.dataset.view;
      renderView();
    });
  });

  // Load registry
  try {
    const resp = await fetch(REGISTRY_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    registry = await resp.json();
  } catch (err) {
    document.getElementById("app").innerHTML =
      `<p style="color:var(--fail)">Failed to load registry.json: ${err.message}</p>`;
    return;
  }

  document.getElementById("registry-meta").textContent =
    `Registry generated ${new Date(registry.generated_at).toLocaleString()} · ` +
    `${registry.checks.length} checks · ${registry.requirements.length} requirements · ` +
    `${registry.variables.length} variables · ${registry.experiments.length} experiments`;

  renderView();
});

// ── View router ─────────────────────────────────────────────────────────────
function renderView() {
  const app = document.getElementById("app");
  app.innerHTML = "";
  if (currentView === "matrix")    renderMatrix(app);
  if (currentView === "variable")  renderVariableDetail(app);
  if (currentView === "check")     renderCheckCoverage(app);
  if (currentView === "proposals") renderProposals(app);
}

// ── Requirement lookup helpers ───────────────────────────────────────────────
/**
 * Returns the "effective" status for a (check, variable, experiment) triple.
 * Priority: explicit variable+experiment > explicit variable+* > *+experiment > *+*
 * Returns "missing" if no requirement entry covers this combination.
 */
function effectiveStatus(checkId, variable, experiment) {
  const reqs = registry.requirements.filter((r) => r.check === checkId);
  if (!reqs.length) return "missing";

  function matches(req) {
    const vMatch = req.variable === variable || req.variable === "*" ||
                   (Array.isArray(req.variable) && (req.variable.includes(variable) || req.variable.includes("*")));
    const eMatch = req.experiment === experiment || req.experiment === "*" ||
                   (Array.isArray(req.experiment) && (req.experiment.includes(experiment) || req.experiment.includes("*")));
    return vMatch && eMatch;
  }

  function specificity(req) {
    const vSpec = req.variable === "*" || (Array.isArray(req.variable) && req.variable.includes("*")) ? 0 : 2;
    const eSpec = req.experiment === "*" || (Array.isArray(req.experiment) && req.experiment.includes("*")) ? 0 : 1;
    return vSpec + eSpec;
  }

  const matching = reqs.filter(matches);
  if (!matching.length) return "missing";

  // Take highest-specificity entry; on tie, last one wins (experiment overrides)
  matching.sort((a, b) => specificity(a) - specificity(b));
  const best = matching[matching.length - 1];
  // Tag global wildcards visually
  if (best.status === "required" && best.variable === "*" && best.experiment === "*") return "global";
  return best.status;
}

/**
 * Returns the effective status across ALL experiments for a (check, variable).
 * Returns the worst status ("fail" order: required > global > optional > proposed > missing > na > wont-fix).
 */
function worstStatus(checkId, variable) {
  const experiments = registry.experiments.length
    ? registry.experiments
    : ["*"];
  const statuses = experiments.map((e) => effectiveStatus(checkId, variable, e));
  const priority = ["required", "global", "optional", "proposed", "missing", "not-applicable", "wont-fix"];
  statuses.sort((a, b) => priority.indexOf(a) - priority.indexOf(b));
  return statuses[0] ?? "missing";
}

// ── View: Experiment Matrix ──────────────────────────────────────────────────
function renderMatrix(container) {
  const categories = [...new Set(registry.checks.map((c) => c.category))].sort();
  const allExperiments = registry.experiments.length ? registry.experiments : ["(all)"];
  const allVariables = registry.variables.length ? registry.variables : [];
  const realms = [...new Set(Object.values(registry.realms))].sort();

  // Controls
  let expFilter = allExperiments[0] ?? "*";
  let varFilter = "";
  let realmFilter = "";

  const controls = document.createElement("div");
  controls.className = "controls";
  controls.innerHTML = `
    <label for="exp-select">Experiment</label>
    <select id="exp-select">
      ${allExperiments.map((e) => `<option value="${e}">${e}</option>`).join("")}
      <option value="*">* (all, worst-case)</option>
    </select>
    <label for="realm-select">Realm</label>
    <select id="realm-select">
      <option value="">All realms</option>
      ${realms.map((r) => `<option value="${r}">${r}</option>`).join("")}
    </select>
    <label for="var-filter">Filter variable</label>
    <input id="var-filter" type="text" placeholder="e.g. tas" style="width:120px"/>
  `;

  const title = document.createElement("div");
  title.className = "view-title";
  title.textContent = "Experiment Matrix";

  const subtitle = document.createElement("div");
  subtitle.className = "view-subtitle";
  subtitle.textContent =
    "Rows = variables · Columns = check categories · Select an experiment to filter.";

  const legend = makeLegend();
  const tableWrap = document.createElement("div");
  tableWrap.className = "matrix-scroll";

  container.appendChild(title);
  container.appendChild(subtitle);
  container.appendChild(controls);
  container.appendChild(legend);
  container.appendChild(tableWrap);

  function redraw() {
    const exp = expFilter;
    const filtered = allVariables.filter((v) => {
      if (varFilter && !v.includes(varFilter)) return false;
      if (realmFilter && registry.realms[v] !== realmFilter) return false;
      return true;
    });
    tableWrap.innerHTML = "";
    if (!filtered.length) {
      tableWrap.innerHTML = "<p style='color:var(--text-muted)'>No variables match the current filters.</p>";
      return;
    }
    tableWrap.appendChild(buildMatrixTable(filtered, categories, exp));
  }

  controls.querySelector("#exp-select").addEventListener("change", (e) => { expFilter = e.target.value; redraw(); });
  controls.querySelector("#realm-select").addEventListener("change", (e) => { realmFilter = e.target.value; redraw(); });
  controls.querySelector("#var-filter").addEventListener("input", (e) => { varFilter = e.target.value.trim(); redraw(); });

  redraw();
}

function buildMatrixTable(variables, categories, experiment) {
  const table = document.createElement("table");
  table.className = "matrix";

  // Header row
  const thead = table.createTHead();
  const headerRow = thead.insertRow();
  headerRow.insertCell().outerHTML = "<th>Variable</th>";
  headerRow.insertCell().outerHTML = "<th>Realm</th>";
  for (const cat of categories) {
    headerRow.insertCell().outerHTML = `<th>${cat}</th>`;
  }

  // Body
  const tbody = table.createTBody();
  for (const variable of variables) {
    const row = tbody.insertRow();
    const varCell = document.createElement("th");
    varCell.innerHTML = `<a href="#" class="var-link" data-var="${variable}">${variable}</a>`;
    row.appendChild(varCell);

    const realmCell = row.insertCell();
    realmCell.textContent = registry.realms[variable] ?? "";
    realmCell.style.color = "var(--text-muted)";
    realmCell.style.fontSize = "0.78rem";

    for (const cat of categories) {
      const checksInCat = registry.checks.filter((c) => c.category === cat);
      // Aggregate: take worst status across all checks in this category
      const statuses = checksInCat.map((c) =>
        experiment === "*"
          ? worstStatus(c.id, variable)
          : effectiveStatus(c.id, variable, experiment)
      );
      const aggStatus = aggregateStatuses(statuses);
      const cell = row.insertCell();
      cell.className = `cell-${aggStatus}`;
      cell.title = `${cat} / ${variable} / ${experiment}: ${STATUS_TITLE[aggStatus] ?? aggStatus}`;
      cell.textContent = STATUS_LABELS[aggStatus] ?? "";
    }
  }

  // Wire variable detail links
  table.querySelectorAll(".var-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      document.querySelector('[data-view="variable"]').classList.add("active");
      currentView = "variable";
      renderVariableDetail(document.getElementById("app"), link.dataset.var);
    });
  });

  return table;
}

function aggregateStatuses(statuses) {
  const priority = ["required", "global", "optional", "proposed", "missing", "not-applicable", "wont-fix"];
  const sorted = [...statuses].sort((a, b) => priority.indexOf(a) - priority.indexOf(b));
  return sorted[0] ?? "missing";
}

function makeLegend() {
  const items = [
    { cls: "cell-global",   label: "Required (global)" },
    { cls: "cell-required", label: "Required" },
    { cls: "cell-optional", label: "Optional" },
    { cls: "cell-proposed", label: "Proposed" },
    { cls: "cell-wont-fix", label: "Won't fix" },
    { cls: "cell-na",       label: "Not specified" },
  ];
  const div = document.createElement("div");
  div.className = "matrix-legend";
  div.innerHTML = items.map((i) =>
    `<span class="legend-item"><span class="legend-swatch ${i.cls}"></span>${i.label}</span>`
  ).join("");
  return div;
}

// ── View: Variable Detail ────────────────────────────────────────────────────
function renderVariableDetail(container, preselected) {
  container.innerHTML = "";

  const allVariables = registry.variables;

  const title = document.createElement("div");
  title.className = "view-title";
  title.textContent = "Variable Detail";

  const controls = document.createElement("div");
  controls.className = "controls";
  controls.innerHTML = `
    <label for="var-select">Variable</label>
    <select id="var-select">
      <option value="">— select —</option>
      ${allVariables.map((v) => `<option value="${v}">${v}</option>`).join("")}
    </select>
  `;

  container.appendChild(title);
  container.appendChild(controls);

  const tableWrap = document.createElement("div");
  container.appendChild(tableWrap);

  function drawDetail(variable) {
    tableWrap.innerHTML = "";
    if (!variable) return;

    const allExperiments = registry.experiments.length ? registry.experiments : ["*"];
    const allChecks = registry.checks;

    const subtitle = document.createElement("div");
    subtitle.className = "view-subtitle";
    subtitle.textContent =
      `${allChecks.length} checks × ${allExperiments.length} experiments for ${variable}` +
      (registry.realms[variable] ? ` (realm: ${registry.realms[variable]})` : "");
    tableWrap.appendChild(subtitle);

    const table = document.createElement("table");
    table.className = "detail";

    // Header
    const thead = table.createTHead();
    const headerRow = thead.insertRow();
    ["Check", "Category", "Scope", ...allExperiments].forEach((h) => {
      headerRow.insertCell().outerHTML = `<th>${h}</th>`;
    });

    // Body
    const tbody = table.createTBody();
    for (const check of allChecks) {
      const row = tbody.insertRow();
      const nameCell = row.insertCell();
      nameCell.innerHTML = `<code>${check.id}</code><br><span style="color:var(--text-muted);font-size:0.78rem">${check.name}</span>`;

      const catCell = row.insertCell();
      catCell.textContent = check.category;
      catCell.style.color = "var(--text-muted)";

      const scopeCell = row.insertCell();
      scopeCell.innerHTML = `<span class="badge badge-${check.scope === 'global' ? 'global' : 'proposed'}">${check.scope}</span>`;

      for (const exp of allExperiments) {
        const status = effectiveStatus(check.id, variable, exp);
        const cell = row.insertCell();
        cell.className = `cell-${status}`;
        cell.title = STATUS_TITLE[status] ?? status;
        cell.textContent = STATUS_LABELS[status] ?? "";
      }
    }

    tableWrap.appendChild(table);
  }

  const sel = controls.querySelector("#var-select");
  if (preselected) {
    sel.value = preselected;
    drawDetail(preselected);
  }
  sel.addEventListener("change", (e) => drawDetail(e.target.value));
}

// ── View: Check Coverage ─────────────────────────────────────────────────────
function renderCheckCoverage(container) {
  container.innerHTML = "";

  const title = document.createElement("div");
  title.className = "view-title";
  title.textContent = "Check Coverage";

  const controls = document.createElement("div");
  controls.className = "controls";
  controls.innerHTML = `
    <label for="check-select">Check</label>
    <select id="check-select" style="max-width:380px">
      <option value="">— select —</option>
      ${registry.checks.map((c) => `<option value="${c.id}">[${c.category}] ${c.id}</option>`).join("")}
    </select>
  `;

  container.appendChild(title);
  container.appendChild(controls);

  const detailWrap = document.createElement("div");
  container.appendChild(detailWrap);

  function drawCoverage(checkId) {
    detailWrap.innerHTML = "";
    if (!checkId) return;

    const check = registry.checks.find((c) => c.id === checkId);
    if (!check) return;

    // Check card
    const card = document.createElement("div");
    card.className = "card";
    card.style.marginBottom = "1.25rem";
    card.innerHTML = `
      <h3>${check.name}</h3>
      <div class="card-meta">
        <code>${check.id}</code> &nbsp;·&nbsp;
        <span class="badge badge-${check.status}">${check.status}</span> &nbsp;·&nbsp;
        scope: <strong>${check.scope}</strong> &nbsp;·&nbsp;
        severity: <strong>${check.severity}</strong>
        ${check.proposed_by ? `&nbsp;·&nbsp; proposed by <strong>${check.proposed_by}</strong>` : ""}
        ${check.issue ? `&nbsp;·&nbsp; <a href="https://github.com/${GITHUB_REPO}/issues/${check.issue}" target="_blank" rel="noopener">#${check.issue}</a>` : ""}
      </div>
      <p>${check.description ?? ""}</p>
    `;
    detailWrap.appendChild(card);

    // Coverage table
    const allVariables = registry.variables.length ? registry.variables : [];
    const allExperiments = registry.experiments.length ? registry.experiments : ["*"];

    const subtitle = document.createElement("div");
    subtitle.className = "view-subtitle";
    subtitle.textContent = `Coverage across ${allVariables.length} variables × ${allExperiments.length} experiments`;
    detailWrap.appendChild(subtitle);

    const tableWrap = document.createElement("div");
    tableWrap.className = "matrix-scroll";
    const table = document.createElement("table");
    table.className = "matrix";

    const thead = table.createTHead();
    const headerRow = thead.insertRow();
    headerRow.insertCell().outerHTML = "<th>Variable</th>";
    allExperiments.forEach((e) => {
      headerRow.insertCell().outerHTML = `<th>${e}</th>`;
    });

    const tbody = table.createTBody();
    for (const variable of allVariables) {
      const row = tbody.insertRow();
      const th = document.createElement("th");
      th.style.fontFamily = "var(--mono)";
      th.textContent = variable;
      row.appendChild(th);

      for (const exp of allExperiments) {
        const status = effectiveStatus(checkId, variable, exp);
        const cell = row.insertCell();
        cell.className = `cell-${status}`;
        cell.title = STATUS_TITLE[status] ?? status;
        cell.textContent = STATUS_LABELS[status] ?? "";
      }
    }

    tableWrap.appendChild(table);
    detailWrap.appendChild(tableWrap);
  }

  controls.querySelector("#check-select").addEventListener("change", (e) => drawCoverage(e.target.value));
}

// ── View: Open Proposals ─────────────────────────────────────────────────────
function renderProposals(container) {
  container.innerHTML = "";

  const title = document.createElement("div");
  title.className = "view-title";
  title.textContent = "Open Proposals";

  const subtitle = document.createElement("div");
  subtitle.className = "view-subtitle";
  subtitle.innerHTML = `Issues labelled <code>status/proposed</code> on GitHub — fetched live.`;

  container.appendChild(title);
  container.appendChild(subtitle);

  const listEl = document.createElement("div");
  listEl.className = "proposal-list";
  listEl.textContent = "Loading issues from GitHub…";
  container.appendChild(listEl);

  const apiUrl =
    `https://api.github.com/repos/${GITHUB_REPO}/issues` +
    `?state=open&labels=status%2Fproposed&per_page=50`;

  fetch(apiUrl, { headers: { Accept: "application/vnd.github+json" } })
    .then((r) => {
      if (!r.ok) throw new Error(`GitHub API: ${r.status}`);
      return r.json();
    })
    .then((issues) => {
      listEl.innerHTML = "";
      if (!issues.length) {
        listEl.innerHTML =
          `<p style="color:var(--text-muted)">No open proposals right now — ` +
          `<a href="https://github.com/${GITHUB_REPO}/issues/new/choose" target="_blank" rel="noopener">open one</a>.</p>`;
        return;
      }
      for (const issue of issues) {
        const item = document.createElement("div");
        item.className = "proposal-item";

        const labelsHtml = issue.labels
          .map((l) => `<span class="gh-label" style="background:#${l.color}22;color:#${l.color};border:1px solid #${l.color}44">${l.name}</span>`)
          .join("");

        item.innerHTML = `
          <span class="issue-num">#${issue.number}</span>
          <div>
            <h4><a href="${issue.html_url}" target="_blank" rel="noopener">${escHtml(issue.title)}</a></h4>
            <div class="proposal-labels">${labelsHtml}</div>
            ${issue.body ? `<p class="proposal-note">${escHtml(issue.body.slice(0, 200))}${issue.body.length > 200 ? "…" : ""}</p>` : ""}
          </div>
        `;
        listEl.appendChild(item);
      }
    })
    .catch((err) => {
      listEl.innerHTML =
        `<p style="color:var(--text-muted)">Could not load issues from GitHub: ${err.message}.<br>` +
        `<a href="https://github.com/${GITHUB_REPO}/issues?q=is%3Aopen+label%3Astatus%2Fproposed" target="_blank" rel="noopener">View on GitHub directly →</a></p>`;
    });
}

// ── Utilities ────────────────────────────────────────────────────────────────
function escHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
