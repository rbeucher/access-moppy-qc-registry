/**
 * ACCESS-MOPPy QC Registry Dashboard
 * Vanilla JS — no build step required.
 * Reads registry.json (compiled by scripts/compile_registry.py).
 */

const GITHUB_REPO = "rbeucher/access-moppy-qc-registry";
const REGISTRY_URL = "registry.json";
const ADDITIONAL_CATEGORIES = ["spatial", "temporal", "data"];
const GITHUB_NEW_ISSUE_URL = `https://github.com/${GITHUB_REPO}/issues/new/choose`;
const LINK_CONTEXT = {
  variable: "",
  experiment: "",
  detail_filter: "",
  model: "",
  member: "",
};

const RESULT_LABELS = {
  pass: "PASS",
  fail: "FAIL",
  not_done: "ND",
  "not-applicable": "N/A",
  missing: "",
};

const RESULT_TITLE = {
  pass: "Check passed",
  fail: "Check failed",
  not_done: "Check not done",
  "not-applicable": "Not applicable",
  missing: "Not specified",
};

let registry = null;
let currentView = "matrix";

document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(window.location.search);
  LINK_CONTEXT.variable = params.get("variable") || params.get("short_name") || "";
  LINK_CONTEXT.experiment = params.get("experiment") || "";
  LINK_CONTEXT.detail_filter = params.get("filter") || "";
  LINK_CONTEXT.model = params.get("model") || "";
  LINK_CONTEXT.member = params.get("member") || "";

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentView = btn.dataset.view;
      renderView();
    });
  });

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
    `${registry.wcrp.length} WCRP statuses · ${registry.checks.length} layered checks · ` +
    `${registry.requirements.length} layered assignments · ${registry.variables.length} variables · ` +
    `${registry.experiments.length} experiments`;

  if (LINK_CONTEXT.variable) {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    document.querySelector('[data-view="variable"]').classList.add("active");
    currentView = "variable";
  }

  try {
    renderView();
  } catch (err) {
    document.getElementById("app").innerHTML =
      `<p style="color:var(--fail)">Dashboard render error: ${escHtml(err.message)}</p>`;
  }
});

function renderView() {
  const app = document.getElementById("app");
  app.innerHTML = "";
  if (currentView === "matrix") renderMatrix(app);
  if (currentView === "variable") renderVariableDetail(app, LINK_CONTEXT.variable, LINK_CONTEXT.detail_filter);
  if (currentView === "check") renderCheckCoverage(app);
  if (currentView === "proposals") renderProposals(app);
}

function variableCandidates(variable) {
  const candidates = [variable];
  const alias = registry?.variable_aliases?.[variable];
  if (alias && !candidates.includes(alias)) candidates.push(alias);
  return candidates;
}

function scopeList(scope) {
  return Array.isArray(scope) ? scope : [scope];
}

function renderScopeBadges(scope) {
  return scopeList(scope)
    .map((value) => `<span class="badge badge-${value === "global" ? "global" : "proposed"}">${value}</span>`)
    .join(" ");
}

function variableProposalUrl(variable) {
  const title = encodeURIComponent(`[requirement] ${variable} - <check_id>`);
  return `${GITHUB_NEW_ISSUE_URL}?title=${title}`;
}

function requirementClassLabel(requirement) {
  if (!requirement) return "not assigned";
  if (requirement.requirement_class === "required" && requirement.variable === "*" && requirement.experiment === "*") {
    return "required (global default)";
  }
  return requirement.requirement_class;
}

function valueMatches(field, target, candidates = [target]) {
  if (field === "*") return true;
  if (Array.isArray(field)) {
    return field.includes("*") || candidates.some((candidate) => field.includes(candidate));
  }
  return candidates.includes(field);
}

function effectiveWcrpStatus(variable) {
  const varNames = variableCandidates(variable);
  const matching = registry.wcrp.filter((entry) => valueMatches(entry.variable, variable, varNames));
  if (!matching.length) return { status: "not_done", entry: null };

  matching.sort((a, b) => {
    const aSpecific = a.variable === "*" || (Array.isArray(a.variable) && a.variable.includes("*")) ? 0 : 1;
    const bSpecific = b.variable === "*" || (Array.isArray(b.variable) && b.variable.includes("*")) ? 0 : 1;
    return aSpecific - bSpecific;
  });

  const best = matching[matching.length - 1];
  return { status: best.status, entry: best };
}

