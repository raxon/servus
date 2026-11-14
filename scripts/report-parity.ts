import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type JsonObject = Record<string, unknown>;
type State = "passed" | "failed" | "pending";
interface Observation {
  actionStatus: string | null;
  httpHealthStatus: number | null;
  oldRuntimePreserved: boolean | null;
}
interface Check {
  id: string;
  status: string;
  observation?: Observation;
}
interface Suite {
  file: string;
  target: string;
  phase: string;
  checkedAt: string | null;
  status: State;
  meaning: "assertions" | "observations";
  checks: Check[];
  passed: number;
  failed: number;
  pending: number;
  expected: number | null;
  missingChecks: string[];
  notes: string[];
  image?: string;
  executedAfterVmRestart?: boolean;
}

const expectedChecks: Record<string, string[]> = {
  panel: [
    "project-create",
    "postgres-create",
    "redis-create",
    "mariadb-create",
    "git-build-and-http",
    "postgres-redis-and-volume-write",
    "configured-resources-and-file-mount",
    "runtime-log-marker",
    "stop-start-restart-and-persistence",
    "saved-env-and-deployed-env",
    "git-v2-and-data-preserved",
    "wordpress-deploy",
    "wordpress-initialize-and-http-content",
    "wordpress-container-replacement-retains-content",
  ],
  advanced: [
    "idempotency-and-revision-conflicts",
    "real-console-command-and-resize",
    "live-log-stream",
    "secrets-excluded-from-config-jobs-journal-and-logs",
    "missing-image-preserves-previous-runtime",
    "missing-repository-preserves-previous-runtime",
    "broken-build-preserves-previous-runtime",
    "unhealthy-release-preserves-previous-runtime",
    "wrong-http-port-preserves-previous-runtime",
    "wrong-database-password-rolls-back-application",
    "interrupted-worker-recovers-same-deployment",
    "interrupted-agent-recovers-same-deployment",
    "project-edit-keeps-runtime-and-nonempty-delete-is-rejected",
    "delete-removes-service-routes-and-preserves-volume-and-audit",
  ],
  access: [
    "anonymous-access-denied",
    "nonmember-project-service-and-log-access-denied",
    "viewer-can-read-but-cannot-mutate-reveal-or-open-console",
    "logout-revokes-the-real-session",
  ],
  "panel-restart": [
    "pre-restart-fixtures-ready",
    "dedicated-vm-stop-start",
    "application-databases-domains-and-files-after-restart",
    "wordpress-post-media-and-authentication-after-restart",
    "control-plane-project-and-session-after-restart",
  ],
  storage: [
    "reference-bind-marker-persists-through-api-restart",
    "reference-bind-fixture-removed-through-api",
    "panel-readonly-bind-marker-persists-through-api-restart",
    "panel-bind-symlink-escape-rejected-before-runtime-creation",
    "panel-two-real-replicas-retained-across-stop-start",
    "panel-disposable-storage-fixtures-removed-through-api",
  ],
};
const requiredFiles = [
  "panel.json",
  "advanced.json",
  "access.json",
  "panel-restart.json",
  "panel-after-restart.json",
  "advanced-after-restart.json",
  "access-after-restart.json",
  "storage.json",
];
expectedChecks.reference = expectedChecks.panel!;
expectedChecks["reference-restart"] = expectedChecks["panel-restart"]!;
expectedChecks["reference-advanced"] = [
  "baseline-healthy-and-persistent",
  "missing-image",
  "invalid-repository",
  "broken-git-build",
  "unhealthy-release",
  "wrong-database-password",
  "wrong-http-port",
];
expectedChecks["reference-recovery"] = [
  "operator-restores-completed-wordpress-and-existing-nginx-demo",
  "wordpress-content-media-and-account-survived-despite-stopped-process",
];
const excludedScope = [
  "Automatic public application HTTPS",
  "Private Git authentication",
  "Compose workload imports",
  "Backups and restore workflows",
  "Templates",
  "Multi-node management",
  "Database credential rotation",
  "Database engine upgrade migrations",
];

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}
function identifier(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,159}$/.test(value)
    ? value
    : fallback;
}
function imageReference(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9./:_@-]{0,299}$/.test(value)
    ? value
    : undefined;
}
function timestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}
function readJson(path: string): {
  value: JsonObject;
  exists: boolean;
  valid: boolean;
} {
  if (!existsSync(path)) return { value: {}, exists: false, valid: false };
  try {
    return {
      value: object(JSON.parse(readFileSync(path, "utf8"))),
      exists: true,
      valid: true,
    };
  } catch {
    return { value: {}, exists: true, valid: false };
  }
}
function stateFor(states: State[]): State {
  return states.includes("failed")
    ? "failed"
    : states.includes("pending")
      ? "pending"
      : "passed";
}
function loadSuite(directory: string, file: string, runId: string): Suite {
  const { value, exists, valid } = readJson(resolve(directory, file));
  const base = file.replace(/(?:-after-restart)?\.json$/, "");
  const phase = file.endsWith("-after-restart.json")
    ? "after-restart"
    : "initial";
  const expectation = expectedChecks[base];
  const notes: string[] = [];
  const checks: Check[] = Array.isArray(value.checks)
    ? value.checks.map((entry, index) => {
        const check = object(entry);
        const raw = object(object(check.detail).observation);
        const observation: Observation | undefined = Object.keys(raw).length
          ? {
              actionStatus:
                typeof raw.actionStatus === "string" &&
                /^[a-zA-Z-]{1,30}$/.test(raw.actionStatus)
                  ? raw.actionStatus
                  : null,
              httpHealthStatus: integer(raw.httpHealthStatus),
              oldRuntimePreserved:
                typeof raw.oldRuntimePreserved === "boolean"
                  ? raw.oldRuntimePreserved
                  : null,
            }
          : undefined;
        return {
          id: identifier(check.id, `unknown-check-${index + 1}`),
          status: ["passed", "failed", "pending", "skipped"].includes(
            String(check.status),
          )
            ? String(check.status)
            : "pending",
          ...(observation ? { observation } : {}),
        };
      })
    : [];
  const missingChecks =
    expectation?.filter((id) => !checks.some((check) => check.id === id)) ?? [];
  const passed = checks.filter((check) => check.status === "passed").length;
  const failed = checks.filter((check) => check.status === "failed").length;
  const pending = checks.length - passed - failed;
  if (!exists) notes.push("Report not present.");
  else if (!valid) notes.push("Report is not valid JSON.");
  if (exists && value.runId !== runId)
    notes.push("Run identifier does not match this report directory.");
  if (exists && !Array.isArray(value.checks))
    notes.push("Check list is missing.");
  if (base === "storage" && value.executedAfterVmRestart !== true)
    notes.push(
      "Storage execution after the VM restart has not been confirmed.",
    );
  if (new Set(checks.map((check) => check.id)).size !== checks.length)
    notes.push("Duplicate check identifiers.");
  if (integer(value.passed) !== null && value.passed !== passed)
    notes.push("Declared pass count differs from check records.");
  if (integer(value.failed) !== null && value.failed !== failed)
    notes.push("Declared failure count differs from check records.");
  const status: State = failed
    ? "failed"
    : notes.length || !checks.length || pending || missingChecks.length
      ? "pending"
      : "passed";
  return {
    file,
    target: identifier(value.target, base),
    phase,
    checkedAt: timestamp(value.checkedAt),
    status,
    meaning: base === "reference-advanced" ? "observations" : "assertions",
    checks,
    passed,
    failed,
    pending,
    expected: expectation?.length ?? null,
    missingChecks,
    notes,
    ...(base === "storage"
      ? { executedAfterVmRestart: value.executedAfterVmRestart === true }
      : {}),
    ...(imageReference(value.image)
      ? { image: imageReference(value.image) }
      : {}),
  };
}

