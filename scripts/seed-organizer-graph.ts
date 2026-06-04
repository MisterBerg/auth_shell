type ScopeInput = {
  id: string;
  title: string;
  scope: string;
  status: "open" | "active" | "blocked" | "done" | "archived";
  parentScopeId?: string;
  subjects: string[];
  notes: string;
  tags: string[];
  targetAt?: string;
};

type ItemInput = {
  id: string;
  kind: "note" | "todo" | "follow-up" | "waiting-on" | "idea" | "reminder";
  title: string;
  details: string;
  status: "open" | "active" | "done" | "archived";
  tags: string[];
  dueAt?: string;
  followUpAt?: string;
  scopeIds: string[];
};

type PlanEntry = {
  kind: ItemInput["kind"];
  title: string;
  status: ItemInput["status"];
  scopeIds: string[];
  tags: string[];
  due?: string;
  follow?: string;
  history: string;
  next: string;
  risk: string;
};

type PlanRow = [
  PlanEntry["kind"],
  string,
  PlanEntry["status"],
  string[],
  string[],
  string | undefined,
  string | undefined,
  string,
  string,
  string,
];

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? true];
  }),
);

const url = String(args["url"] ?? process.env["AGENT_BRIDGE_URL"] ?? "http://127.0.0.1:4317").replace(/\/$/, "");
const token = String(args["token"] ?? process.env["AGENT_BRIDGE_TOKEN"] ?? "");
const sessionId = typeof args["sessionId"] === "string" ? args["sessionId"] : undefined;

if (!token) {
  throw new Error("Bridge token is required. Pass --token=... or set AGENT_BRIDGE_TOKEN.");
}