function effectiveRequirement(checkId, variable, experiment) {
  const reqs = registry.requirements.filter((r) => r.check === checkId);
  if (!reqs.length) return null;
  const varNames = variableCandidates(variable);

  function matches(req) {
    return valueMatches(req.variable, variable, varNames) && valueMatches(req.experiment, experiment);
  }

  function specificity(req) {
    const vSpec = req.variable === "*" || (Array.isArray(req.variable) && req.variable.includes("*")) ? 0 : 2;
    const eSpec = req.experiment === "*" || (Array.isArray(req.experiment) && req.experiment.includes("*")) ? 0 : 1;
    return vSpec + eSpec;
  }

  const matching = reqs.filter(matches);
  if (!matching.length) return null;

  matching.sort((a, b) => specificity(a) - specificity(b));
  return matching[matching.length - 1];
}

function effectiveResultStatus(checkId, variable, experiment) {
  const requirement = effectiveRequirement(checkId, variable, experiment);
  if (!requirement) return "missing";
  if (requirement.requirement_class === "not-applicable") return "not-applicable";
  return requirement.status || "not_done";
}

function aggregateResultStatuses(statuses) {
  const priority = ["fail", "not_done", "pass", "not-applicable", "missing"];
  const sorted = [...statuses].sort((a, b) => priority.indexOf(a) - priority.indexOf(b));
  return sorted[0] ?? "missing";
}

function checksByKind(kind) {
  return registry.checks.filter((check) => check.kind === kind);
}

function additionalCategoryStatus(variable, experiment, category) {
  const checks = checksByKind("additional").filter((check) => check.categories.includes(category));
  if (!checks.length) return "missing";
  const statuses = checks.map((check) =>
    experiment === "*"
      ? worstStatus(check.id, variable)
      : effectiveResultStatus(check.id, variable, experiment)
  );
  return aggregateResultStatuses(statuses);
}

function refCoverageStatus(variable, experiment) {
  const checks = checksByKind("ref");
  if (!checks.length) return "not-applicable";
  const statuses = checks.map((check) =>
    experiment === "*"
      ? worstStatus(check.id, variable)
      : effectiveResultStatus(check.id, variable, experiment)
  );
  if (statuses.every((status) => status === "missing")) return "not-applicable";
  return aggregateResultStatuses(statuses);
}

function worstStatus(checkId, variable) {
  const experiments = registry.experiments.length ? registry.experiments : ["*"];
  return aggregateResultStatuses(experiments.map((experiment) => effectiveResultStatus(checkId, variable, experiment)));
}

function addStatusCell(row, status, titlePrefix = "") {
  const cell = row.insertCell();
  cell.className = `cell-${status}`;
  cell.title = titlePrefix ? `${titlePrefix}: ${RESULT_TITLE[status] ?? status}` : (RESULT_TITLE[status] ?? status);
  cell.textContent = RESULT_LABELS[status] ?? "";
  return cell;
}

function openVariableDetail(variable, filter = "") {
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
  document.querySelector('[data-view="variable"]').classList.add("active");
  LINK_CONTEXT.variable = variable;
  LINK_CONTEXT.detail_filter = filter;
  currentView = "variable";
  renderVariableDetail(document.getElementById("app"), variable, filter);
}

function formatVariableOption(variable) {
  const realm = registry.realms?.[variable];
  const cmip7 = registry.cmip7_names?.[variable];
  if (realm && cmip7) return `${variable} [${realm}] - ${cmip7}`;
  if (realm) return `${variable} [${realm}]`;
  if (cmip7) return `${variable} - ${cmip7}`;
  return variable;
}