function loadUnit(projectRoot: string) {
  const input = readJson(resolve(projectRoot, "artifacts/unit-tests.json"));
  const value = input.value;
  const total = integer(value.numTotalTests),
    passed = integer(value.numPassedTests),
    failed = integer(value.numFailedTests);
  const pending = integer(value.numPendingTests),
    todo = integer(value.numTodoTests);
  const totalSuites = integer(value.numTotalTestSuites),
    passedSuites = integer(value.numPassedTestSuites),
    failedSuites = integer(value.numFailedTestSuites),
    pendingSuites = integer(value.numPendingTestSuites);
  const complete =
    input.valid &&
    total !== null &&
    total > 0 &&
    passed !== null &&
    failed !== null &&
    pending !== null &&
    todo !== null &&
    totalSuites !== null &&
    totalSuites > 0 &&
    passedSuites !== null &&
    failedSuites !== null &&
    pendingSuites !== null;
  const status: State =
    (failed !== null && failed > 0) ||
    (failedSuites !== null && failedSuites > 0) ||
    value.success === false
      ? "failed"
      : complete &&
          value.success === true &&
          passed === total &&
          failed === 0 &&
          pending === 0 &&
          todo === 0 &&
          passedSuites === totalSuites &&
          failedSuites === 0 &&
          pendingSuites === 0
        ? "passed"
        : "pending";
  return {
    file: "../../unit-tests.json",
    status,
    total,
    passed,
    failed,
    pending,
    todo,
    totalSuites,
    passedSuites,
    failedSuites,
    pendingSuites,
    recorded: input.exists,
    checkedAt:
      typeof value.startTime === "number" && Number.isFinite(value.startTime)
        ? new Date(value.startTime).toISOString()
        : null,
  };
}

