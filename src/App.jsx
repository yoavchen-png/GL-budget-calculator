import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip as ChartTooltip,
  ResponsiveContainer,
  ReferenceDot,
  ReferenceLine,
  CartesianGrid,
} from "recharts";
import {
  FileText,
  Calculator as CalcIcon,
  Table as TableIcon,
  Trash2,
  Search,
  ChevronDown,
  ChevronRight,
  Download,
  Upload,
  Globe,
  AlertCircle,
  CheckCircle2,
  Clock,
  Tag,
  HelpCircle,
  BookOpen,
} from "lucide-react";

/* ============================================================
 *  PARSER
 *  Converts a pasted Google Ads automated-rules export into a
 *  structured list. Tolerant of layout variations (one-time
 *  rules, rules targeting campaign type vs labels, etc).
 * ============================================================ */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseTime12h(s) {
  if (!s) return null;
  const m = s.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10);
  const ampm = m[3].toUpperCase();
  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${String(mn).padStart(2, "0")}`;
}

function parseCadence(line) {
  // "Daily at 11:40 PM"
  let m = line.match(/^Daily at (.+)$/);
  if (m) {
    const t = parseTime12h(m[1]);
    if (!t) return null;
    return { type: "daily", days: [0, 1, 2, 3, 4, 5, 6], time: t };
  }
  // "Weekly on Sunday at 11:40 PM"
  // "Weekly on Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, and Sunday at 3:45 AM"
  m = line.match(/^Weekly on (.+?) at (.+)$/);
  if (m) {
    const daysStr = m[1];
    const t = parseTime12h(m[2]);
    if (!t) return null;
    const tokens = daysStr.replace(/,?\s+and\s+/g, ",").split(",").map((s) => s.trim());
    const days = tokens
      .map((tok) => DAY_NAMES.indexOf(tok))
      .filter((i) => i >= 0);
    return { type: "weekly", days, time: t };
  }
  // "One time on Sep 17, 2025 at 12:10 AM"
  m = line.match(/^One time on (.+?) at (.+)$/);
  if (m) {
    const t = parseTime12h(m[2]);
    return { type: "once", date: m[1].trim(), time: t };
  }
  return null;
}

function parseRuleBlock(block) {
  if (block.length < 3) return null;
  const name = block[0];
  const actionDesc = block[1];
  const id = block[block.length - 1];

  let action = null;
  const am = actionDesc.match(/(Increase|Decrease)\s+campaign budget by\s+([\d.]+)%/i);
  if (am) {
    action = { type: am[1].toLowerCase(), percent: parseFloat(am[2]) };
  }

  let statusTargets = null; // e.g. "Enabled" or "Enabled, Paused"
  let labelsAny = [];
  let campaignType = null;
  let cadence = null;
  let owner = null;

  for (const line of block) {
    if (line.startsWith("Campaign status:")) {
      statusTargets = line.replace("Campaign status:", "").trim();
    } else if (line.startsWith("Label contains any ")) {
      const labelStr = line.replace("Label contains any ", "");
      labelsAny = [...new Set(labelStr.split(",").map((s) => s.trim()).filter(Boolean))];
    } else if (line.startsWith("Campaign type:")) {
      campaignType = line.replace("Campaign type:", "").trim();
    } else if (!cadence) {
      const c = parseCadence(line);
      if (c) cadence = c;
    }
    if (!owner && /^[\w.+-]+@[\w.-]+\.\w+$/.test(line)) {
      owner = line;
    }
  }

  // Infer locale from name prefix; if not clear, infer from labels
  let locale = "Other";
  if (/^OAD UK-/i.test(name) || labelsAny.some((l) => /\bUK\b/i.test(l))) locale = "UK";
  else if (/Countries|Country-/i.test(name) || labelsAny.some((l) => /Countries|Country/i.test(l))) locale = "Countries";
  else if (/^OAD-/i.test(name) || labelsAny.some((l) => /\bUS\b/i.test(l))) locale = "US";

  return {
    id,
    name,
    action,
    statusTargets,
    labelsAny,
    campaignType,
    cadence,
    owner,
    locale,
    raw: block.join("\n"),
  };
}

function parseRulesText(text) {
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
  const blocks = [];
  let current = [];
  for (let i = 0; i < lines.length; i++) {
    current.push(lines[i]);
    if (
      lines[i] === "Only if there are errors" &&
      i + 1 < lines.length &&
      /^\d+$/.test(lines[i + 1])
    ) {
      current.push(lines[i + 1]);
      blocks.push(current);
      current = [];
      i++;
    }
  }
  return blocks.map(parseRuleBlock).filter(Boolean);
}

/* ============================================================
 *  TIMEZONE HELPERS
 * ============================================================ */

const TIMEZONES = [
  { id: "America/Los_Angeles", label: "Pacific (Los Angeles)" },
  { id: "America/Denver", label: "Mountain (Denver)" },
  { id: "America/Chicago", label: "Central (Chicago)" },
  { id: "America/New_York", label: "Eastern (New York)" },
  { id: "UTC", label: "UTC" },
  { id: "Europe/London", label: "London" },
  { id: "Europe/Berlin", label: "Berlin / Frankfurt" },
  { id: "Asia/Jerusalem", label: "Israel" },
  { id: "Asia/Tokyo", label: "Tokyo" },
  { id: "Australia/Sydney", label: "Sydney" },
];

const DEFAULT_TZ = "America/Los_Angeles";

function getLocalTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function tzAbbrev(tz, date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "short",
    }).formatToParts(date);
    return parts.find((p) => p.type === "timeZoneName")?.value || tz;
  } catch {
    return tz;
  }
}

function tzOffsetMinutes(tz, date = new Date()) {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
    const hour = parts.hour === "24" ? 0 : parseInt(parts.hour, 10);
    const asUTC = Date.UTC(
      parseInt(parts.year, 10),
      parseInt(parts.month, 10) - 1,
      parseInt(parts.day, 10),
      hour,
      parseInt(parts.minute, 10),
      parseInt(parts.second, 10)
    );
    return Math.round((asUTC - date.getTime()) / 60000);
  } catch {
    return 0;
  }
}

function convertHHMM(hhmm, fromTz, toTz, date = new Date()) {
  if (!hhmm || fromTz === toTz) return hhmm;
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  const diff = tzOffsetMinutes(toTz, date) - tzOffsetMinutes(fromTz, date);
  let total = h * 60 + m + diff;
  total = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function nowInTz(tz, date = new Date()) {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const day = dayMap[parts.weekday] ?? 0;
    const hour = parts.hour === "24" ? 0 : parseInt(parts.hour, 10);
    const minute = parseInt(parts.minute, 10);
    return {
      day,
      hour,
      minute,
      hhmm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    };
  } catch {
    return { day: 0, hour: 0, minute: 0, hhmm: "00:00" };
  }
}

function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/* ============================================================
 *  CALCULATION
 * ============================================================ */

function rulesForDay(rules, campaignLabels, dayIdx) {
  const labelSet = new Set(campaignLabels.map((l) => l.trim()).filter(Boolean));
  return rules
    .filter((r) => {
      if (!r.action || !r.cadence) return false;
      if (r.cadence.type === "once") return false;
      if (!r.cadence.days.includes(dayIdx)) return false;
      if (r.labelsAny.length === 0) return false; // no label rule = unsupported here
      return r.labelsAny.some((l) => labelSet.has(l));
    })
    .sort((a, b) => a.cadence.time.localeCompare(b.cadence.time));
}

function computeCurve(startBudget, applicable) {
  let budget = startBudget;
  const steps = [
    { time: "00:00", budget, before: null, delta: 0, ruleId: null, ruleName: "Start of day", action: null },
  ];
  for (const r of applicable) {
    const before = budget;
    const sign = r.action.type === "increase" ? 1 : -1;
    const factor = 1 + (sign * r.action.percent) / 100;
    budget = budget * factor;
    steps.push({
      time: r.cadence.time,
      budget,
      before,
      delta: budget - before,
      ruleId: r.id,
      ruleName: r.name,
      action: r.action,
    });
  }
  steps.push({
    time: "23:59",
    budget,
    before: null,
    delta: 0,
    ruleId: null,
    ruleName: "End of day",
    action: null,
  });
  return steps;
}

function fmtMoney(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function timeToHour(t) {
  const [h, m] = t.split(":").map((x) => parseInt(x, 10));
  return h + m / 60;
}

function budgetAtTime(steps, hhmm) {
  // steps[0] is "00:00" with start budget, so this always finds a value.
  let result = steps[0].budget;
  for (const s of steps) {
    if (s.time <= hhmm) result = s.budget;
    else break;
  }
  return result;
}

/* ============================================================
 *  STORAGE — per-account
 * ============================================================ */

const ACCOUNTS_KEY = "accounts:list";
const ACTIVE_ACCOUNT_KEY = "accounts:active";
const LEGACY_RULES_KEY = "rules:all";
const accountRulesKey = (id) => `account:${id}:rules`;

function newAccountId() {
  return "acc_" + Math.random().toString(36).slice(2, 10);
}

function normalizeAccount(acc) {
  return { timezone: DEFAULT_TZ, ...acc };
}

async function loadAccounts() {
  // Try current scheme
  try {
    const res = await window.storage.get(ACCOUNTS_KEY);
    if (res?.value) {
      const list = JSON.parse(res.value);
      if (Array.isArray(list) && list.length > 0) return list.map(normalizeAccount);
    }
  } catch {
    // not found
  }
  // Migrate from legacy single-bucket storage if present
  try {
    const legacy = await window.storage.get(LEGACY_RULES_KEY);
    if (legacy?.value) {
      const acc = normalizeAccount({ id: newAccountId(), name: "Account 1" });
      await window.storage.set(accountRulesKey(acc.id), legacy.value);
      await window.storage.set(ACCOUNTS_KEY, JSON.stringify([acc]));
      return [acc];
    }
  } catch {
    // no legacy data
  }
  // Cold start
  const acc = normalizeAccount({ id: newAccountId(), name: "Account 1" });
  await window.storage.set(ACCOUNTS_KEY, JSON.stringify([acc]));
  return [acc];
}

async function saveAccounts(accounts) {
  try {
    await window.storage.set(ACCOUNTS_KEY, JSON.stringify(accounts));
  } catch (e) {
    console.error("Failed to save accounts", e);
  }
}

async function loadActiveAccountId() {
  try {
    const res = await window.storage.get(ACTIVE_ACCOUNT_KEY);
    if (res?.value) return res.value;
  } catch {
    // not found
  }
  return null;
}

async function saveActiveAccountId(id) {
  try {
    await window.storage.set(ACTIVE_ACCOUNT_KEY, id);
  } catch (e) {
    console.error("Failed to save active account", e);
  }
}

async function loadRulesForAccount(id) {
  try {
    const res = await window.storage.get(accountRulesKey(id));
    if (res?.value) return JSON.parse(res.value);
  } catch {
    // not found
  }
  return [];
}

async function saveRulesForAccount(id, rules) {
  try {
    await window.storage.set(accountRulesKey(id), JSON.stringify(rules));
  } catch (e) {
    console.error("Failed to save rules", e);
  }
}

async function deleteAccountRules(id) {
  try {
    await window.storage.delete(accountRulesKey(id));
  } catch (e) {
    // best effort
  }
}

/* ============================================================
 *  UI
 * ============================================================ */

const ACCENT = "#2563eb";

function App() {
  const [tab, setTab] = useState("rules");
  const [accounts, setAccounts] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [rules, setRules] = useState([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [rulesLoaded, setRulesLoaded] = useState(false);

  // Initial load: accounts + active selection
  useEffect(() => {
    (async () => {
      const accs = await loadAccounts();
      const storedActive = await loadActiveAccountId();
      const initial = accs.find((a) => a.id === storedActive)?.id || accs[0]?.id;
      setAccounts(accs);
      setActiveId(initial);
      setAccountsLoaded(true);
    })();
  }, []);

  // When active account changes: load its rules
  useEffect(() => {
    if (!activeId) return;
    setRulesLoaded(false);
    loadRulesForAccount(activeId).then((r) => {
      setRules(r);
      setRulesLoaded(true);
    });
    saveActiveAccountId(activeId);
  }, [activeId]);

  // Persist rules whenever they change (but only after they've loaded for this account)
  useEffect(() => {
    if (rulesLoaded && activeId) {
      saveRulesForAccount(activeId, rules);
    }
  }, [rules, rulesLoaded, activeId]);

  // Persist accounts list whenever it changes
  useEffect(() => {
    if (accountsLoaded) saveAccounts(accounts);
  }, [accounts, accountsLoaded]);

  const addAccount = () => {
    const acc = normalizeAccount({
      id: newAccountId(),
      name: `Account ${accounts.length + 1}`,
    });
    setAccounts([...accounts, acc]);
    setActiveId(acc.id);
  };

  const renameAccount = (id, name) => {
    setAccounts(accounts.map((a) => (a.id === id ? { ...a, name } : a)));
  };

  const updateAccount = (id, patch) => {
    setAccounts(accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  };

  const removeAccount = (id) => {
    if (accounts.length <= 1) {
      alert("You need at least one account. Add another before removing this one.");
      return;
    }
    const acc = accounts.find((a) => a.id === id);
    if (!confirm(`Delete "${acc?.name}" and all its rules? This can't be undone.`)) return;
    const remaining = accounts.filter((a) => a.id !== id);
    setAccounts(remaining);
    deleteAccountRules(id);
    if (activeId === id) setActiveId(remaining[0].id);
  };

  const knownLabels = useMemo(() => {
    const s = new Set();
    rules.forEach((r) => r.labelsAny.forEach((l) => s.add(l)));
    return [...s].sort();
  }, [rules]);

  const activeAccount = accounts.find((a) => a.id === activeId);
  const accountTz = activeAccount?.timezone || DEFAULT_TZ;
  const localTz = getLocalTz();

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 antialiased">
      <style>{`
        .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
        .num { font-variant-numeric: tabular-nums; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
        .scrollbar-thin::-webkit-scrollbar { width: 8px; height: 8px; }
        .scrollbar-thin::-webkit-scrollbar-thumb { background: #d6d3d1; border-radius: 4px; }
      `}</style>

      <header className="border-b border-stone-200 bg-white">
        <div className="max-w-7xl mx-auto px-6 pt-4 pb-2 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-base font-semibold tracking-tight">Budget Calculator</h1>
            <p className="text-xs text-stone-500 mt-0.5">
              Google Ads automated-rule chain calculator
              {activeAccount && (
                <>
                  {" · "}
                  <span className="text-stone-700">{activeAccount.name}</span>
                </>
              )}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <LiveClock accountTz={accountTz} localTz={localTz} />
            <div className="text-[11px] text-stone-500">
              <span className="num">{rules.length}</span> rules
            </div>
          </div>
        </div>

        <AccountTabs
          accounts={accounts}
          activeId={activeId}
          onSwitch={setActiveId}
          onAdd={addAccount}
          onRename={renameAccount}
          onRemove={removeAccount}
        />

        <nav className="max-w-7xl mx-auto px-6 flex gap-1 border-t border-stone-100">
          {[
            { id: "rules", label: "Rules", icon: FileText },
            { id: "single", label: "Single Campaign", icon: CalcIcon },
            { id: "bulk", label: "Bulk Report", icon: TableIcon },
            { id: "docs", label: "Help", icon: BookOpen },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-2 px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                tab === id
                  ? "border-stone-900 text-stone-900 font-medium"
                  : "border-transparent text-stone-500 hover:text-stone-800"
              }`}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </nav>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6">
        {!rulesLoaded ? (
          <div className="text-sm text-stone-500 py-12 text-center">Loading…</div>
        ) : (
          <>
            {tab === "rules" && (
              <RulesTab
                key={activeId}
                rules={rules}
                setRules={setRules}
                accountTz={accountTz}
                localTz={localTz}
                onTimezoneChange={(tz) => updateAccount(activeId, { timezone: tz })}
              />
            )}
            {tab === "single" && (
              <SingleCampaignTab
                key={activeId}
                rules={rules}
                knownLabels={knownLabels}
                accountTz={accountTz}
                localTz={localTz}
              />
            )}
            {tab === "bulk" && (
              <BulkReportTab
                key={activeId}
                rules={rules}
                knownLabels={knownLabels}
                accountTz={accountTz}
                localTz={localTz}
              />
            )}
            {tab === "docs" && <DocsTab />}
          </>
        )}
      </main>
    </div>
  );
}

function LiveClock({ accountTz, localTz }) {
  const now = useNow(15000);
  const acct = nowInTz(accountTz, now);
  const local = nowInTz(localTz, now);
  const acctAbbr = tzAbbrev(accountTz, now);
  const localAbbr = tzAbbrev(localTz, now);
  const sameZone = accountTz === localTz;
  return (
    <div className="flex items-center gap-2 text-xs">
      <Clock size={12} className="text-stone-400" />
      <span className="num font-medium text-stone-800">{acct.hhmm}</span>
      <span className="text-[10px] text-stone-500 uppercase tracking-wide">{acctAbbr}</span>
      {!sameZone && (
        <>
          <span className="text-stone-300">·</span>
          <span className="num text-stone-600">{local.hhmm}</span>
          <span className="text-[10px] text-stone-500 uppercase tracking-wide">{localAbbr}</span>
        </>
      )}
    </div>
  );
}

function Tooltip({ children, content, side = "top" }) {
  const [open, setOpen] = useState(false);
  if (!content) return children;
  const positions = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-1.5",
    right: "left-full top-1/2 -translate-y-1/2 ml-2",
    left: "right-full top-1/2 -translate-y-1/2 mr-2",
  };
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className={`absolute z-50 ${positions[side]} px-2.5 py-1.5 text-[11px] leading-relaxed font-normal normal-case tracking-normal bg-stone-900 text-stone-100 rounded shadow-lg w-max max-w-[280px] pointer-events-none whitespace-normal text-left`}
        >
          {content}
        </span>
      )}
    </span>
  );
}

function InfoTip({ content, side = "top" }) {
  return (
    <Tooltip content={content} side={side}>
      <button
        type="button"
        className="text-stone-400 hover:text-stone-700 inline-flex items-center align-middle"
        aria-label="More info"
      >
        <HelpCircle size={11} />
      </button>
    </Tooltip>
  );
}

function AccountTabs({ accounts, activeId, onSwitch, onAdd, onRename, onRemove }) {
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState("");

  const startEdit = (acc) => {
    setEditingId(acc.id);
    setEditValue(acc.name);
  };

  const commitEdit = () => {
    if (editingId && editValue.trim()) {
      onRename(editingId, editValue.trim());
    }
    setEditingId(null);
  };

  return (
    <div className="max-w-7xl mx-auto px-6 pb-2 flex items-center gap-1.5 overflow-x-auto scrollbar-thin">
      {accounts.map((acc) => {
        const isActive = acc.id === activeId;
        const isEditing = editingId === acc.id;
        return (
          <div
            key={acc.id}
            className={`group flex items-center gap-0.5 pl-3 pr-1 py-1 rounded-md text-xs border transition-colors shrink-0 ${
              isActive
                ? "bg-stone-900 text-white border-stone-900"
                : "bg-white text-stone-700 border-stone-200 hover:border-stone-400"
            }`}
          >
            {isEditing ? (
              <input
                autoFocus
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEdit();
                  if (e.key === "Escape") setEditingId(null);
                }}
                className={`px-1 py-0.5 text-xs rounded outline-none w-36 ${
                  isActive ? "bg-stone-800 text-white" : "bg-stone-50 text-stone-900"
                }`}
              />
            ) : (
              <button
                onClick={() => (isActive ? startEdit(acc) : onSwitch(acc.id))}
                onDoubleClick={() => startEdit(acc)}
                className="font-medium py-0.5"
                title={isActive ? "Click to rename" : "Click to switch · double-click to rename"}
              >
                {acc.name}
              </button>
            )}
            {accounts.length > 1 && !isEditing && (
              <button
                onClick={() => onRemove(acc.id)}
                className={`ml-0.5 w-4 h-4 rounded flex items-center justify-center text-sm leading-none opacity-0 group-hover:opacity-100 transition-opacity ${
                  isActive
                    ? "text-stone-300 hover:bg-stone-700 hover:text-white"
                    : "text-stone-400 hover:bg-rose-50 hover:text-rose-600"
                }`}
                title="Delete account"
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      <button
        onClick={onAdd}
        className="flex items-center px-2.5 py-1 rounded-md text-xs text-stone-500 hover:text-stone-900 hover:bg-stone-100 border border-dashed border-stone-300 shrink-0"
        title="Add account"
      >
        + Account
      </button>
    </div>
  );
}

/* ============================================================
 *  RULES TAB
 * ============================================================ */

function RulesTab({ rules, setRules, accountTz, localTz, onTimezoneChange }) {
  const [pasteText, setPasteText] = useState("");
  const [showPaste, setShowPaste] = useState(rules.length === 0);
  const [parseResult, setParseResult] = useState(null);
  const [filter, setFilter] = useState({ locale: "all", day: "all", search: "" });
  const [expandedId, setExpandedId] = useState(null);

  const accountAbbr = tzAbbrev(accountTz);
  const localAbbr = tzAbbrev(localTz);
  const sameZone = accountTz === localTz;

  const handleParse = () => {
    const parsed = parseRulesText(pasteText);
    setParseResult({ count: parsed.length, failed: 0 });
    setRules(parsed);
    setShowPaste(false);
  };

  const handleClear = () => {
    if (confirm("Delete all stored rules?")) {
      setRules([]);
      setPasteText("");
      setShowPaste(true);
      setParseResult(null);
    }
  };

  const filtered = useMemo(() => {
    return rules.filter((r) => {
      if (filter.locale !== "all" && r.locale !== filter.locale) return false;
      if (filter.day !== "all") {
        const d = parseInt(filter.day, 10);
        if (!r.cadence?.days?.includes(d)) return false;
      }
      if (filter.search) {
        const s = filter.search.toLowerCase();
        if (
          !r.name.toLowerCase().includes(s) &&
          !r.labelsAny.some((l) => l.toLowerCase().includes(s))
        )
          return false;
      }
      return true;
    });
  }, [rules, filter]);

  const localeCounts = useMemo(() => {
    const c = {};
    rules.forEach((r) => {
      c[r.locale] = (c[r.locale] || 0) + 1;
    });
    return c;
  }, [rules]);

  return (
    <div className="space-y-6">
      {/* Update rules card */}
      <section className="bg-white border border-stone-200 rounded-lg overflow-hidden">
        <button
          onClick={() => setShowPaste(!showPaste)}
          className="w-full px-5 py-3 flex items-center justify-between hover:bg-stone-50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <FileText size={14} className="text-stone-500" />
            <span className="text-sm font-medium">Paste rules export</span>
            {parseResult && (
              <span className="text-xs text-emerald-700 flex items-center gap-1 ml-2">
                <CheckCircle2 size={12} />
                Parsed {parseResult.count} rules
              </span>
            )}
          </div>
          {showPaste ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {showPaste && (
          <div className="border-t border-stone-200 p-5 space-y-3">
            <p className="text-xs text-stone-600">
              Paste the full text export of your One &amp; Done rules below. The parser detects each
              rule block automatically.
            </p>
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="Paste rules text here…"
              className="w-full h-48 px-3 py-2 text-xs mono border border-stone-300 rounded bg-stone-50 focus:outline-none focus:ring-1 focus:ring-stone-400 scrollbar-thin"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={handleParse}
                disabled={!pasteText.trim()}
                className="px-3 py-1.5 text-xs font-medium bg-stone-900 text-white rounded hover:bg-stone-800 disabled:bg-stone-300"
              >
                Parse and replace
              </button>
              {rules.length > 0 && (
                <button
                  onClick={handleClear}
                  className="px-3 py-1.5 text-xs text-stone-600 hover:text-rose-700 flex items-center gap-1"
                >
                  <Trash2 size={12} />
                  Clear stored rules
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Account settings */}
      <section className="bg-white border border-stone-200 rounded-lg p-5">
        <div className="flex items-start gap-4 flex-wrap">
          <div className="flex items-start gap-2">
            <Globe size={14} className="text-stone-400 mt-0.5" />
            <div>
              <div className="text-sm font-medium flex items-center gap-1.5">
                <span>Account timezone</span>
                <InfoTip
                  content="The timezone Google Ads runs this account's rules in. Rule times (e.g. 'Daily at 8:00 AM') are interpreted in this zone. Set this once per account — usually Pacific for US accounts."
                />
              </div>
              <p className="text-xs text-stone-500 mt-0.5">
                The timezone Google Ads runs this account's rules in. All rule times below are
                interpreted in this zone.
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <select
              value={accountTz}
              onChange={(e) => onTimezoneChange(e.target.value)}
              className="px-3 py-1.5 text-xs border border-stone-300 rounded bg-white min-w-[220px]"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz.id} value={tz.id}>
                  {tz.label}
                </option>
              ))}
              {!TIMEZONES.find((t) => t.id === accountTz) && (
                <option value={accountTz}>{accountTz}</option>
              )}
            </select>
            <span className="text-[10px] text-stone-500 num">
              {accountAbbr}
              {!sameZone && ` · your local: ${localAbbr}`}
            </span>
          </div>
        </div>
      </section>

      {rules.length === 0 ? (
        <div className="bg-white border border-stone-200 rounded-lg p-8 text-center">
          <AlertCircle className="mx-auto text-stone-400 mb-2" size={24} />
          <p className="text-sm text-stone-600">No rules loaded yet.</p>
          <p className="text-xs text-stone-500 mt-1">Paste your rules export above to begin.</p>
        </div>
      ) : (
        <>
          {/* Stats */}
          <section className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <Stat label="Total" value={rules.length} />
            <Stat label="US" value={localeCounts.US || 0} />
            <Stat label="Countries" value={localeCounts.Countries || 0} />
            <Stat label="UK" value={localeCounts.UK || 0} />
            <Stat label="Other" value={localeCounts.Other || 0} />
          </section>

          {/* Filters */}
          <section className="bg-white border border-stone-200 rounded-lg p-3 flex flex-wrap gap-2 items-center">
            <div className="relative flex-1 min-w-[200px]">
              <Search
                size={12}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400"
              />
              <input
                type="text"
                value={filter.search}
                onChange={(e) => setFilter({ ...filter, search: e.target.value })}
                placeholder="Search by name or label…"
                className="w-full pl-7 pr-3 py-1.5 text-xs border border-stone-300 rounded"
              />
            </div>
            <select
              value={filter.locale}
              onChange={(e) => setFilter({ ...filter, locale: e.target.value })}
              className="px-2 py-1.5 text-xs border border-stone-300 rounded bg-white"
            >
              <option value="all">All locales</option>
              <option value="US">US</option>
              <option value="Countries">Countries</option>
              <option value="UK">UK</option>
              <option value="Other">Other</option>
            </select>
            <select
              value={filter.day}
              onChange={(e) => setFilter({ ...filter, day: e.target.value })}
              className="px-2 py-1.5 text-xs border border-stone-300 rounded bg-white"
            >
              <option value="all">All days</option>
              {DAY_NAMES.map((d, i) => (
                <option key={i} value={i}>
                  {d}
                </option>
              ))}
            </select>
            <span className="text-xs text-stone-500 ml-auto num">
              Showing {filtered.length} of {rules.length}
            </span>
          </section>

          {/* Rules table */}
          <section className="bg-white border border-stone-200 rounded-lg overflow-hidden">
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full text-xs">
                <thead className="bg-stone-100 text-stone-600 text-left">
                  <tr>
                    <th className="px-3 py-2 font-medium w-8"></th>
                    <th className="px-3 py-2 font-medium">
                      <span className="inline-flex items-center gap-1">
                        Locale
                        <InfoTip
                          content="Inferred from the rule's name prefix (OAD-, OAD UK-, OAD- Countries-). Just a filter — actual rule matching to a campaign uses labels, not this tag."
                        />
                      </span>
                    </th>
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Action</th>
                    <th className="px-3 py-2 font-medium">Cadence</th>
                    <th className="px-3 py-2 font-medium">Time ({accountAbbr})</th>
                    {!sameZone && (
                      <th className="px-3 py-2 font-medium">Time ({localAbbr})</th>
                    )}
                    <th className="px-3 py-2 font-medium">Labels</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <RuleRow
                      key={r.id}
                      rule={r}
                      expanded={expandedId === r.id}
                      onToggle={() => setExpandedId(expandedId === r.id ? null : r.id)}
                      accountTz={accountTz}
                      localTz={localTz}
                      showLocal={!sameZone}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tooltip }) {
  return (
    <div className="bg-white border border-stone-200 rounded-lg px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-stone-500 font-medium flex items-center gap-1">
        <span>{label}</span>
        {tooltip && <InfoTip content={tooltip} />}
      </div>
      <div className="text-lg num font-semibold mt-0.5">{value}</div>
    </div>
  );
}

function RuleRow({ rule, expanded, onToggle, accountTz, localTz, showLocal }) {
  const a = rule.action;
  const c = rule.cadence;
  const cadenceLabel = !c
    ? "—"
    : c.type === "daily"
    ? "Daily"
    : c.type === "weekly"
    ? c.days.length === 7
      ? "All days"
      : c.days.map((d) => DAY_SHORT[d]).join(", ")
    : "One time";

  const localTime = c?.time ? convertHHMM(c.time, accountTz, localTz) : "—";
  const expandedColspan = showLocal ? 7 : 6;

  return (
    <>
      <tr className="border-t border-stone-100 hover:bg-stone-50">
        <td className="px-3 py-2">
          <button onClick={onToggle} className="text-stone-400 hover:text-stone-700">
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        </td>
        <td className="px-3 py-2">
          <LocaleBadge locale={rule.locale} />
        </td>
        <td className="px-3 py-2 max-w-md">
          <div className="truncate" title={rule.name}>
            {rule.name}
          </div>
          <div className="text-[10px] text-stone-400 num">ID {rule.id}</div>
        </td>
        <td className="px-3 py-2">
          {a ? (
            <span
              className={`inline-flex items-center gap-1 num font-medium ${
                a.type === "increase" ? "text-emerald-700" : "text-rose-700"
              }`}
            >
              {a.type === "increase" ? "+" : "−"}
              {a.percent}%
            </span>
          ) : (
            "—"
          )}
        </td>
        <td className="px-3 py-2 text-stone-600">{cadenceLabel}</td>
        <td className="px-3 py-2 num text-stone-700">{c?.time || "—"}</td>
        {showLocal && (
          <td className="px-3 py-2 num text-stone-500">{localTime}</td>
        )}
        <td className="px-3 py-2">
          <div className="flex flex-wrap gap-1 max-w-md">
            {rule.labelsAny.slice(0, 2).map((l) => (
              <LabelChip key={l} label={l} />
            ))}
            {rule.labelsAny.length > 2 && (
              <span className="text-[10px] text-stone-500 self-center">
                +{rule.labelsAny.length - 2}
              </span>
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-stone-50">
          <td></td>
          <td colSpan={expandedColspan} className="px-3 py-3">
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1">
                {rule.labelsAny.map((l) => (
                  <LabelChip key={l} label={l} />
                ))}
              </div>
              <div className="text-[11px] text-stone-600 space-y-0.5">
                <div>
                  <span className="text-stone-400">Targets:</span> campaign status{" "}
                  <span className="num">{rule.statusTargets || "—"}</span>
                </div>
                {rule.campaignType && (
                  <div>
                    <span className="text-stone-400">Campaign type:</span> {rule.campaignType}
                  </div>
                )}
                {rule.owner && (
                  <div>
                    <span className="text-stone-400">Owner:</span> {rule.owner}
                  </div>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function LocaleBadge({ locale }) {
  const colors = {
    US: "bg-blue-50 text-blue-700 border-blue-200",
    UK: "bg-purple-50 text-purple-700 border-purple-200",
    Countries: "bg-amber-50 text-amber-800 border-amber-200",
    Other: "bg-stone-100 text-stone-600 border-stone-200",
  };
  return (
    <span
      className={`inline-block px-1.5 py-0.5 text-[10px] font-medium border rounded ${colors[locale]}`}
    >
      {locale}
    </span>
  );
}

function LabelChip({ label }) {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-stone-100 text-stone-700 rounded border border-stone-200">
      <Tag size={8} className="text-stone-400" />
      {label}
    </span>
  );
}

/* ============================================================
 *  SINGLE CAMPAIGN TAB
 * ============================================================ */

function SingleCampaignTab({ rules, knownLabels, accountTz, localTz }) {
  const now = useNow(30000);
  const acctNow = nowInTz(accountTz, now);
  const localNow = nowInTz(localTz, now);
  const accountAbbr = tzAbbrev(accountTz, now);
  const localAbbr = tzAbbrev(localTz, now);
  const sameZone = accountTz === localTz;

  const [name, setName] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [selectedLabels, setSelectedLabels] = useState([]);
  const [budget, setBudget] = useState("100");
  const [day, setDay] = useState(acctNow.day);

  const addLabel = (l) => {
    if (!selectedLabels.includes(l)) setSelectedLabels([...selectedLabels, l]);
    setLabelInput("");
  };
  const removeLabel = (l) => setSelectedLabels(selectedLabels.filter((x) => x !== l));

  const matchingLabels = useMemo(() => {
    if (!labelInput.trim()) return [];
    const s = labelInput.toLowerCase();
    return knownLabels.filter((l) => l.toLowerCase().includes(s) && !selectedLabels.includes(l)).slice(0, 8);
  }, [labelInput, knownLabels, selectedLabels]);

  const applicable = useMemo(
    () => rulesForDay(rules, selectedLabels, day),
    [rules, selectedLabels, day]
  );

  const startBudget = parseFloat(budget) || 0;
  const steps = useMemo(() => computeCurve(startBudget, applicable), [startBudget, applicable]);
  const eod = steps[steps.length - 1].budget;
  const totalDelta = eod - startBudget;
  const totalPct = startBudget > 0 ? (totalDelta / startBudget) * 100 : 0;

  const nowBudget = useMemo(() => budgetAtTime(steps, acctNow.hhmm), [steps, acctNow.hhmm]);
  const nowHour = acctNow.hour + acctNow.minute / 60;

  const chartData = useMemo(() => {
    const pts = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      pts.push({ hour: timeToHour(s.time), budget: s.budget, label: s.ruleName });
    }
    return pts;
  }, [steps]);

  const peak = useMemo(() => Math.max(...steps.map((s) => s.budget)), [steps]);
  const trough = useMemo(() => Math.min(...steps.map((s) => s.budget)), [steps]);

  return (
    <div className="space-y-6">
      <section className="bg-white border border-stone-200 rounded-lg p-5 grid grid-cols-1 md:grid-cols-12 gap-4">
        <div className="md:col-span-4">
          <label className="block text-xs font-medium text-stone-700 mb-1">Campaign name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="(optional)"
            className="w-full px-3 py-1.5 text-sm border border-stone-300 rounded"
          />
        </div>
        <div className="md:col-span-3">
          <label className="block text-xs font-medium text-stone-700 mb-1">Current budget</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400 text-sm">$</span>
            <input
              type="number"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              className="w-full pl-7 pr-3 py-1.5 text-sm num border border-stone-300 rounded"
            />
          </div>
        </div>
        <div className="md:col-span-3">
          <label className="block text-xs font-medium text-stone-700 mb-1">
            Day ({accountAbbr})
          </label>
          <select
            value={day}
            onChange={(e) => setDay(parseInt(e.target.value, 10))}
            className="w-full px-3 py-1.5 text-sm border border-stone-300 rounded bg-white"
          >
            {DAY_NAMES.map((d, i) => (
              <option key={i} value={i}>
                {d}
                {i === acctNow.day ? " (today)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="md:col-span-2 flex flex-col justify-end">
          <div className="text-[10px] uppercase tracking-wider text-stone-500 font-medium">
            Now
          </div>
          <div className="text-sm num font-medium">
            {acctNow.hhmm} <span className="text-[10px] text-stone-500">{accountAbbr}</span>
          </div>
          {!sameZone && (
            <div className="text-[10px] num text-stone-500">
              {localNow.hhmm} {localAbbr}
            </div>
          )}
        </div>
        <div className="md:col-span-12">
          <label className="block text-xs font-medium text-stone-700 mb-1">Labels</label>
          <div className="border border-stone-300 rounded p-2 min-h-[44px] flex flex-wrap gap-1 items-center bg-white">
            {selectedLabels.map((l) => (
              <span
                key={l}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-stone-900 text-white rounded"
              >
                {l}
                <button
                  onClick={() => removeLabel(l)}
                  className="text-stone-400 hover:text-white ml-0.5"
                >
                  ×
                </button>
              </span>
            ))}
            <input
              type="text"
              value={labelInput}
              onChange={(e) => setLabelInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && labelInput.trim()) {
                  addLabel(labelInput.trim());
                }
              }}
              placeholder={selectedLabels.length === 0 ? "Start typing to find labels…" : "+ add label"}
              className="flex-1 min-w-[200px] text-xs outline-none"
            />
          </div>
          {matchingLabels.length > 0 && (
            <div className="mt-1 border border-stone-200 rounded bg-white max-h-40 overflow-y-auto scrollbar-thin">
              {matchingLabels.map((l) => (
                <button
                  key={l}
                  onClick={() => addLabel(l)}
                  className="block w-full text-left px-3 py-1.5 text-xs hover:bg-stone-50"
                >
                  {l}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {selectedLabels.length === 0 ? (
        <div className="bg-white border border-stone-200 rounded-lg p-8 text-center">
          <p className="text-sm text-stone-600">Add at least one label to see calculations.</p>
        </div>
      ) : (
        <>
          {/* Summary stats */}
          <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat
              label="Start of day"
              value={`$${fmtMoney(startBudget)}`}
              tooltip="Your input budget — the value at 00:00 in account time, before any of today's rules have fired."
            />
            <Stat
              label={`Now (${acctNow.hhmm} ${accountAbbr})`}
              value={`$${fmtMoney(nowBudget)}`}
              tooltip="The budget after every rule with a time at or before the current account-time has fired today."
            />
            <Stat
              label="End of day"
              value={`$${fmtMoney(eod)}`}
              tooltip="The budget after every rule for the selected day has fired. For US weekday campaigns the 23:45 rule resets the budget down by 65%, which is why EOD can be much lower than the daytime peak."
            />
            <div className="bg-white border border-stone-200 rounded-lg px-4 py-3">
              <div className="text-[10px] uppercase tracking-wider text-stone-500 font-medium flex items-center gap-1">
                <span>Net change (EOD)</span>
                <InfoTip content="Total change from Start of day to End of day, in dollars and percent." />
              </div>
              <div
                className={`text-lg num font-semibold mt-0.5 ${
                  totalDelta >= 0 ? "text-emerald-700" : "text-rose-700"
                }`}
              >
                {totalDelta >= 0 ? "+" : ""}${fmtMoney(totalDelta)}{" "}
                <span className="text-xs">({totalPct >= 0 ? "+" : ""}{totalPct.toFixed(2)}%)</span>
              </div>
            </div>
            <Stat
              label="Rules fired"
              value={applicable.length}
              tooltip="Number of rules that match this campaign's labels for the selected day."
            />
          </section>

          {/* Chart */}
          <section className="bg-white border border-stone-200 rounded-lg p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium">
                Budget curve · {DAY_NAMES[day]} ({accountAbbr})
              </h3>
              <div className="flex items-center gap-3 text-[11px] text-stone-500">
                <span className="num">Peak ${fmtMoney(peak)}</span>
                <span className="num">Trough ${fmtMoney(trough)}</span>
              </div>
            </div>
            <div style={{ width: "100%", height: 280 }}>
              <ResponsiveContainer>
                <LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 5, left: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke="#e7e5e4" />
                  <XAxis
                    dataKey="hour"
                    type="number"
                    domain={[0, 24]}
                    ticks={[0, 3, 6, 9, 12, 15, 18, 21, 24]}
                    tickFormatter={(h) => `${String(h).padStart(2, "0")}:00`}
                    tick={{ fontSize: 10, fill: "#78716c" }}
                    stroke="#d6d3d1"
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: "#78716c" }}
                    stroke="#d6d3d1"
                    tickFormatter={(v) => `$${v.toFixed(0)}`}
                  />
                  <ChartTooltip
                    contentStyle={{
                      fontSize: 11,
                      borderRadius: 4,
                      border: "1px solid #d6d3d1",
                      padding: "6px 8px",
                    }}
                    formatter={(v) => [`$${fmtMoney(v)}`, "Budget"]}
                    labelFormatter={(h) => {
                      const hh = Math.floor(h);
                      const mm = Math.round((h - hh) * 60);
                      return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")} ${accountAbbr}`;
                    }}
                  />
                  <ReferenceLine
                    x={nowHour}
                    stroke="#dc2626"
                    strokeWidth={1.5}
                    strokeDasharray="3 3"
                    label={{
                      value: `Now ${acctNow.hhmm}`,
                      position: "top",
                      fill: "#dc2626",
                      fontSize: 10,
                    }}
                  />
                  <Line
                    type="stepAfter"
                    dataKey="budget"
                    stroke={ACCENT}
                    strokeWidth={2}
                    dot={{ r: 3, fill: ACCENT, strokeWidth: 0 }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* Step ledger */}
          <section className="bg-white border border-stone-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3 border-b border-stone-200">
              <h3 className="text-sm font-medium">Rule ledger</h3>
              <p className="text-xs text-stone-500 mt-0.5">
                Each rule applied to the previous result, in chronological order.
              </p>
            </div>
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full text-xs">
                <thead className="bg-stone-50 text-stone-600 text-left">
                  <tr>
                    <th className="px-4 py-2 font-medium w-20">Time ({accountAbbr})</th>
                    {!sameZone && (
                      <th className="px-4 py-2 font-medium w-20">Time ({localAbbr})</th>
                    )}
                    <th className="px-4 py-2 font-medium">Rule</th>
                    <th className="px-4 py-2 font-medium text-right w-24">Change</th>
                    <th className="px-4 py-2 font-medium text-right w-28">Before</th>
                    <th className="px-4 py-2 font-medium text-right w-28">After</th>
                  </tr>
                </thead>
                <tbody>
                  {steps.map((s, idx) => {
                    const isStart = idx === 0;
                    const isEnd = idx === steps.length - 1;
                    const localT = convertHHMM(s.time, accountTz, localTz);
                    return (
                      <tr key={idx} className="border-t border-stone-100">
                        <td className="px-4 py-2 num text-stone-700">{s.time}</td>
                        {!sameZone && (
                          <td className="px-4 py-2 num text-stone-500">{localT}</td>
                        )}
                        <td className="px-4 py-2">
                          {isStart || isEnd ? (
                            <span className="text-stone-500 italic">{s.ruleName}</span>
                          ) : (
                            <div>
                              <div className="text-stone-800">{s.ruleName}</div>
                              <div className="text-[10px] text-stone-400 num">ID {s.ruleId}</div>
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right num">
                          {s.action ? (
                            <span
                              className={
                                s.action.type === "increase" ? "text-emerald-700" : "text-rose-700"
                              }
                            >
                              {s.action.type === "increase" ? "+" : "−"}
                              {s.action.percent}%
                            </span>
                          ) : (
                            <span className="text-stone-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right num text-stone-500">
                          {s.before !== null ? `$${fmtMoney(s.before)}` : "—"}
                        </td>
                        <td className="px-4 py-2 text-right num font-medium">
                          ${fmtMoney(s.budget)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/* ============================================================
 *  BULK REPORT TAB
 * ============================================================ */

const SAMPLE_BULK = `name,current_budget,labels
US Mobile Test,100,CG YouTube US- MOB;CG YouTube - Shorts
UK Mobile,90,CG YouTube UK- MOB
Countries IOS,75,CG - YouTube Countries IOS Test;CG- Demand Gen- Cold Traffic- Countries`;

// Standards-compliant CSV line parser: handles quoted fields, commas
// inside quotes, and "" as an escaped quote.
function parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        result.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result.map((s) => s.trim());
}

function parseBulkInput(text) {
  // Strip UTF-8 BOM if present (Excel/Google Ads exports often include one)
  const cleaned = text.replace(/^\uFEFF/, "");
  const lines = cleaned
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());

  if (lines.length === 0) return { rows: [], format: "empty" };

  // Try to find a header row in the first 5 lines.
  let headerIdx = -1;
  let format = "unknown";
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const lower = lines[i].toLowerCase();
    if (
      lower.includes("campaign status") &&
      lower.includes("budget") &&
      lower.includes("label")
    ) {
      headerIdx = i;
      format = "google-ads";
      break;
    }
    if (lower.includes("name") && lower.includes("budget")) {
      headerIdx = i;
      format = "simple";
      break;
    }
  }

  let nameIdx, budgetIdx, labelsIdx, startIdx;

  if (headerIdx >= 0) {
    const headerCells = parseCsvLine(lines[headerIdx]).map((h) => h.toLowerCase());
    if (format === "google-ads") {
      nameIdx = headerCells.indexOf("campaign");
      budgetIdx = headerCells.indexOf("budget");
      labelsIdx = headerCells.indexOf("label");
    } else {
      nameIdx = headerCells.findIndex((h) => h.includes("name"));
      budgetIdx = headerCells.findIndex((h) => h.includes("budget"));
      labelsIdx = headerCells.findIndex((h) => h.includes("label"));
    }
    startIdx = headerIdx + 1;
  } else {
    // No header detected — assume positional simple format
    nameIdx = 0;
    budgetIdx = 1;
    labelsIdx = 2;
    startIdx = 0;
    format = "positional";
  }

  if (nameIdx < 0 || budgetIdx < 0 || labelsIdx < 0) {
    return { rows: [], format };
  }

  const rows = [];
  let skipped = 0;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    // Skip Google Ads total/subtotal rows
    if (/^total:/i.test(line.trim())) continue;

    const cells = parseCsvLine(line);
    if (cells.length < Math.max(nameIdx, budgetIdx, labelsIdx) + 1) {
      skipped++;
      continue;
    }

    const name = cells[nameIdx];
    if (!name || name === "--" || /^total:/i.test(name)) {
      skipped++;
      continue;
    }

    const budgetRaw = (cells[budgetIdx] || "").replace(/[^\d.\-]/g, "");
    const budget = parseFloat(budgetRaw);
    if (!Number.isFinite(budget) || budget <= 0) {
      skipped++;
      continue;
    }

    const labels = (cells[labelsIdx] || "")
      .split(/[;|]/)
      .map((s) => s.trim())
      .filter(Boolean);

    rows.push({ name, budget, labels });
  }

  return { rows, format, skipped };
}

function BulkReportTab({ rules, accountTz, localTz }) {
  const now = useNow(30000);
  const acctNow = nowInTz(accountTz, now);
  const accountAbbr = tzAbbrev(accountTz, now);

  const [input, setInput] = useState(SAMPLE_BULK);
  const [day, setDay] = useState(acctNow.day);
  const [uploadError, setUploadError] = useState(null);
  const [uploadedName, setUploadedName] = useState(null);
  const fileInputRef = useRef(null);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setInput(text);
      setUploadedName(file.name);
      setUploadError(null);
    } catch (err) {
      setUploadError("Could not read that file. Make sure it's a plain CSV.");
    }
    e.target.value = ""; // allow re-uploading the same file
  };

  const parseResult = useMemo(() => parseBulkInput(input), [input]);
  const rows = parseResult.rows;
  const detectedFormat = parseResult.format;
  const skipped = parseResult.skipped || 0;
  const results = useMemo(() => {
    return rows.map((row) => {
      const applicable = rulesForDay(rules, row.labels, day);
      const steps = computeCurve(row.budget, applicable);
      const eod = steps[steps.length - 1].budget;
      const nowBudget = budgetAtTime(steps, acctNow.hhmm);
      return {
        ...row,
        eod,
        nowBudget,
        delta: eod - row.budget,
        deltaPct: row.budget > 0 ? ((eod - row.budget) / row.budget) * 100 : 0,
        rulesFired: applicable.length,
        steps,
      };
    });
  }, [rows, rules, day, acctNow.hhmm]);

  const exportCsv = () => {
    const header = "name,current_budget,budget_now,eod_budget,delta,delta_pct,rules_fired";
    const lines = results.map(
      (r) =>
        `${r.name},${r.budget.toFixed(2)},${r.nowBudget.toFixed(2)},${r.eod.toFixed(
          2
        )},${r.delta.toFixed(2)},${r.deltaPct.toFixed(2)},${r.rulesFired}`
    );
    const csv = [header, ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `budget-report-${DAY_SHORT[day].toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalCurrent = results.reduce((sum, r) => sum + r.budget, 0);
  const totalNow = results.reduce((sum, r) => sum + r.nowBudget, 0);
  const totalEod = results.reduce((sum, r) => sum + r.eod, 0);

  return (
    <div className="space-y-6">
      <section className="bg-white border border-stone-200 rounded-lg p-5">
        <div className="flex items-start justify-between mb-3 gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-medium">Campaigns input</h3>
            <p className="text-xs text-stone-500 mt-0.5 flex items-center gap-1 flex-wrap">
              <span>
                CSV format. Header: <span className="mono">name,current_budget,labels</span>.
                Labels separated by <span className="mono">;</span> or <span className="mono">|</span>.
              </span>
              <InfoTip
                content="Labels themselves often contain commas (e.g. 'CG- Demand Gen- Cold Traffic- US'), so the labels field uses ; or | as its internal separator to avoid breaking the CSV."
              />
            </p>
            {uploadedName && (
              <p className="text-xs text-emerald-700 mt-1 flex items-center gap-1">
                <CheckCircle2 size={12} />
                Loaded {uploadedName}
              </p>
            )}
            {rows.length > 0 && (
              <p className="text-[11px] text-stone-500 mt-1 flex items-center gap-1.5 flex-wrap">
                <span>
                  Detected{" "}
                  <span className="text-stone-700 font-medium">
                    {detectedFormat === "google-ads"
                      ? "Google Ads campaign report"
                      : detectedFormat === "simple"
                      ? "simple CSV"
                      : detectedFormat === "positional"
                      ? "positional CSV (no header)"
                      : "unknown format"}
                  </span>
                </span>
                <span className="text-stone-300">·</span>
                <span className="num">{rows.length}</span>
                <span>campaign{rows.length === 1 ? "" : "s"} parsed</span>
                {skipped > 0 && (
                  <>
                    <span className="text-stone-300">·</span>
                    <span className="num text-stone-500">{skipped}</span>
                    <span className="text-stone-500">row{skipped === 1 ? "" : "s"} skipped</span>
                  </>
                )}
              </p>
            )}
            {uploadError && (
              <p className="text-xs text-rose-700 mt-1 flex items-center gap-1">
                <AlertCircle size={12} />
                {uploadError}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              className="hidden"
              onChange={handleFile}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-1.5 text-xs border border-stone-300 rounded hover:bg-stone-50 flex items-center gap-1"
            >
              <Upload size={12} />
              Upload CSV
            </button>
            <select
              value={day}
              onChange={(e) => setDay(parseInt(e.target.value, 10))}
              className="px-3 py-1.5 text-xs border border-stone-300 rounded bg-white"
            >
              {DAY_NAMES.map((d, i) => (
                <option key={i} value={i}>
                  {d}
                  {i === acctNow.day ? " (today)" : ""}
                </option>
              ))}
            </select>
          </div>
        </div>
        <textarea
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setUploadedName(null);
          }}
          className="w-full h-40 px-3 py-2 text-xs mono border border-stone-300 rounded bg-stone-50 focus:outline-none focus:ring-1 focus:ring-stone-400 scrollbar-thin"
        />
      </section>

      {results.length === 0 ? (
        <div className="bg-white border border-stone-200 rounded-lg p-8 text-center text-sm text-stone-600">
          No campaigns parsed yet.
        </div>
      ) : (
        <>
          <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat label="Campaigns" value={results.length} />
            <Stat label="Total current" value={`$${fmtMoney(totalCurrent)}`} />
            <Stat
              label={`Total at ${acctNow.hhmm} ${accountAbbr}`}
              value={`$${fmtMoney(totalNow)}`}
            />
            <Stat label="Total EOD" value={`$${fmtMoney(totalEod)}`} />
            <div className="bg-white border border-stone-200 rounded-lg px-4 py-3">
              <div className="text-[10px] uppercase tracking-wider text-stone-500 font-medium">
                Net (EOD)
              </div>
              <div
                className={`text-lg num font-semibold mt-0.5 ${
                  totalEod - totalCurrent >= 0 ? "text-emerald-700" : "text-rose-700"
                }`}
              >
                {totalEod - totalCurrent >= 0 ? "+" : ""}${fmtMoney(totalEod - totalCurrent)}
              </div>
            </div>
          </section>

          <section className="bg-white border border-stone-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
              <h3 className="text-sm font-medium">
                Report · {DAY_NAMES[day]} ({accountAbbr})
              </h3>
              <button
                onClick={exportCsv}
                className="px-3 py-1 text-xs border border-stone-300 rounded hover:bg-stone-50 flex items-center gap-1"
              >
                <Download size={12} />
                Export CSV
              </button>
            </div>
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full text-xs">
                <thead className="bg-stone-50 text-stone-600 text-left">
                  <tr>
                    <th className="px-4 py-2 font-medium">Campaign</th>
                    <th className="px-4 py-2 font-medium text-right">Current</th>
                    <th className="px-4 py-2 font-medium text-right">
                      <span className="inline-flex items-center gap-1 justify-end">
                        At {acctNow.hhmm}
                        <InfoTip
                          content="Budget at the current account-time on the selected day. Useful for spot-checking what the budget should be right now vs. what's actually set in Google Ads."
                          side="left"
                        />
                      </span>
                    </th>
                    <th className="px-4 py-2 font-medium text-right">EOD</th>
                    <th className="px-4 py-2 font-medium text-right">Δ EOD</th>
                    <th className="px-4 py-2 font-medium text-right">Δ %</th>
                    <th className="px-4 py-2 font-medium text-right">Rules</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, idx) => (
                    <tr key={idx} className="border-t border-stone-100 hover:bg-stone-50">
                      <td className="px-4 py-2">
                        <div className="text-stone-800">{r.name}</div>
                        <div className="text-[10px] text-stone-400 truncate max-w-xs">
                          {r.labels.join(" · ")}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right num text-stone-600">
                        ${fmtMoney(r.budget)}
                      </td>
                      <td className="px-4 py-2 text-right num text-stone-800">
                        ${fmtMoney(r.nowBudget)}
                      </td>
                      <td className="px-4 py-2 text-right num font-medium">${fmtMoney(r.eod)}</td>
                      <td
                        className={`px-4 py-2 text-right num ${
                          r.delta >= 0 ? "text-emerald-700" : "text-rose-700"
                        }`}
                      >
                        {r.delta >= 0 ? "+" : ""}${fmtMoney(r.delta)}
                      </td>
                      <td
                        className={`px-4 py-2 text-right num ${
                          r.deltaPct >= 0 ? "text-emerald-700" : "text-rose-700"
                        }`}
                      >
                        {r.deltaPct >= 0 ? "+" : ""}
                        {r.deltaPct.toFixed(2)}%
                      </td>
                      <td className="px-4 py-2 text-right num text-stone-500">{r.rulesFired}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export default App;

/* ============================================================
 *  DOCS TAB
 * ============================================================ */

const DOC_SECTIONS = [
  { id: "doc-start", title: "Quick start" },
  { id: "doc-accounts", title: "Accounts" },
  { id: "doc-rules", title: "Loading rules" },
  { id: "doc-timezones", title: "Timezones" },
  { id: "doc-single", title: "Single Campaign" },
  { id: "doc-bulk", title: "Bulk Report" },
  { id: "doc-math", title: "How rules compound" },
  { id: "doc-edge", title: "Assumptions & edge cases" },
  { id: "doc-storage", title: "Storage & privacy" },
];

function DocsTab() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-8">
      <aside className="md:sticky md:top-4 md:self-start">
        <div className="text-[10px] uppercase tracking-wider text-stone-500 font-medium mb-2 px-2">
          On this page
        </div>
        <nav className="space-y-0.5">
          {DOC_SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="block py-1 px-2 text-xs text-stone-600 hover:text-stone-900 hover:bg-stone-100 rounded transition-colors"
            >
              {s.title}
            </a>
          ))}
        </nav>
      </aside>

      <article className="max-w-3xl space-y-10 text-stone-800">
        <DocSection id="doc-start" title="Quick start">
          <p>
            This tool calculates Google Ads campaign budgets based on the chain of automated rules
            you have running. Three steps to get going:
          </p>
          <ol className="list-decimal pl-5 space-y-1.5 text-sm leading-relaxed">
            <li>
              Open the <DocLink>Rules</DocLink> tab and paste your One &amp; Done rules export
              into the "Paste rules export" panel, then hit <em>Parse and replace</em>.
            </li>
            <li>
              In the same tab, set the <em>Account timezone</em> to whatever zone Google Ads runs
              your rules in (usually Pacific for US accounts).
            </li>
            <li>
              Go to <DocLink>Single Campaign</DocLink> for a one-off calculation, or{" "}
              <DocLink>Bulk Report</DocLink> to run many campaigns at once.
            </li>
          </ol>
        </DocSection>

        <DocSection id="doc-accounts" title="Accounts">
          <p>
            Each tab in the account bar (above the main navigation) holds its own rules and
            timezone. Use accounts to manage multiple Google Ads accounts side by side.
          </p>
          <ul className="space-y-1.5 text-sm leading-relaxed list-disc pl-5">
            <li>
              <strong>Add</strong> — click <span className="mono text-xs">+ Account</span> at the
              right of the account bar.
            </li>
            <li>
              <strong>Rename</strong> — click the active account's name, or double-click any
              account. Enter to save, Esc to cancel.
            </li>
            <li>
              <strong>Delete</strong> — hover an account and click the × that appears.
            </li>
            <li>
              <strong>Switch</strong> — click any non-active account. The calculator's form state
              (selected labels, bulk input) resets so nothing leaks across accounts.
            </li>
          </ul>
        </DocSection>

        <DocSection id="doc-rules" title="Loading rules">
          <p>
            In Google Ads, export the full text of your automated rules (the same format you'd see
            in the rule history) and paste it into the Rules tab. The parser splits rules
            automatically using the <span className="mono text-xs">Only if there are errors</span>{" "}
            + ID marker at the bottom of each block, so you can paste the entire export at once.
          </p>
          <p>
            Pasting and parsing <em>replaces</em> the rules for the active account — it's destructive
            on purpose so your stored ruleset always matches what's in Google Ads. Re-paste any time
            the rules change.
          </p>
          <p>
            The parser extracts each rule's action percentage, target labels, cadence (daily or
            weekly + which days), time, and status. Locale (US / UK / Countries) is inferred from the
            rule's name prefix — but rule <em>matching</em> in calculations uses labels, not the
            locale tag.
          </p>
        </DocSection>

        <DocSection id="doc-timezones" title="Timezones">
          <p>
            Two timezones matter:
          </p>
          <ul className="space-y-1.5 text-sm leading-relaxed list-disc pl-5">
            <li>
              <strong>Account timezone</strong> — where Google Ads runs the rules. Configurable per
              account in the Rules tab. Default is Pacific.
            </li>
            <li>
              <strong>Your local timezone</strong> — picked up automatically from your computer.
            </li>
          </ul>
          <p>
            When the two differ, rule times appear in both zones throughout the app. The live
            clock in the header always shows account time first, your local time second. DST is
            handled automatically — the abbreviation (e.g. PST → PDT) updates on its own.
          </p>
        </DocSection>

        <DocSection id="doc-single" title="Single Campaign">
          <p>Enter what you have:</p>
          <ul className="space-y-1.5 text-sm leading-relaxed list-disc pl-5">
            <li>
              <strong>Campaign name</strong> — optional, just for your reference.
            </li>
            <li>
              <strong>Current budget</strong> — the daily budget set in Google Ads right now,
              before today's rules fire.
            </li>
            <li>
              <strong>Day</strong> — defaults to today (in account time). Pick another day to
              preview that day's curve.
            </li>
            <li>
              <strong>Labels</strong> — every Google Ads label attached to the campaign. Type to
              search; existing labels from your rules autocomplete. Press Enter to add a custom
              label.
            </li>
          </ul>
          <p>You get back:</p>
          <ul className="space-y-1.5 text-sm leading-relaxed list-disc pl-5">
            <li>
              <strong>Start of day</strong> — your input budget at 00:00 in account time.
            </li>
            <li>
              <strong>Now (HH:MM)</strong> — budget after all rules with time ≤ the current account
              time have fired.
            </li>
            <li>
              <strong>End of day</strong> — budget after every rule for the selected day has
              fired.
            </li>
            <li>
              <strong>Budget curve</strong> — 24h stepped chart, with a red dashed line marking the
              current moment.
            </li>
            <li>
              <strong>Rule ledger</strong> — every rule fire in chronological order, with the
              before/after value at each step.
            </li>
          </ul>
        </DocSection>

        <DocSection id="doc-bulk" title="Bulk Report">
          <p>
            Run any number of campaigns through the same calculation in one go. Three formats are
            supported — the parser auto-detects which one you've given it:
          </p>
          <ul className="space-y-1.5 text-sm leading-relaxed list-disc pl-5">
            <li>
              <strong>Google Ads campaign report</strong> — the raw CSV export from Google Ads
              (with the <span className="mono text-xs">Campaign report</span> title row and{" "}
              <span className="mono text-xs">Total: ...</span> summary rows). Just upload it
              as-is; the parser pulls the Campaign, Budget, and Label columns and skips the
              metadata and totals.
            </li>
            <li>
              <strong>Simple CSV</strong> — three columns:{" "}
              <span className="mono text-xs">name,current_budget,labels</span>.
            </li>
            <li>
              <strong>Positional</strong> — same three columns but no header row.
            </li>
          </ul>
          <p>
            Two ways to load them: click <em>Upload CSV</em> to pick a file from your computer, or
            paste CSV text directly into the textarea.
          </p>
          <p>Example simple format:</p>
          <pre className="mono text-[11px] bg-stone-100 text-stone-800 rounded p-3 overflow-x-auto scrollbar-thin border border-stone-200">
{`name,current_budget,labels
US Mobile Test,100,CG YouTube US- MOB;CG YouTube - Shorts
UK Mobile,90,CG YouTube UK- MOB
Countries IOS,75,CG - YouTube Countries IOS Test;CG- Demand Gen- Cold Traffic- Countries`}
          </pre>
          <p>
            Labels within a single campaign are separated by <span className="mono text-xs">;</span>{" "}
            or <span className="mono text-xs">|</span> because labels themselves often contain
            commas. Google Ads exports always use <span className="mono text-xs">;</span>.
          </p>
          <p>
            Below the input area you'll see a small line confirming what format was detected and
            how many campaigns were parsed. The output table shows current budget, budget at the
            current moment, EOD budget, the delta from start to EOD, and how many rules matched.
            Click <em>Export CSV</em> to download it.
          </p>
        </DocSection>

        <DocSection id="doc-math" title="How rules compound">
          <p>
            Each rule applies its percentage to whatever the budget is{" "}
            <em>when the rule fires</em> — not to the original starting budget. Example chain for
            a US weekday campaign starting at $100:
          </p>
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-xs border border-stone-200 rounded">
              <thead className="bg-stone-50 text-stone-600 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium">Time</th>
                  <th className="px-3 py-2 font-medium">Rule</th>
                  <th className="px-3 py-2 font-medium text-right">Budget</th>
                </tr>
              </thead>
              <tbody className="num">
                {[
                  ["00:00", "Start", "$100.00"],
                  ["03:45", "+100%", "$200.00"],
                  ["04:00", "+6.43%", "$212.86"],
                  ["05:00", "+12.75%", "$240.00"],
                  ["…", "…", "…"],
                  ["23:45", "−65%", "$84.00"],
                ].map(([t, r, b], i) => (
                  <tr key={i} className="border-t border-stone-100">
                    <td className="px-3 py-1.5 text-stone-700">{t}</td>
                    <td className="px-3 py-1.5 text-stone-700">{r}</td>
                    <td className="px-3 py-1.5 text-right font-medium">{b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            <strong>Source of truth:</strong> the calculator always uses the rule's <em>action</em>{" "}
            percentage ("Decrease campaign budget by 1.96%"), not the percentage written into the
            rule name — these have drifted apart for some rules.
          </p>
        </DocSection>

        <DocSection id="doc-edge" title="Assumptions & edge cases">
          <ul className="space-y-2 text-sm leading-relaxed list-disc pl-5">
            <li>
              <strong>"Enabled, Paused"</strong> in <em>Campaign status</em> means the rule targets
              campaigns whose status is Enabled or Paused — not that the rule itself is paused. All
              such rules are treated as active.
            </li>
            <li>
              <strong>One-time rules</strong> (e.g. a single scheduled budget change for a past
              date) are visible in the Rules tab but excluded from daily calculations.
            </li>
            <li>
              <strong>Locale tag</strong> is inferred from the rule's name prefix — it's a filter,
              not part of the matching logic. Calculations match campaigns to rules purely by
              label intersection.
            </li>
            <li>
              <strong>23:45 reset</strong> on US weekday rules decreases the budget by 65%. If a
              campaign matches this rule, the EOD value will be substantially below the daytime
              peak — that's by design in Google Ads, not a bug in the calculator.
            </li>
            <li>
              <strong>Chains by label subset</strong> — different campaigns can follow different
              rule chains because rules target different label combinations. Two campaigns in the
              same locale can have completely different EOD outcomes if their label sets diverge.
            </li>
          </ul>
        </DocSection>

        <DocSection id="doc-storage" title="Storage & privacy">
          <p>
            Rules, account names, account timezones, and the active account are all stored in your
            browser only. Nothing is sent to any server. Clearing your browser storage will reset
            the app to empty.
          </p>
          <p>
            To clear rules for a single account, use <em>Clear stored rules</em> at the bottom of
            the paste card in the Rules tab. To remove a whole account, hover the account tab and
            click the × button.
          </p>
        </DocSection>
      </article>
    </div>
  );
}

function DocSection({ id, title, children }) {
  return (
    <section id={id} className="scroll-mt-4">
      <h2 className="text-base font-semibold tracking-tight mb-3 pb-2 border-b border-stone-200">
        {title}
      </h2>
      <div className="space-y-3 text-sm leading-relaxed">{children}</div>
    </section>
  );
}

function DocLink({ children }) {
  return (
    <span className="inline-block px-1.5 py-0.5 text-[11px] mono bg-stone-100 text-stone-800 rounded border border-stone-200">
      {children}
    </span>
  );
}