function renderMatrix(container) {
  const allExperiments = registry.experiments.length ? registry.experiments : ["(all)"];
  const allVariables = registry.variables.length ? registry.variables : [];
  const realms = [...new Set(Object.values(registry.realms))].sort();

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
    "Rows = variables. Columns separate the systematic WCRP outcome, additional check categories, and REF coverage.";

  const legend = makeLegend();
  const tableWrap = document.createElement("div");
  tableWrap.className = "matrix-scroll";

  container.appendChild(title);
  container.appendChild(subtitle);
  container.appendChild(controls);
  container.appendChild(legend);
  container.appendChild(tableWrap);

  function redraw() {
    const filtered = allVariables.filter((variable) => {
      if (varFilter && !variable.includes(varFilter)) return false;
      if (realmFilter && registry.realms[variable] !== realmFilter) return false;
      return true;
    });

    tableWrap.innerHTML = "";
    if (!filtered.length) {
      tableWrap.innerHTML = "<p style='color:var(--text-muted)'>No variables match the current filters.</p>";
      return;
    }

    tableWrap.appendChild(buildMatrixTable(filtered, expFilter));
  }

  controls.querySelector("#exp-select").addEventListener("change", (e) => {
    expFilter = e.target.value;
    redraw();
  });
  controls.querySelector("#realm-select").addEventListener("change", (e) => {
    realmFilter = e.target.value;
    redraw();
  });
  controls.querySelector("#var-filter").addEventListener("input", (e) => {
    varFilter = e.target.value.trim();
    redraw();
  });

  redraw();
}

function buildMatrixTable(variables, experiment) {
  const table = document.createElement("table");
  table.className = "matrix";

  const thead = table.createTHead();
  const headerRow = thead.insertRow();
  ["Variable", "Realm", "WCRP", "Additional / Spatial", "Additional / Temporal", "Additional / Data", "REF"].forEach((heading) => {
    headerRow.insertCell().outerHTML = `<th>${heading}</th>`;
  });

  const tbody = table.createTBody();
  for (const variable of variables) {
    const row = tbody.insertRow();
    const varCell = document.createElement("th");
    const cmip7 = registry.cmip7_names?.[variable];
    varCell.innerHTML =
      `<a href="#" class="var-link" data-var="${variable}">${variable}</a>` +
      (cmip7 ? `<div class="cell-subtext">${escHtml(cmip7)}</div>` : "");
    row.appendChild(varCell);

    const realmCell = row.insertCell();
    realmCell.textContent = registry.realms[variable] ?? "";
    realmCell.style.color = "var(--text-muted)";
    realmCell.style.fontSize = "0.78rem";

    const wcrp = effectiveWcrpStatus(variable);
    addStatusCell(row, wcrp.status, `WCRP / ${variable}`);

    ADDITIONAL_CATEGORIES.forEach((category) => {
      const status = additionalCategoryStatus(variable, experiment, category);
      const cell = addStatusCell(row, status, `Additional ${category} / ${variable} / ${experiment}`);
      cell.classList.add("cell-link");
      cell.addEventListener("click", () => openVariableDetail(variable, category));
    });

    const refStatus = refCoverageStatus(variable, experiment);
    const refCell = addStatusCell(row, refStatus, `REF / ${variable} / ${experiment}`);
    refCell.classList.add("cell-link");
    refCell.addEventListener("click", () => openVariableDetail(variable, "ref"));
  }

  table.querySelectorAll(".var-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      openVariableDetail(link.dataset.var);
    });
  });

  return table;
}

function makeLegend() {
  const items = [
    { cls: "cell-pass", label: "Pass" },
    { cls: "cell-fail", label: "Fail" },
    { cls: "cell-not_done", label: "Not done" },
    { cls: "cell-na", label: "Not applicable / not assigned" },
  ];
  const div = document.createElement("div");
  div.className = "matrix-legend";
  div.innerHTML = items.map((item) =>
    `<span class="legend-item"><span class="legend-swatch ${item.cls}"></span>${item.label}</span>`
  ).join("");
  return div;
}