const scopes: ScopeInput[] = [
  {
    id: "scope-hw-validation",
    title: "Hardware Validation Program",
    scope: "Own the validation story from document intake through final safety, thermal, vendor, and sign-off evidence.",
    status: "active",
    subjects: ["schedule", "safety", "thermal", "vendor", "reporting"],
    notes: "This is the top-level graph node for the dense organizer usability dataset. It intentionally has active, blocked, reminder, and done history linked underneath it.",
    tags: ["hardware-validation"],
    targetAt: "2026-07-31T04:00:00.000Z",
  },
  {
    id: "scope-doc-control",
    parentScopeId: "scope-hw-validation",
    title: "Documentation Control",
    scope: "Collect and review source material needed to defend validation decisions before test execution and final report release.",
    status: "active",
    subjects: ["vendor packet", "datasheets", "requirements", "revision control"],
    notes: "Document gaps should be visible early because they change acceptance criteria and can force retest.",
    tags: ["docs"],
    targetAt: "2026-06-18T04:00:00.000Z",
  },
  {
    id: "scope-regulator-evidence",
    parentScopeId: "scope-doc-control",
    title: "Regulator Evidence",
    scope: "Gather absolute maximum ratings, failure-mode notes, current-limit behavior, and thermal shutdown behavior for the 5 V buck and 3.3 V regulator.",
    status: "active",
    subjects: ["5v buck", "3.3v regulator", "thermal shutdown", "reverse current"],
    notes: "This node is intentionally shared by documentation and fire-hazard reasoning.",
    tags: ["regulator", "datasheet"],
  },
  {
    id: "scope-test-execution",
    parentScopeId: "scope-hw-validation",
    title: "Validation Test Execution",
    scope: "Plan, prepare, run, and review validation tests while preserving evidence quality.",
    status: "active",
    subjects: ["bench setup", "fire hazard", "thermal soak", "functional check"],
    notes: "Execution nodes should let the agent move from broad schedule concerns into specific test run readiness.",
    tags: ["test"],
    targetAt: "2026-07-10T04:00:00.000Z",
  },
  {
    id: "scope-fire-hazard",
    parentScopeId: "scope-test-execution",
    title: "Fire Hazard Investigation",
    scope: "Evaluate whether abnormal short conditions in the power tree create smoke, flame, propagation, or unacceptable thermal damage.",
    status: "active",
    subjects: ["short test", "power tree", "smoke criteria", "sample history"],
    notes: "The main scenario is a 12 V input, filtered 5 V buck, 3.3 V regulator, and zener clamp to ground.",
    tags: ["safety", "fire"],
    targetAt: "2026-06-28T04:00:00.000Z",
  },
  {
    id: "scope-zener-short-path",
    parentScopeId: "scope-fire-hazard",
    title: "3.3 V Zener Short Path",
    scope: "Characterize current flow through the 3.3 V regulator into the zener clamp when the zener path is shorted to ground.",
    status: "active",
    subjects: ["zener", "short path", "current flow", "smoke"],
    notes: "This depth-four node should be a useful middle point for graph search and sweep context expansion.",
    tags: ["zener", "short"],
  },
  {
    id: "scope-bench-runbook",
    parentScopeId: "scope-zener-short-path",
    title: "Bench Runbook and Evidence Capture",
    scope: "Define the exact bench sequence, setup photographs, thermal camera placement, current-limit values, and stopping criteria.",
    status: "open",
    subjects: ["runbook", "thermal camera", "waveform", "photos"],
    notes: "This is a depth-five node and the deepest branch in the dataset.",
    tags: ["bench", "procedure"],
  },
  {
    id: "scope-thermal-soak",
    parentScopeId: "scope-test-execution",
    title: "Thermal Soak Validation",
    scope: "Confirm thermal margin during expected operation using defensible load cases and enclosure assumptions.",
    status: "open",
    subjects: ["thermal chamber", "load profile", "ambient", "enclosure"],
    notes: "This branch shares sample planning and fixture readiness risks with fire-hazard testing.",
    tags: ["thermal"],
    targetAt: "2026-07-03T04:00:00.000Z",
  },
  {
    id: "scope-fixture-readiness",
    parentScopeId: "scope-test-execution",
    title: "Fixture Readiness",
    scope: "Make sure harnesses, load banks, current limits, thermocouples, and calibration notes are ready before formal runs.",
    status: "blocked",
    subjects: ["harness", "load bank", "connector", "calibration"],
    notes: "Connector procurement and harness checks are the current blockers.",
    tags: ["fixture"],
    targetAt: "2026-06-20T04:00:00.000Z",
  },
  {
    id: "scope-vendor-tests",
    parentScopeId: "scope-test-execution",
    title: "Vendor Outsourced Tests",
    scope: "Coordinate lab quote, sample shipment, outsourced execution, and review of vendor-generated evidence.",
    status: "blocked",
    subjects: ["quote", "shipping", "lab capacity", "raw data"],
    notes: "The branch is blocked until the vendor gives quote timing and sample-handling instructions.",
    tags: ["vendor", "lab"],
    targetAt: "2026-06-24T04:00:00.000Z",
  },
  {
    id: "scope-reporting",
    parentScopeId: "scope-hw-validation",
    title: "Evidence Report and Sign-off",
    scope: "Assemble the final validation evidence, identify deviations, and drive stakeholder approval.",
    status: "open",
    subjects: ["report", "deviations", "approval", "open issues"],
    notes: "The report should accumulate evidence during testing rather than being reconstructed at the end.",
    tags: ["report"],
    targetAt: "2026-07-24T04:00:00.000Z",
  },
  {
    id: "scope-signoff-review",
    parentScopeId: "scope-reporting",
    title: "Final Sign-off Review",
    scope: "Resolve open evidence questions, classify deviations, and prepare final stakeholder approval notes.",
    status: "open",
    subjects: ["approval owners", "risk disposition", "retest triggers"],
    notes: "Use this branch to test late-stage follow-ups and done-history filtering.",
    tags: ["approval"],
  },
];

