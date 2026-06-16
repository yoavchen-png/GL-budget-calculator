import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip as ChartTooltip,
  ResponsiveContainer,
  ReferenceLine,
  CartesianGrid,
} from "recharts";

const ACCENT = "#2563eb";

// Recharts is by far the heaviest dependency in the app and is only needed on
// the Single Campaign tab. Keeping it in its own module lets App.jsx lazy-load
// it, so it stays out of the initial bundle and first paint is much faster.
export default function BudgetChart({ chartData, nowHour, acctNow, accountAbbr, fmtMoney }) {
  return (
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
  );
}