function renderVariableDetail(container, preselected, preselectedFilter = "") {
  container.innerHTML = "";

  const allVariables = registry.variables;
  const allExperiments = registry.experiments.length ? registry.experiments : ["*"];
  const detailFilters = [
    { value: "", label: "All checks" },
    { value: "spatial", label: "Spatial" },
    { value: "temporal", label: "Temporal" },
    { value: "data", label: "Data" },
    { value: "ref", label: "REF" },
  ];
  let experimentFilter = LINK_CONTEXT.experiment && allExperiments.includes(LINK_CONTEXT.experiment)
    ? LINK_CONTEXT.experiment
    : "*";
  let checkFilter = preselectedFilter && detailFilters.some((option) => option.value === preselectedFilter)
    ? preselectedFilter
    : "";

  const title = document.createElement("div");
  title.className = "view-title";
  title.textContent = "Variable Detail";

  const controls = document.createElement("div");
  controls.className = "controls";
  controls.innerHTML = `
    <label for="var-select">Variable</label>
    <select id="var-select">
      <option value="">- select -</option>
      ${allVariables.map((variable) => `<option value="${variable}">${escHtml(formatVariableOption(variable))}</option>`).join("")}
    </select>
    <label for="exp-select">Experiment</label>
    <select id="exp-select">
      <option value="*">All experiments</option>
      ${allExperiments.map((experiment) => `<option value="${experiment}"${experiment === experimentFilter ? " selected" : ""}>${experiment}</option>`).join("")}
    </select>
    <label for="check-filter">Checks</label>
    <select id="check-filter">
      ${detailFilters.map((option) => `<option value="${option.value}"${option.value === checkFilter ? " selected" : ""}>${option.label}</option>`).join("")}
    </select>
  `;

  container.appendChild(title);
  container.appendChild(controls);

  const content = document.createElement("div");
  container.appendChild(content);

  function drawDetail(variable) {
    content.innerHTML = "";
    if (!variable) return;

    const detailExperiments = experimentFilter === "*" ? allExperiments : [experimentFilter];
    const wcrp = effectiveWcrpStatus(variable);
    const contextParts = [LINK_CONTEXT.model, experimentFilter !== "*" ? experimentFilter : "", LINK_CONTEXT.member].filter(Boolean);

    const subtitle = document.createElement("div");
    subtitle.className = "view-subtitle";
    subtitle.textContent =
      `${variable}` +
      (registry.realms[variable] ? ` (realm: ${registry.realms[variable]})` : "") +
      (contextParts.length ? ` · context: ${contextParts.join(" / ")}` : "");
    content.appendChild(subtitle);

    if (registry.cmip7_names?.[variable]) {
      const cmip7Meta = document.createElement("div");
      cmip7Meta.className = "view-subtitle";
      cmip7Meta.innerHTML = `CMIP7 name: <code>${escHtml(registry.cmip7_names[variable])}</code>`;
      content.appendChild(cmip7Meta);
    }

    const actions = document.createElement("div");
    actions.className = "detail-actions";
    actions.innerHTML = `
      <a class="action-btn" href="${variableProposalUrl(variable)}" target="_blank" rel="noopener">
        Submit check proposal
      </a>
    `;
    content.appendChild(actions);

    const summary = document.createElement("div");
    summary.className = "summary-grid";
    summary.innerHTML = `
      <div class="card">
        <h3>Systematic WCRP</h3>
        <div class="card-meta"><span class="badge badge-${wcrp.status}">${wcrp.status.replace("_", " ")}</span></div>
        <p>Single cc-plugin-wcrp outcome for this variable.</p>
        ${wcrp.entry?.notes ? `<p>${escHtml(wcrp.entry.notes)}</p>` : ""}
      </div>
      <div class="card">
        <h3>Additional checks</h3>
        <div class="card-meta">${checksByKind("additional").length} check definitions</div>
        <p>Proposal-based checks grouped into spatial, temporal, and data categories.</p>
      </div>
      <div class="card">
        <h3>REF</h3>
        <div class="card-meta">${checksByKind("ref").length} check definitions</div>
        <p>Rapid Evaluation Framework coverage is optional and only appears where assignments exist.</p>
      </div>
    `;
    content.appendChild(summary);

    if (checkFilter === "ref") {
      content.appendChild(buildLayerTable("REF checks", "ref", variable, detailExperiments));
      return;
    }

    content.appendChild(buildLayerTable("Additional checks", "additional", variable, detailExperiments, checkFilter));

    if (!checkFilter) {
      content.appendChild(buildLayerTable("REF checks", "ref", variable, detailExperiments));
    }
  }

  const select = controls.querySelector("#var-select");
  if (preselected) {
    select.value = preselected;
    drawDetail(preselected);
  }
  select.addEventListener("change", (e) => drawDetail(e.target.value));
  controls.querySelector("#exp-select").addEventListener("change", (e) => {
    experimentFilter = e.target.value;
    drawDetail(select.value);
  });
  controls.querySelector("#check-filter").addEventListener("change", (e) => {
    checkFilter = e.target.value;
    LINK_CONTEXT.detail_filter = checkFilter;
    drawDetail(select.value);
  });
}