const planRows: PlanRow[] = [
  ["todo", "Request missing vendor safety packet", "open", ["scope-doc-control"], ["vendor", "docs"], "2026-06-10", undefined, "The May 29 vendor email included a schematic excerpt but not the formal safety packet.", "Ask for the signed safety report, derating statement, and prior enclosure assessment.", "Without this packet the report cannot defend abnormal-operation assumptions."],
  ["waiting-on", "Waiting for outsourced lab quote", "active", ["scope-vendor-tests"], ["vendor", "lab"], undefined, "2026-06-07", "The quote was requested after the May 31 planning call and the vendor promised schedule feedback.", "Follow up for quote, earliest start date, sample handling, and whether they can run the zener short case.", "If the quote slips another week, in-house bench work must carry more evidence burden."],
  ["note", "Power tree short-test interpretation", "active", ["scope-fire-hazard", "scope-zener-short-path"], ["safety", "power-tree"], undefined, undefined, "The intended short path is through the 3.3 V regulator into the zener clamp to ground.", "Use this as the interpretation anchor when reviewing diagrams, test steps, and smoke observations.", "A misleading diagram could cause the test to validate the wrong failure path."],
  ["todo", "Define current-limit ladder for bench run", "open", ["scope-bench-runbook"], ["bench", "procedure"], "2026-06-12", undefined, "Informal work used a current limit but did not record why it was selected.", "Define start value, increment size, max value, dwell time, and stop condition.", "Unjustified current limits make successful no-smoke observations weak evidence."],
  ["reminder", "Send sample serial numbers to vendor", "open", ["scope-vendor-tests"], ["email", "vendor"], "2026-06-06", "2026-06-06", "The vendor asked which samples are available for destructive and non-destructive testing.", "Send sample IDs, configuration notes, and whether each unit may be destroyed.", "A vague sample assignment could consume the cleaner thermal unit in destructive testing."],
  ["todo", "Extract 5 V buck absolute maximum ratings", "active", ["scope-regulator-evidence"], ["datasheet", "5v"], "2026-06-13", undefined, "The datasheet review started but only covered nominal ratings.", "Capture abs-max limits for VIN, SW, enable, feedback, and thermal shutdown.", "The short test may stress pins outside the normal operating table."],
  ["todo", "Find 3.3 V regulator reverse-current note", "open", ["scope-regulator-evidence", "scope-zener-short-path"], ["datasheet", "3.3v"], "2026-06-14", undefined, "The zener scenario may force the regulator output in a non-normal direction.", "Search datasheet and app notes for reverse current and forced-output behavior.", "If the behavior is undocumented, the acceptance criteria need more conservative wording."],
  ["note", "Informal bench run at 1.2 A", "active", ["scope-bench-runbook"], ["history", "bench"], undefined, undefined, "A previous informal run at 1.2 A caused fast local heating but no smoke during a short window.", "Treat it as planning history only; do not cite it as formal evidence unless repeated.", "The setup had no thermal camera record and no complete sample history."],
  ["follow-up", "Ask mechanical for enclosure resin rating", "open", ["scope-doc-control", "scope-signoff-review"], ["mechanical", "enclosure"], undefined, "2026-06-09", "Mechanical mentioned an existing material rating but did not provide the exact grade.", "Ask for resin grade, UL card if available, and confirmation of production-equivalent enclosure stack.", "If enclosure material differs, sign-off assumptions may not apply."],
  ["todo", "Photograph thermal camera setup", "open", ["scope-bench-runbook", "scope-thermal-soak"], ["thermal", "evidence"], "2026-06-16", undefined, "Earlier test records did not preserve camera distance or viewing angle.", "Capture camera placement, board orientation, focus distance, emissivity setting, and ambient context.", "Thermal images without setup context are hard to compare or repeat."],
  ["todo", "Write harness continuity check", "open", ["scope-fixture-readiness"], ["fixture", "harness"], "2026-06-15", undefined, "A crimp issue was discovered during fixture prep.", "Define checks for input, 5 V rail, 3.3 V rail, zener node, and ground before power application.", "A bad harness could create a false failure or mask the intended short path."],
  ["reminder", "Call lab about destructive-test label", "open", ["scope-vendor-tests"], ["call", "shipping"], "2026-06-11", "2026-06-11", "The lab may require special receiving instructions for destructive testing.", "Call before shipment and ask about labels, disposal instructions, and contact phone number.", "A rejected shipment could erase the planned outsourced test window."],
  ["note", "Vendor report review checklist", "open", ["scope-vendor-tests", "scope-reporting"], ["vendor", "report"], undefined, undefined, "Past vendor reports have summarized pass/fail while omitting raw setup details.", "Check for voltage, current limit, ambient, load state, sample ID, and exact fault insertion method.", "Missing raw details should become a deviation or follow-up before report acceptance."],
  ["todo", "Draft smoke acceptance criteria", "active", ["scope-fire-hazard"], ["criteria", "safety"], "2026-06-17", undefined, "The team has discussed no-smoke expectations but has not written the pass/fail rule.", "Define flame, sustained smoke, propagation, power-removal behavior, and acceptable local damage.", "Ambiguous criteria can turn a real observation into a debate during sign-off."],
  ["todo", "Review 12 V input filter ratings", "open", ["scope-doc-control"], ["input", "filter"], "2026-06-19", undefined, "The focus has been downstream of the 5 V regulator, but the input filter may see abnormal current.", "Check capacitor voltage rating, ferrite/choke current rating, and inrush path limits.", "A downstream short could expose an upstream component weakness not captured in the current plan."],
  ["idea", "Report diagram overlay for current flow", "open", ["scope-fire-hazard", "scope-reporting"], ["diagram", "report"], undefined, undefined, "The reusable diagram format can represent the same power tree with different overlays.", "Use one overlay for normal current and one for short-test current through the zener clamp.", "This may make review faster than burying the concept in prose."],
  ["follow-up", "Ask firmware owner about diagnostic mode", "open", ["scope-thermal-soak"], ["firmware", "thermal"], undefined, "2026-06-10", "Firmware mentioned a mode that keeps switching quiet and load stable.", "Confirm whether it is acceptable for thermal soak or whether normal firmware is required.", "The wrong mode could make the thermal result irrelevant to real operation."],
  ["todo", "Document thermal load profile", "open", ["scope-thermal-soak"], ["thermal", "load"], "2026-06-21", undefined, "The current load case is based on an informal estimate.", "Record nominal, peak, and idle rail loads and decide which case represents validation.", "A weak load definition invites retest if the product later runs hotter."],
  ["note", "Validation is not redesign", "active", ["scope-hw-validation"], ["scope", "risk"], undefined, undefined, "If the zener path overheats, the first question is evidence disposition, not immediate redesign.", "Capture design-change thoughts separately so validation work remains decision-focused.", "Mixing validation and redesign can hide schedule impact."],
  ["todo", "Create report outline with placeholders", "open", ["scope-reporting"], ["report"], "2026-06-20", undefined, "The report will need evidence from several branches that are not complete yet.", "Create placeholders for setup diagrams, procedures, raw observations, deviations, and sign-off.", "Without placeholders, missing evidence may not be discovered until final review."],
] ;