function loadPackage(projectRoot: string) {
  const input = readJson(
    resolve(projectRoot, "artifacts/package-verification.json"),
  );
  const value = input.value,
    application = object(value.application),
    builder = object(value.sourceBuilder),
    containers = object(value.containers),
    image = object(value.image),
    cleanup = object(value.cleanup);
  const checks: { name: string; status: State }[] = [];
  const expect = (name: string, actual: unknown, expected: unknown) => {
    checks.push({
      name,
      status:
        actual === undefined
          ? "pending"
          : actual === expected
            ? "passed"
            : "failed",
    });
  };
  expect("Package verification completed", value.status, "passed");
  expect("Management API health", application.health, "ok");
  for (const key of [
    "freshSetup",
    "login",
    "logoutRevokedSession",
    "runtimeOnline",
    "realDeployment",
    "encryptedAgentSnapshot",
    "plainSecretAbsentFromServiceConfig",
    "destroyConverged",
    "hostPortHealth",
  ]) {
    expect(`Application: ${key}`, application[key], true);
  }
  expect(
    "Revoked session cookie rejected",
    application.revokedCookieReplayStatus,
    401,
  );
  expect("Secret file mode", application.secretFileModes, "0600");
  for (const name of ["api", "worker", "agent"]) {
    const container = object(containers[name]);
    expect(`${name}: unprivileged UID`, container.uid, 1000);
    expect(`${name}: unprivileged GID`, container.gid, 1000);
    expect(`${name}: Linux named volume`, container.linuxNamedVolume, true);
    expect(
      `${name}: Docker socket mount ${name === "agent" ? "present" : "absent"}`,
      container.dockerSocketMounted,
      name === "agent",
    );
  }
  const agentGroups = object(containers.agent).groups;
  expect(
    "Agent: test daemon socket group 991",
    Array.isArray(agentGroups) ? agentGroups.includes(991) : undefined,
    true,
  );
  for (const key of [
    "realGitClone",
    "realBuildKitBuild",
    "sourceCommitPinned",
    "imageCommitLabelMatches",
  ]) {
    expect(`Source builder: ${key}`, builder[key], true);
  }
  for (const key of [
    "fixtureContainersRemoved",
    "fixtureVolumeRemoved",
    "sourceBuildImageRemoved",
    "finalImageRetained",
  ]) {
    expect(`Cleanup: ${key}`, cleanup[key], true);
  }
  expect("Package image OS", image.os, "linux");
  const imageId = imageReference(image.id ?? value.imageId ?? value.imageID);
  expect(
    "Package image identifier recorded",
    imageId ? true : image.id === undefined ? undefined : false,
    true,
  );
  const commit =
    typeof builder.sourceCommit === "string" &&
    /^[a-f0-9]{40,64}$/.test(builder.sourceCommit)
      ? builder.sourceCommit
      : null;
  expect(
    "Built source commit recorded",
    commit ? true : builder.sourceCommit === undefined ? undefined : false,
    true,
  );
  return {
    file: "../../package-verification.json",
    recorded: input.exists,
    status: stateFor(checks.map((check) => check.status)),
    checks,
    checkedAt: timestamp(value.finishedAt ?? value.checkedAt),
    engineVersion:
      typeof application.engineVersion === "string" &&
      /^[0-9a-zA-Z.+-]{1,80}$/.test(application.engineVersion)
        ? application.engineVersion
        : null,
    apiUid: integer(object(containers.api).uid),
    imageId: imageId ?? null,
    imageTag: imageReference(image.tag) ?? null,
    architecture:
      typeof image.architecture === "string" &&
      /^[a-z0-9]{1,20}$/.test(image.architecture)
        ? image.architecture
        : null,
    builtSourceCommit: commit,
    builtImageId: imageReference(builder.imageId) ?? null,
  };
}