function buildLayerTable(titleText, kind, variable, experiments, categoryFilter = "") {
  const wrapper = document.createElement("div");
  wrapper.className = "layer-section";

  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = titleText;
  wrapper.appendChild(title);

  const checks = checksByKind(kind).filter((check) => (
    kind !== "additional" || !categoryFilter || check.categories.includes(categoryFilter)
  ));
  if (!checks.length) {
    const note = document.createElement("p");
    note.className = "view-subtitle";
    note.textContent = "No check definitions available in this layer.";
    wrapper.appendChild(note);
    return wrapper;
  }

  const subtitle = document.createElement("div");
  subtitle.className = "view-subtitle";
  subtitle.textContent = `${checks.length} checks x ${experiments.length} experiment${experiments.length === 1 ? "" : "s"}`;
  wrapper.appendChild(subtitle);

  const table = document.createElement("table");
  table.className = "detail";
  const thead = table.createTHead();
  const headerRow = thead.insertRow();
  ["Check", "Categories", "Scope", ...experiments].forEach((heading) => {
    headerRow.insertCell().outerHTML = `<th>${heading}</th>`;
  });

  const tbody = table.createTBody();
  for (const check of checks) {
    const row = tbody.insertRow();

    const nameCell = row.insertCell();
    nameCell.innerHTML =
      `<code>${check.id}</code><br>` +
      `<span style="color:var(--text-muted);font-size:0.78rem">${escHtml(check.name)}</span>`;

    const categoriesCell = row.insertCell();
    categoriesCell.innerHTML = check.categories
      .map((category) => `<span class="badge badge-category">${category}</span>`)
      .join(" ");

    const scopeCell = row.insertCell();
    scopeCell.innerHTML = renderScopeBadges(check.scope);

    experiments.forEach((experiment) => {
      const requirement = effectiveRequirement(check.id, variable, experiment);
      const status = effectiveResultStatus(check.id, variable, experiment);
      const cell = addStatusCell(row, status);
      cell.title = `${check.id} / ${variable} / ${experiment}: ${RESULT_TITLE[status] ?? status}; requirement class: ${requirementClassLabel(requirement)}`;
    });
  }

  wrapper.appendChild(table);
  return wrapper;
}