const plan: PlanEntry[] = planRows.map(([kind, title, status, scopeIds, tags, due, follow, history, next, risk]) => ({ kind, title, status, scopeIds, tags, due, follow, history, next, risk }));

while (plan.length < 50) {
  const n = plan.length + 1;
  const scopeIds = n % 5 === 0 ? ["scope-signoff-review"] : n % 4 === 0 ? ["scope-fixture-readiness"] : n % 3 === 0 ? ["scope-thermal-soak"] : n % 2 === 0 ? ["scope-vendor-tests"] : ["scope-bench-runbook"];
  const kind = n % 9 === 0 ? "reminder" : n % 7 === 0 ? "waiting-on" : n % 5 === 0 ? "follow-up" : n % 4 === 0 ? "note" : "todo";
  plan.push({
    kind,
    title: `${kind === "reminder" ? "Reminder" : kind === "note" ? "Context note" : "Action item"} ${n}: ${scopeIds[0].replace("scope-", "").replaceAll("-", " ")}`,
    status: n % 11 === 0 ? "done" : n % 7 === 0 ? "active" : "open",
    scopeIds,
    tags: ["dense-seed", scopeIds[0].replace("scope-", "")],
    due: kind === "note" ? undefined : `2026-06-${String(5 + (n % 24)).padStart(2, "0")}`,
    follow: kind === "follow-up" || kind === "waiting-on" || kind === "reminder" ? `2026-06-${String(5 + (n % 20)).padStart(2, "0")}` : undefined,
    history: `This item was generated to simulate realistic accumulated project memory in the ${scopeIds[0]} branch. It represents material that might come from an email thread, meeting note, bench observation, or document review.`,
    next: "The next useful action is intentionally concrete so the sweep can decide whether it belongs in a quick checklist, a blocked/stale section, or a broader situation readout.",
    risk: "If ignored, the item may either block a downstream scope, create ambiguous evidence, or cause the agent to miss context when answering a narrow question.",
  });
}