function imageMetadata(
  bytes: Buffer,
): { format: string; width: number; height: number } | null {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return {
      format: "png",
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9 || marker === undefined) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker) &&
      length >= 7
    ) {
      return {
        format: "jpeg",
        width: bytes.readUInt16BE(offset + 5),
        height: bytes.readUInt16BE(offset + 3),
      };
    }
    offset += length;
  }
  return null;
}

function screenshots(projectRoot: string) {
  return [
    "ui-console-desktop.png",
    "ui-console-mobile.png",
    "ui-console-tablet.png",
    "ui-live-logs.png",
  ].map((file) => {
    const path = resolve(projectRoot, "artifacts", file);
    if (!existsSync(path))
      return {
        file,
        href: `../../${file}`,
        present: false,
        format: null,
        width: null,
        height: null,
        bytes: null,
        modifiedAt: null,
      };
    const meta = statSync(path),
      bytes = readFileSync(path);
    const metadata = imageMetadata(bytes);
    return {
      file,
      href: `../../${file}`,
      present: Boolean(metadata),
      format: metadata?.format ?? null,
      width: metadata?.width ?? null,
      height: metadata?.height ?? null,
      bytes: meta.size,
      modifiedAt: meta.mtime.toISOString(),
    };
  });
}

function comparisons(suites: Suite[]) {
  const cases = [
    {
      label: "Unhealthy release",
      reference: "unhealthy-release",
      panel: "unhealthy-release-preserves-previous-runtime",
    },
    {
      label: "Wrong application database password",
      reference: "wrong-database-password",
      panel: "wrong-database-password-rolls-back-application",
    },
    {
      label: "Wrong HTTP port",
      reference: "wrong-http-port",
      panel: "wrong-http-port-preserves-previous-runtime",
    },
  ];
  return ["initial", "after-restart"].flatMap((phase) =>
    cases.map((testCase) => {
      const referenceSuite = suites.find(
        (suite) =>
          suite.target === "reference-advanced" && suite.phase === phase,
      );
      const panelSuite = suites.find(
        (suite) => suite.target === "advanced" && suite.phase === phase,
      );
      const reference = referenceSuite?.checks.find(
        (check) => check.id === testCase.reference,
      );
      const panel = panelSuite?.checks.find(
        (check) => check.id === testCase.panel,
      );
      return {
        case: testCase.label,
        phase,
        reference: {
          checkStatus: reference?.status ?? "pending",
          ...(reference?.observation ?? {
            actionStatus: null,
            httpHealthStatus: null,
            oldRuntimePreserved: null,
          }),
        },
        panel: {
          checkStatus: panel?.status ?? "pending",
          outcome:
            panel?.status === "passed"
              ? "Deployment action failed; previous healthy runtime and persisted data verified by the scenario assertions."
              : "Outcome not verified by a passing scenario.",
        },
      };
    }),
  );
}