function renderCheckCoverage(container) {
  container.innerHTML = "";

  const title = document.createElement("div");
  title.className = "view-title";
  title.textContent = "Layered Check Coverage";

  const controls = document.createElement("div");
  controls.className = "controls";
  controls.innerHTML = `
    <label for="kind-select">Layer</label>
    <select id="kind-select">
      <option value="additional">Additional</option>
      <option value="ref">REF</option>
    </select>
    <label for="check-select">Check</label>
    <select id="check-select" style="max-width:420px"></select>
  `;

  container.appendChild(title);
  container.appendChild(controls);

  const detailWrap = document.createElement("div");
  container.appendChild(detailWrap);

  const kindSelect = controls.querySelector("#kind-select");
  const checkSelect = controls.querySelector("#check-select");

  function populateChecks(kind) {
    const checks = checksByKind(kind);
    checkSelect.innerHTML =
      `<option value="">- select -</option>` +
      checks.map((check) => `<option value="${check.id}">${check.id}</option>`).join("");
  }

  function drawCoverage(checkId) {
    detailWrap.innerHTML = "";
    if (!checkId) return;

    const check = registry.checks.find((entry) => entry.id === checkId);
    if (!check) return;

    const card = document.createElement("div");
    card.className = "card";
    card.style.marginBottom = "1.25rem";
    card.innerHTML = `
      <h3>${escHtml(check.name)}</h3>
      <div class="card-meta">
        <code>${check.id}</code> &nbsp;·&nbsp;
        <span class="badge badge-${check.status}">${check.status}</span> &nbsp;·&nbsp;
        layer: <strong>${check.kind}</strong> &nbsp;·&nbsp;
        categories: <strong>${check.categories.join(", ")}</strong> &nbsp;·&nbsp;
        scope: <strong>${scopeList(check.scope).join(", ")}</strong> &nbsp;·&nbsp;
        severity: <strong>${check.severity}</strong>
        ${check.proposed_by ? `&nbsp;·&nbsp; proposed by <strong>${check.proposed_by}</strong>` : ""}
        ${check.issue ? `&nbsp;·&nbsp; <a href="https://github.com/${GITHUB_REPO}/issues/${check.issue}" target="_blank" rel="noopener">#${check.issue}</a>` : ""}
      </div>
      <p>${escHtml(check.description ?? "")}</p>
    `;
    detailWrap.appendChild(card);

    const allVariables = registry.variables.length ? registry.variables : [];
    const allExperiments = registry.experiments.length ? registry.experiments : ["*"];

    const subtitle = document.createElement("div");
    subtitle.className = "view-subtitle";
    subtitle.textContent = `Coverage across ${allVariables.length} variables x ${allExperiments.length} experiments`;
    detailWrap.appendChild(subtitle);

    const tableWrap = document.createElement("div");
    tableWrap.className = "matrix-scroll";
    const table = document.createElement("table");
    table.className = "matrix";

    const thead = table.createTHead();
    const headerRow = thead.insertRow();
    headerRow.insertCell().outerHTML = "<th>Variable</th>";
    allExperiments.forEach((experiment) => {
      headerRow.insertCell().outerHTML = `<th>${experiment}</th>`;
    });

    const tbody = table.createTBody();
    allVariables.forEach((variable) => {
      const row = tbody.insertRow();
      const variableCell = document.createElement("th");
      variableCell.style.fontFamily = "var(--mono)";
      variableCell.innerHTML =
        `${escHtml(variable)}` +
        (registry.cmip7_names?.[variable] ? `<div class="cell-subtext">${escHtml(registry.cmip7_names[variable])}</div>` : "");
      row.appendChild(variableCell);

      allExperiments.forEach((experiment) => {
        const requirement = effectiveRequirement(checkId, variable, experiment);
        const status = effectiveResultStatus(checkId, variable, experiment);
        const cell = addStatusCell(row, status);
        cell.title = `${checkId} / ${variable} / ${experiment}: ${RESULT_TITLE[status] ?? status}; requirement class: ${requirementClassLabel(requirement)}`;
      });
    });

    tableWrap.appendChild(table);
    detailWrap.appendChild(tableWrap);
  }

  populateChecks(kindSelect.value);
  kindSelect.addEventListener("change", (e) => {
    populateChecks(e.target.value);
    detailWrap.innerHTML = "";
  });
  checkSelect.addEventListener("change", (e) => drawCoverage(e.target.value));
}

function renderProposals(container) {
  container.innerHTML = "";

  const title = document.createElement("div");
  title.className = "view-title";
  title.textContent = "Open Proposals";

  const subtitle = document.createElement("div");
  subtitle.className = "view-subtitle";
  subtitle.innerHTML = `Issues labelled <code>status/proposed</code> on GitHub. Use these for additional or REF check proposals and assignment requests.`;

  container.appendChild(title);
  container.appendChild(subtitle);

  const listEl = document.createElement("div");
  listEl.className = "proposal-list";
  listEl.textContent = "Loading issues from GitHub...";
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
          `<p style="color:var(--text-muted)">No open proposals right now - ` +
          `<a href="https://github.com/${GITHUB_REPO}/issues/new/choose" target="_blank" rel="noopener">open one</a>.</p>`;
        return;
      }

      issues.forEach((issue) => {
        const item = document.createElement("div");
        item.className = "proposal-item";

        const labelsHtml = issue.labels
          .map((label) => `<span class="gh-label" style="background:#${label.color}22;color:#${label.color};border:1px solid #${label.color}44">${label.name}</span>`)
          .join("");

        item.innerHTML = `
          <span class="issue-num">#${issue.number}</span>
          <div>
            <h4><a href="${issue.html_url}" target="_blank" rel="noopener">${escHtml(issue.title)}</a></h4>
            <div class="proposal-labels">${labelsHtml}</div>
            ${issue.body ? `<p class="proposal-note">${escHtml(issue.body.slice(0, 200))}${issue.body.length > 200 ? "..." : ""}</p>` : ""}
          </div>
        `;
        listEl.appendChild(item);
      });
    })
    .catch((err) => {
      listEl.innerHTML =
        `<p style="color:var(--text-muted)">Could not load issues from GitHub: ${err.message}.<br>` +
        `<a href="https://github.com/${GITHUB_REPO}/issues?q=is%3Aopen+label%3Astatus%2Fproposed" target="_blank" rel="noopener">View on GitHub directly -></a></p>`;
    });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