const items: ItemInput[] = plan.slice(0, 50).map((entry, index) => ({
  id: `org-dense-${String(index + 1).padStart(2, "0")}`,
  kind: entry.kind,
  title: entry.title,
  status: entry.status,
  tags: entry.tags,
  dueAt: entry.due ? `${entry.due}T04:00:00.000Z` : undefined,
  followUpAt: entry.follow ? `${entry.follow}T13:00:00.000Z` : undefined,
  scopeIds: entry.scopeIds,
  details: [
    `History: ${entry.history}`,
    `Current understanding: ${entry.next}`,
    `Risk or decision pressure: ${entry.risk}`,
    "Agent usability note: this record is intentionally verbose enough to test scanning, search, click-through details, and whether organizer sweeps can synthesize context rather than only list tasks.",
  ].join("\n\n"),
}));

void main();

async function main() {
  const params = {
    ...(sessionId ? { sessionId } : {}),
    scopes,
    items,
    timeoutMs: 120000,
  };

  try {
    await rpc("replace_organizer_store", params);
  } catch (error) {
    if (!String((error as Error).message).includes("Unsupported RPC method")) {
      throw error;
    }
    const queued = await rpc("queue_appspace_operation", {
      ...(sessionId ? { sessionId } : {}),
      operation: "replace_organizer_store",
      args: { scopes, items },
    }) as { operationId?: string; sessionId?: string };
    if (!queued.operationId) {
      throw new Error("Bridge did not return an operationId for queued organizer replacement.");
    }
    await waitForQueuedOperation(queued.sessionId ?? sessionId, queued.operationId);
  }

  console.log(`Queued dense organizer graph through ${url}: ${scopes.length} scopes, ${items.length} items.`);
}

async function waitForQueuedOperation(queuedSessionId: string | undefined, operationId: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 120000) {
    const result = await rpc("list_appspace_operations", {
      ...(queuedSessionId ? { sessionId: queuedSessionId } : {}),
      limit: 100,
    }) as { operations?: Array<{ id: string; status: string; error?: string }> };
    const operation = result.operations?.find((entry) => entry.id === operationId);
    if (operation?.status === "completed") return;
    if (operation?.status === "failed") {
      throw new Error(operation.error ?? `Queued organizer replacement failed: ${operationId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for queued organizer replacement: ${operationId}`);
}

async function rpc(method: string, params: Record<string, unknown>) {
  const response = await fetch(`${url}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ method, params }),
  });
  const payload = await response.json() as { ok?: boolean; result?: unknown; error?: string };
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error ?? `Bridge RPC failed: ${response.status}`);
  }
  return payload.result;
}