export function generateReport(options: {
  projectRoot: string;
  runId: string;
}) {
  const { projectRoot, runId } = options;
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId))
    throw new Error("Set PARITY_RUN_ID to a short lowercase run identifier.");
  const directory = resolve(projectRoot, "artifacts/parity", runId);
  mkdirSync(directory, { recursive: true });
  const available = readdirSync(directory).filter(
    (file) =>
      /^[a-z0-9][a-z0-9-]*\.json$/.test(file) && file !== "summary.json",
  );
  const files = [...new Set([...requiredFiles, ...available])].sort();
  const suites = files.map((file) => loadSuite(directory, file, runId));
  const unit = loadUnit(projectRoot),
    packaging = loadPackage(projectRoot);
  const required = suites.filter((suite) => requiredFiles.includes(suite.file));
  const ourStatus = stateFor([
    ...required.map((suite) => suite.status),
    unit.status,
    packaging.status,
  ]);
  const referenceRestart = suites.find(
    (suite) => suite.file === "reference-restart.json",
  );
  const restartDefect = referenceRestart?.checks.find(
    (check) =>
      check.id === "wordpress-post-media-and-authentication-after-restart" &&
      check.status === "failed",
  );
  const recovery = suites.find(
    (suite) => suite.file === "reference-recovery.json",
  );
  const summary = {
    runId,
    generatedAt: new Date().toISOString(),
    timezone: "Europe/Warsaw",
    ourStatus,
    headline:
      ourStatus === "passed"
        ? "Our required suites passed"
        : ourStatus === "failed"
          ? "Our verification contains failures"
          : "Our verification is pending",
    scope:
      "Independent Panel source; local application and database pilot. This report does not certify complete EasyPanel compatibility.",
    referenceScope:
      "Locally MODIFIED reference 2.38.0. Observations apply only to this recorded image and environment, not to every official release.",
    requiredFiles,
    suites,
    unit,
    packaging,
    screenshots: screenshots(projectRoot),
    comparison: comparisons(suites),
    excludedScope,
    referenceRestart: {
      status: referenceRestart?.status ?? "pending",
      defectObserved: Boolean(restartDefect),
      description: restartDefect
        ? "WordPress did not automatically resume after a clean local VM reboot. The measured reference task completed under its on-failure restart policy."
        : "No matching failed restart observation is recorded yet.",
      operatorRecovery: recovery?.status ?? "pending",
      recoveryNote:
        "Operator recovery is recorded separately and does not turn the failed automatic restart check into a pass.",
    },
    evidenceLimits: [
      "Only listed assertions and recorded observations are claimed. Missing and partial inputs remain pending.",
      "A passed reference failure experiment means the observation was collected and the fixture restored; it does not mean the failed release remained healthy.",
      "Source report error bodies, runtime logs, credentials, cookies and console tickets are not embedded.",
      "Screenshot metadata establishes available layout evidence, not an automated interaction or accessibility result.",
      "Reports do not embed a source revision. Match file timestamps and the tested checkout before treating this as release evidence.",
    ],
  };
  writeFileSync(
    resolve(directory, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  writeFileSync(resolve(directory, "index.html"), renderHtml(summary));
  return summary;
}

type Summary = ReturnType<typeof generateReport>;
function escape(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}
function localDate(value: string | null): string {
  return value
    ? new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Europe/Warsaw",
      }).format(new Date(value))
    : "Not recorded";
}
function badge(status: string, label = status) {
  return `<span class="badge ${escape(status)}">${escape(label)}</span>`;
}
function suiteHtml(suite: Suite): string {
  const recorded = suite.checks.length > 0;
  const rows = suite.checks
    .map(
      (check) =>
        `<tr><td><code>${escape(check.id)}</code></td><td>${badge(check.status, suite.meaning === "observations" && check.status === "passed" ? "measurement recorded" : check.status)}</td><td>${check.observation ? `Action: ${escape(check.observation.actionStatus ?? "not recorded")}<br>HTTP health: ${check.observation.httpHealthStatus === null ? "not recorded" : badge(check.observation.httpHealthStatus >= 400 ? "failed" : "passed", String(check.observation.httpHealthStatus))}<br>Previous runtime preserved: ${escape(check.observation.oldRuntimePreserved ?? "not recorded")}` : "No additional public detail"}</td></tr>`,
    )
    .join("");
  return `<article class="suite"><header><div><h3>${escape(suite.file)}</h3><p>${escape(suite.phase)} · ${escape(localDate(suite.checkedAt))} Europe/Warsaw</p></div>${badge(suite.status)}</header><p>${suite.passed} passed${suite.meaning === "observations" ? " measurements" : ""}, ${suite.failed} failed, ${suite.pending} unresolved${suite.expected === null ? "" : ` · ${suite.expected} required checks`}</p>${suite.meaning === "observations" ? '<p class="notice">Passing status confirms collection and restoration. Read HTTP and runtime observations independently.</p>' : ""}${suite.notes.map((note) => `<p class="notice">${escape(note)}</p>`).join("")}${suite.missingChecks.length ? `<p class="notice">Missing required checks: ${suite.missingChecks.map(escape).join(", ")}</p>` : ""}${recorded ? `<div class="table-scroll"><table><thead><tr><th>Check</th><th>Status</th><th>Recorded observation</th></tr></thead><tbody>${rows}</tbody></table></div>` : "<p>No checks recorded.</p>"}</article>`;
}
function renderHtml(summary: Summary): string {
  const own = summary.suites.filter(
    (suite) => !suite.target.startsWith("reference"),
  );
  const reference = summary.suites.filter((suite) =>
    suite.target.startsWith("reference"),
  );
  const comparisonRows = summary.comparison
    .map(
      (row) =>
        `<tr><td>${escape(row.case)}<small>${escape(row.phase)}</small></td><td>${badge(row.reference.checkStatus, row.reference.checkStatus === "passed" ? "measurement recorded" : row.reference.checkStatus)}<br>Action: ${escape(row.reference.actionStatus ?? "pending")}<br>HTTP health: ${row.reference.httpHealthStatus === null ? "pending" : badge(row.reference.httpHealthStatus >= 400 ? "failed" : "passed", String(row.reference.httpHealthStatus))}<br>Previous runtime preserved: ${escape(row.reference.oldRuntimePreserved ?? "pending")}</td><td>${badge(row.panel.checkStatus)}<p>${escape(row.panel.outcome)}</p></td></tr>`,
    )
    .join("");
  const images = summary.screenshots.filter((item) => item.present);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Panel verification ${escape(summary.runId)}</title><style>
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#252d29;background:#f4f5f4;font-size:15px;line-height:1.55}*{box-sizing:border-box}body{margin:0}main{max-width:1280px;margin:auto;padding:36px 24px 72px}h1{font-size:34px;line-height:1.15;letter-spacing:-1px;margin:12px 0}h2{font-size:23px;margin:36px 0 16px}h3{font-size:17px;margin:0}p{margin:10px 0;color:#56605a}small{display:block;color:#66716a}code{font-family:ui-monospace,monospace;font-size:12px;overflow-wrap:anywhere}a{color:#24583c}header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#66716a}.surface,.suite{background:white;border:1px solid #e4e8e5;border-radius:18px;padding:22px;margin:14px 0}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.grid .surface{margin:0}.badge{display:inline-block;font-size:12px;font-weight:650;border-radius:20px;padding:3px 9px;background:#ebeeec;color:#44524a;white-space:nowrap}.passed{background:#e3f4e9;color:#28573c}.failed{background:#fbe7e4;color:#8b2e23}.pending,.skipped{background:#fff2d7;color:#73520b}.notice{padding:12px 14px;background:#f6f7f6;border-radius:10px;color:#48544d}.defect{border-color:#dfa197;background:#fff8f6}.table-scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px;margin-top:12px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #e9ecea;padding:12px 10px}th{font-size:12px;color:#66716a;font-weight:600}td:first-child{width:40%}td p{margin:6px 0}.shots{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,1fr);gap:16px;align-items:start}figure{margin:0;min-width:0}img{display:block;width:100%;height:auto;border:1px solid #dce3de;border-radius:12px}figcaption{font-size:12px;margin:8px 0;color:#56605a}li{margin:6px 0}.metric{font-size:28px;font-weight:650;margin:10px 0;color:#252d29}@media(max-width:720px){main{padding:24px 14px 48px}.grid,.shots{grid-template-columns:1fr}.surface,.suite{padding:16px}h1{font-size:28px}header{flex-wrap:wrap}td{min-width:135px}td:first-child{min-width:220px}}
</style></head><body><main>
<div class="eyebrow">Local verification report · ${escape(summary.runId)}</div><h1>${escape(summary.headline)}</h1><p>Generated ${escape(localDate(summary.generatedAt))} Europe/Warsaw. <a href="summary.json">Structured summary</a></p><p>${escape(summary.scope)}</p><p>${escape(summary.referenceScope)}</p>
<div class="grid"><section class="surface"><h3>Our required suites</h3><div class="metric">${summary.suites.filter((suite) => summary.requiredFiles.includes(suite.file) && suite.status === "passed").length} / ${summary.requiredFiles.length}</div>${badge(summary.ourStatus)}<p>Initial, after-restart, access and post-reboot storage assertions plus unit and package evidence.</p></section><section class="surface"><h3>Unit tests</h3><div class="metric">${summary.unit.passed ?? "?"} / ${summary.unit.total ?? "?"}</div>${badge(summary.unit.status)}<p>${summary.unit.failed ?? "?"} failed · ${summary.unit.pending ?? "?"} pending · ${summary.unit.todo ?? "?"} todo</p></section><section class="surface"><h3>Package checks</h3><div class="metric">${summary.packaging.checks.filter((check) => check.status === "passed").length} / ${summary.packaging.checks.length}</div>${badge(summary.packaging.status)}<p>Only recorded package fields count.</p></section></div>
<section class="surface ${summary.referenceRestart.defectObserved ? "defect" : ""}"><h2 style="margin-top:0">Reference restart defect</h2>${badge(summary.referenceRestart.status)}<p>${escape(summary.referenceRestart.description)}</p><p>Operator recovery: ${badge(summary.referenceRestart.operatorRecovery)}. ${escape(summary.referenceRestart.recoveryNote)}</p></section>
<h2>Failure behavior comparison</h2><p>Reference experiment passes describe measurements, not healthy releases. Panel outcomes below come from the passing scenario assertions, not inferred action labels.</p><section class="surface table-scroll"><table><thead><tr><th>Case / phase</th><th>Modified local reference</th><th>Independent Panel</th></tr></thead><tbody>${comparisonRows}</tbody></table></section>
<h2>Our recorded suites</h2>${own.map(suiteHtml).join("")}
<h2>Reference measurements and recovery</h2><p>All recorded failures remain visible. Manual recovery does not replace the earlier restart result.</p>${reference.length ? reference.map(suiteHtml).join("") : "<p>Reference reports pending.</p>"}
<h2>Unit and package evidence</h2><section class="surface"><p>Unit test source: <a href="${escape(summary.unit.file)}">unit-tests.json</a>, ${escape(localDate(summary.unit.checkedAt))} Europe/Warsaw.</p><p>Package source: <a href="${escape(summary.packaging.file)}">package-verification.json</a>. Engine ${escape(summary.packaging.engineVersion ?? "not recorded")}, API UID ${escape(summary.packaging.apiUid ?? "not recorded")}.</p><p>Package image: <code>${escape(summary.packaging.imageId ?? "Not recorded in package report")}</code></p><ul>${summary.packaging.checks.map((check) => `<li>${escape(check.name)} ${badge(check.status)}</li>`).join("")}</ul></section>
<h2>Browser evidence</h2><p>Available screenshot files and their dimensions are recorded below. File presence does not establish interaction, keyboard or screen reader test results.</p><section class="surface"><div class="shots">${images
    .filter((item) =>
      ["ui-console-desktop.png", "ui-console-mobile.png"].includes(item.file),
    )
    .map(
      (item) =>
        `<figure><a href="${escape(item.href)}"><img src="${escape(item.href)}" alt="${item.file.includes("desktop") ? "Desktop" : "Mobile"} container console screenshot" loading="lazy"></a><figcaption>${escape(item.file)} · ${item.width} × ${item.height} · ${escape(localDate(item.modifiedAt))} Europe/Warsaw</figcaption></figure>`,
    )
    .join(
      "",
    )}</div><ul>${summary.screenshots.map((item) => `<li>${item.present ? `<a href="${escape(item.href)}">${escape(item.file)}</a> · ${item.width} × ${item.height} · ${item.bytes} bytes` : `${escape(item.file)}: pending`}</li>`).join("")}</ul></section>
<h2>Excluded scope</h2><section class="surface"><ul>${summary.excludedScope.map((item) => `<li>${escape(item)}</li>`).join("")}</ul></section><h2>Evidence limits</h2><section class="surface"><ul>${summary.evidenceLimits.map((item) => `<li>${escape(item)}</li>`).join("")}</ul></section>
</main></body></html>`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const runId = process.env.PARITY_RUN_ID;
  if (!runId)
    throw new Error("Set PARITY_RUN_ID to the existing run to aggregate.");
  const summary = generateReport({
    projectRoot: resolve(import.meta.dirname, ".."),
    runId,
  });
  console.log(
    `Report generated: artifacts/parity/${runId}/index.html (${summary.ourStatus}).`,
  );
}
