import { useState, useEffect, useCallback } from "react";

// ─── SECURITY: Rate limiting (max 5 AI requests per minute) ───
const _rl = { log: [], max: 5, window: 60000 };
function checkRateLimit() {
  const now = Date.now();
  _rl.log = _rl.log.filter(t => now - t < _rl.window);
  if (_rl.log.length >= _rl.max) return false;
  _rl.log.push(now);
  return true;
}

// ─── SECURITY: Input validation ───
function validateRoute(origin, destination) {
  if (!origin || !destination) return "Origin and destination are required";
  if (origin.length > 100 || destination.length > 100) return "Input too long (max 100 chars)";
  if (origin.length < 2 || destination.length < 2) return "Input too short";
  const forbidden = /<script|javascript:|on\w+=/i;
  if (forbidden.test(origin) || forbidden.test(destination)) return "Invalid input detected";
  return null;
}

// ─── MOCK DATA ENGINE ───
function generateRouteData(origin, destination) {
  const seed = (origin + destination).split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const rand = (min, max, s = seed) => min + ((s * 9301 + 49297) % 233280) / 233280 * (max - min);
  const distA = Math.round(rand(200, 1800));
  const distB = Math.round(distA * rand(1.05, 1.25));
  const weatherRisk = Math.round(rand(10, 85));
  const trafficRisk = Math.round(rand(10, 90));
  const borderRisk = Math.round(rand(5, 75));
  const fuelPrice = 1.2;

  const etaBase = distA / 80;
  const weatherAdd = weatherRisk > 60 ? rand(0.5, 2) : rand(0, 0.5);
  const trafficAdd = trafficRisk > 60 ? rand(0.5, 1.5) : rand(0, 0.4);
  const borderAdd = borderRisk > 50 ? rand(1, 3) : rand(0.2, 1);
  const etaTotal = etaBase + weatherAdd + trafficAdd + borderAdd;

  const etaBaseB = distB / 80;
  const etaTotalB = etaBaseB + weatherAdd * 0.8 + trafficAdd * 0.6 + borderAdd * 1.2;

  const scoreA = Math.round(100 - (weatherRisk * 0.2 + trafficRisk * 0.2 + borderRisk * 0.15 + (etaTotal / 24) * 10));
  const scoreB = Math.round(scoreA - rand(5, 20));

  const fuelA = (distA / 100) * 35 * fuelPrice;
  const fuelB = (distB / 100) * 35 * fuelPrice;

  const riskScore = Math.round((weatherRisk + trafficRisk + borderRisk) / 3);

  const departureBest = rand(5, 10) > 7 ? "06:00" : "08:00";
  const departureSafe = "10:00";
  const departureFast = "05:30";

  const alerts = [];
  if (weatherRisk > 60) alerts.push({ type: "Weather Alert", msg: "Heavy rain expected along route segment 2", severity: "warning" });
  if (weatherRisk > 80) alerts.push({ type: "Storm Risk", msg: "Storm conditions possible — consider delay", severity: "critical" });
  if (trafficRisk > 65) alerts.push({ type: "Traffic Alert", msg: "High congestion near destination city center", severity: "warning" });
  if (borderRisk > 55) alerts.push({ type: "Border Alert", msg: "Increased wait times at border crossing", severity: "warning" });
  if (borderRisk > 75) alerts.push({ type: "Border Alert", msg: "Critical congestion at border — 3h+ expected", severity: "critical" });
  if (alerts.length === 0) alerts.push({ type: "All Clear", msg: "No significant alerts for this route", severity: "info" });

  return {
    routeA: { name: "Route A (Recommended)", distance: distA, eta: etaTotal, risk: riskScore, fuel: fuelA, score: scoreA, weatherRisk, trafficRisk, borderRisk, etaBase, weatherAdd, trafficAdd, borderAdd },
    routeB: { name: "Route B (Alternative)", distance: distB, eta: etaTotalB, risk: Math.round(riskScore * 0.85), fuel: fuelB, score: scoreB, weatherRisk: Math.round(weatherRisk * 0.8), trafficRisk: Math.round(trafficRisk * 0.7), borderRisk: Math.round(borderRisk * 1.1), etaBase: etaBaseB, weatherAdd: weatherAdd * 0.8, trafficAdd: trafficAdd * 0.6, borderAdd: borderAdd * 1.2 },
    departure: { best: departureBest, safe: departureSafe, fast: departureFast },
    alerts,
    weather: { temp: Math.round(rand(5, 35)), condition: weatherRisk > 70 ? "Heavy Rain" : weatherRisk > 40 ? "Cloudy" : "Clear", wind: Math.round(rand(5, 45)), rain: weatherRisk > 50 },
    traffic: { level: trafficRisk > 65 ? "High" : trafficRisk > 35 ? "Medium" : "Low", delay: Math.round(trafficAdd * 60), segments: ["City center exit", "Highway junction 4", "Industrial zone"] },
    border: { waitTime: Math.round(borderAdd * 60), congestion: borderRisk > 65 ? "High" : borderRisk > 35 ? "Medium" : "Low", delayProb: Math.round(borderRisk) }
  };
}

function fmtTime(hours) {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}h ${m}m`;
}

function RiskBadge({ value, label }) {
  const color = value > 65 ? "#ef4444" : value > 35 ? "#f59e0b" : "#22c55e";
  const text = value > 65 ? "High" : value > 35 ? "Medium" : "Low";
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
      <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 13 }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 80, height: 6, background: "rgba(255,255,255,0.1)", borderRadius: 3, overflow: "hidden" }}>
          <div style={{ width: `${value}%`, height: "100%", background: color, borderRadius: 3 }} />
        </div>
        <span style={{ color, fontSize: 12, fontWeight: 700, width: 40 }}>{text}</span>
      </div>
    </div>
  );
}

function KPI({ label, value, sub, color = "#00ff9d", icon }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, padding: "18px 20px" }}>
      <div style={{ fontSize: 20, marginBottom: 4 }}>{icon}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function ScoreRing({ score, size = 80 }) {
  const color = score > 70 ? "#22c55e" : score > 50 ? "#f59e0b" : "#ef4444";
  const r = size / 2 - 6;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={6} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={6} strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontSize: size > 60 ? 18 : 14, fontWeight: 700, color }}>{score}</span>
        <span style={{ fontSize: 9, color: "rgba(255,255,255,0.4)" }}>SCORE</span>
      </div>
    </div>
  );
}

export default function LogisticsCopilot() {
  const [tab, setTab] = useState("plan");
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [departure, setDeparture] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [aiAdvice, setAiAdvice] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState([]);
  const [saved, setSaved] = useState([]);
  const [selectedRoute, setSelectedRoute] = useState("A");

  // Load history & saved from storage
  useEffect(() => {
    try {
      const h = localStorage.getItem("lc_history");
      const s = localStorage.getItem("lc_saved");
      if (h) setHistory(JSON.parse(h));
      if (s) setSaved(JSON.parse(s));
    } catch {}
  }, []);

  const saveHistory = useCallback((entry) => {
    setHistory(prev => {
      const next = [entry, ...prev].slice(0, 10);
      try { localStorage.setItem("lc_history", JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  const analyze = () => {
    // Input validation
    const err = validateRoute(origin, destination);
    if (err) { setError(err); return; }
    setError("");
    setLoading(true);
    setAiAdvice("");
    setTimeout(() => {
      const data = generateRouteData(origin.trim(), destination.trim());
      setResult(data);
      setLoading(false);
      saveHistory({ origin: origin.trim(), destination: destination.trim(), date: new Date().toLocaleDateString(), score: data.routeA.score });
      fetchAiAdvice(data);
    }, 1200);
  };

  const fetchAiAdvice = async (data) => {
    if (!checkRateLimit()) { setAiAdvice("⚠️ Too many requests. Please wait a moment."); return; }
    setAiLoading(true);
    const prompt = `You are an AI Logistics Advisor. A trucking company is planning a route from ${origin} to ${destination}.

Route A: ${data.routeA.distance}km, ETA ${fmtTime(data.routeA.eta)}, Risk Score ${data.routeA.risk}/100, Fuel cost $${data.routeA.fuel.toFixed(0)}, Performance Score ${data.routeA.score}/100
Route B: ${data.routeB.distance}km, ETA ${fmtTime(data.routeB.eta)}, Risk Score ${data.routeB.risk}/100, Fuel cost $${data.routeB.fuel.toFixed(0)}, Performance Score ${data.routeB.score}/100

Weather: ${data.weather.condition}, Wind ${data.weather.wind}km/h
Traffic level: ${data.traffic.level}, Border congestion: ${data.border.congestion}
Border wait time: ${data.border.waitTime} minutes

Give 3-4 specific, actionable recommendations for this logistics operation. Be direct and professional. Focus on: which route to choose, optimal departure time, risk mitigation. Keep it under 150 words.`;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({
          model: "claude-opus-4-5",
          max_tokens: 300,
          messages: [{ role: "user", content: prompt }]
        })
      });
      const d = await res.json();
      setAiAdvice(d.content?.[0]?.text || "Unable to generate advice.");
    } catch {
      setAiAdvice("AI advisor temporarily unavailable. Route analysis data is still accurate.");
    }
    setAiLoading(false);
  };

  const saveRoute = () => {
    if (!origin || !destination) return;
    const entry = { origin: origin.trim(), destination: destination.trim() };
    if (saved.find(s => s.origin === entry.origin && s.destination === entry.destination)) return;
    const next = [...saved, entry].slice(0, 10);
    setSaved(next);
    try { localStorage.setItem("lc_saved", JSON.stringify(next)); } catch {}
  };

  const removeRoute = (i) => {
    const next = saved.filter((_, idx) => idx !== i);
    setSaved(next);
    try { localStorage.setItem("lc_saved", JSON.stringify(next)); } catch {}
  };

  const route = result ? (selectedRoute === "A" ? result.routeA : result.routeB) : null;

  const tabs = [
    { id: "plan", label: "🗺️ Route Plan" },
    { id: "compare", label: "⚡ Compare" },
    { id: "risk", label: "🛡️ Risk" },
    { id: "alerts", label: "🔔 Alerts" },
    { id: "history", label: "📋 History" },
    { id: "saved", label: "⭐ Saved" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#0a0f1a", color: "#fff", fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        input, button { font-family: inherit; }
        input:focus { outline: none; border-color: rgba(0,200,255,0.5) !important; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.5; } }
        @keyframes slideIn { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
      `}</style>

      {/* Header */}
      <div style={{ background: "rgba(255,255,255,0.02)", borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "0 24px" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", height: 60 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 22 }}>🚚</span>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#fff" }}>AI Logistics Copilot</div>
              <div style={{ fontSize: 10, color: "rgba(0,200,255,0.7)", letterSpacing: 2 }}>ROUTE INTELLIGENCE PLATFORM</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", animation: "pulse 2s infinite" }} />
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>System Online</span>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 16px" }}>

        {/* Input Panel */}
        <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: "20px 24px", marginBottom: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 12, alignItems: "end" }}>
            <div>
              <label style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", letterSpacing: 2, display: "block", marginBottom: 6 }}>ORIGIN</label>
              <input value={origin} onChange={e => setOrigin(e.target.value.slice(0, 100))} onKeyDown={e => e.key === "Enter" && analyze()}
                placeholder="e.g. Tashkent" maxLength={100}
                style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: "12px 14px", color: "#fff", fontSize: 14 }} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", letterSpacing: 2, display: "block", marginBottom: 6 }}>DESTINATION</label>
              <input value={destination} onChange={e => setDestination(e.target.value.slice(0, 100))} onKeyDown={e => e.key === "Enter" && analyze()}
                placeholder="e.g. Almaty" maxLength={100}
                style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: "12px 14px", color: "#fff", fontSize: 14 }} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", letterSpacing: 2, display: "block", marginBottom: 6 }}>DEPARTURE</label>
              <input type="datetime-local" value={departure} onChange={e => setDeparture(e.target.value)}
                style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: "12px 14px", color: "#fff", fontSize: 14, colorScheme: "dark" }} />
            </div>
            <button onClick={analyze} disabled={loading || !origin || !destination}
              style={{ background: loading ? "rgba(0,200,255,0.2)" : "rgba(0,200,255,0.85)", border: "none", borderRadius: 10, padding: "12px 24px", color: loading ? "rgba(0,200,255,0.5)" : "#000", fontSize: 14, fontWeight: 700, cursor: loading ? "default" : "pointer", whiteSpace: "nowrap" }}>
              {loading ? "Analyzing..." : "⚡ Analyze Route"}
            </button>
          </div>
          {error && <p style={{ color: "#ef4444", fontSize: 13, marginTop: 8, marginBottom: 0 }}>⚠️ {error}</p>}
        </div>

        {/* KPI Row */}
        {result && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 20, animation: "slideIn 0.4s ease" }}>
            <KPI icon="📍" label="Distance" value={`${route.distance}km`} color="#00c8ff" />
            <KPI icon="⏱️" label="Total ETA" value={fmtTime(route.eta)} color="#a78bfa" />
            <KPI icon="⚠️" label="Risk Score" value={`${route.risk}/100`} color={route.risk > 65 ? "#ef4444" : route.risk > 35 ? "#f59e0b" : "#22c55e"} />
            <KPI icon="⛽" label="Fuel Cost" value={`$${route.fuel.toFixed(0)}`} color="#f59e0b" />
            <KPI icon="🏆" label="Performance" value={`${route.score}/100`} color="#22c55e" />
          </div>
        )}

        {/* Tabs */}
        {result && (
          <>
            <div style={{ display: "flex", gap: 4, marginBottom: 20, flexWrap: "wrap" }}>
              {tabs.map(t => (
                <button key={t.id} onClick={() => setTab(t.id)} style={{
                  background: tab === t.id ? "rgba(0,200,255,0.12)" : "rgba(255,255,255,0.03)",
                  border: `1px solid ${tab === t.id ? "rgba(0,200,255,0.4)" : "rgba(255,255,255,0.07)"}`,
                  borderRadius: 8, padding: "8px 14px", color: tab === t.id ? "#00c8ff" : "rgba(255,255,255,0.5)",
                  fontSize: 13, cursor: "pointer"
                }}>{t.label}</button>
              ))}
              <button onClick={saveRoute} style={{ marginLeft: "auto", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: "8px 14px", color: "rgba(255,255,255,0.5)", fontSize: 13, cursor: "pointer" }}>
                ⭐ Save Route
              </button>
            </div>

            {/* Route Plan Tab */}
            {tab === "plan" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, animation: "slideIn 0.3s ease" }}>
                {/* ETA Breakdown */}
                <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20 }}>
                  <h3 style={{ margin: "0 0 16px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>ETA BREAKDOWN</h3>
                  {[
                    { label: "Base Drive Time", value: fmtTime(route.etaBase), color: "#00c8ff" },
                    { label: "Weather Impact", value: `+${fmtTime(route.weatherAdd)}`, color: "#f59e0b" },
                    { label: "Traffic Impact", value: `+${fmtTime(route.trafficAdd)}`, color: "#f97316" },
                    { label: "Border Wait", value: `+${fmtTime(route.borderAdd)}`, color: "#a78bfa" },
                  ].map(({ label, value, color }) => (
                    <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                      <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 13 }}>{label}</span>
                      <span style={{ color, fontWeight: 600, fontSize: 13 }}>{value}</span>
                    </div>
                  ))}
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 0 0", marginTop: 4 }}>
                    <span style={{ color: "#fff", fontWeight: 700 }}>Total ETA</span>
                    <span style={{ color: "#00c8ff", fontWeight: 700, fontSize: 18 }}>{fmtTime(route.eta)}</span>
                  </div>
                </div>

                {/* Smart Departure */}
                <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20 }}>
                  <h3 style={{ margin: "0 0 16px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>SMART DEPARTURE ADVISOR</h3>
                  {[
                    { label: "🚀 Fastest", time: result.departure.fast, note: "Early departure, minimal traffic", color: "#22c55e" },
                    { label: "⭐ Recommended", time: result.departure.best, note: `Best balance — saves ~1.8h vs afternoon`, color: "#00c8ff" },
                    { label: "🛡️ Safest", time: result.departure.safe, note: "Avoids border peak hours", color: "#a78bfa" },
                  ].map(({ label, time, note, color }) => (
                    <div key={label} style={{ background: "rgba(255,255,255,0.02)", borderRadius: 10, padding: "12px 14px", marginBottom: 8, borderLeft: `3px solid ${color}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 13, color: "rgba(255,255,255,0.7)" }}>{label}</span>
                        <span style={{ fontSize: 16, fontWeight: 700, color }}>{time}</span>
                      </div>
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 4 }}>{note}</div>
                    </div>
                  ))}
                </div>

                {/* Weather */}
                <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20 }}>
                  <h3 style={{ margin: "0 0 16px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>WEATHER INTELLIGENCE</h3>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
                    <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: 12, textAlign: "center" }}>
                      <div style={{ fontSize: 28 }}>{result.weather.condition === "Clear" ? "☀️" : result.weather.condition === "Cloudy" ? "⛅" : "🌧️"}</div>
                      <div style={{ fontSize: 13, color: "#fff", marginTop: 4 }}>{result.weather.condition}</div>
                    </div>
                    <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: 12 }}>
                      <div style={{ fontSize: 22, fontWeight: 700, color: "#00c8ff" }}>{result.weather.temp}°C</div>
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>Temperature</div>
                      <div style={{ fontSize: 13, color: "#f59e0b", marginTop: 4 }}>💨 {result.weather.wind} km/h</div>
                    </div>
                  </div>
                  <RiskBadge value={route.weatherRisk} label="Weather Risk" />
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 8 }}>
                    {result.weather.rain ? "⚠️ Rain expected — reduce speed on wet roads" : "✅ Good weather conditions for transport"}
                  </div>
                </div>

                {/* Traffic & Border */}
                <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20 }}>
                  <h3 style={{ margin: "0 0 16px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>TRAFFIC & BORDER</h3>
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginBottom: 8 }}>TRAFFIC</div>
                    <RiskBadge value={route.trafficRisk} label="Congestion Level" />
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 6 }}>
                      Estimated delay: {result.traffic.delay} min · Affected: {result.traffic.segments[0]}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginBottom: 8 }}>BORDER CROSSING</div>
                    <RiskBadge value={route.borderRisk} label="Border Congestion" />
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 6 }}>
                      Wait time: ~{result.border.waitTime} min · Delay probability: {result.border.delayProb}%
                    </div>
                  </div>
                </div>

                {/* AI Advisor */}
                <div style={{ gridColumn: "1 / -1", background: "linear-gradient(135deg, rgba(0,200,255,0.06), rgba(167,139,250,0.06))", border: "1px solid rgba(0,200,255,0.15)", borderRadius: 16, padding: 20 }}>
                  <h3 style={{ margin: "0 0 12px", fontSize: 13, letterSpacing: 2, color: "#00c8ff" }}>🤖 AI LOGISTICS ADVISOR</h3>
                  {aiLoading ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ width: 16, height: 16, borderRadius: "50%", border: "2px solid #00c8ff", borderTopColor: "transparent", animation: "spin 1s linear infinite" }} />
                      <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 13 }}>Generating AI recommendations...</span>
                    </div>
                  ) : (
                    <p style={{ margin: 0, color: "rgba(255,255,255,0.8)", fontSize: 14, lineHeight: 1.7 }}>{aiAdvice || "AI analysis will appear here after route analysis."}</p>
                  )}
                </div>
              </div>
            )}

            {/* Compare Tab */}
            {tab === "compare" && (
              <div style={{ animation: "slideIn 0.3s ease" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                  {[result.routeA, result.routeB].map((r, i) => (
                    <div key={i} onClick={() => setSelectedRoute(i === 0 ? "A" : "B")}
                      style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${selectedRoute === (i === 0 ? "A" : "B") ? "rgba(0,200,255,0.4)" : "rgba(255,255,255,0.07)"}`, borderRadius: 16, padding: 20, cursor: "pointer" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                        <div>
                          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{r.name}</h3>
                          {i === 0 && <span style={{ fontSize: 11, color: "#22c55e", background: "rgba(34,197,94,0.1)", padding: "2px 8px", borderRadius: 10 }}>RECOMMENDED</span>}
                        </div>
                        <ScoreRing score={r.score} />
                      </div>
                      {[
                        ["Distance", `${r.distance} km`],
                        ["Total ETA", fmtTime(r.eta)],
                        ["Fuel Cost", `$${r.fuel.toFixed(0)}`],
                        ["Risk Score", `${r.risk}/100`],
                        ["Weather Impact", `+${fmtTime(r.weatherAdd)}`],
                        ["Traffic Impact", `+${fmtTime(r.trafficAdd)}`],
                        ["Border Wait", `+${fmtTime(r.borderAdd)}`],
                      ].map(([k, v]) => (
                        <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                          <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 13 }}>{k}</span>
                          <span style={{ color: "#fff", fontSize: 13, fontWeight: 500 }}>{v}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
                <div style={{ background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)", borderRadius: 12, padding: 16, marginTop: 16 }}>
                  <div style={{ fontSize: 13, color: "#22c55e", fontWeight: 600, marginBottom: 4 }}>✅ Recommendation</div>
                  <p style={{ margin: 0, color: "rgba(255,255,255,0.7)", fontSize: 13 }}>
                    Route A is recommended — {fmtTime(result.routeB.eta - result.routeA.eta)} faster and ${(result.routeB.fuel - result.routeA.fuel).toFixed(0)} cheaper in fuel.
                    Performance score advantage: {result.routeA.score - result.routeB.score} points.
                  </p>
                </div>
              </div>
            )}

            {/* Risk Tab */}
            {tab === "risk" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, animation: "slideIn 0.3s ease" }}>
                <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20 }}>
                  <h3 style={{ margin: "0 0 16px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>RISK INTELLIGENCE ENGINE</h3>
                  <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}>
                    <ScoreRing score={100 - route.risk} size={120} />
                  </div>
                  <RiskBadge value={route.weatherRisk} label="Weather Risk" />
                  <RiskBadge value={route.trafficRisk} label="Traffic Risk" />
                  <RiskBadge value={route.borderRisk} label="Border Risk" />
                  <RiskBadge value={Math.round((route.weatherRisk + route.trafficRisk) / 2 * 0.8)} label="Port Risk" />
                  <RiskBadge value={route.risk} label="Overall Delay Risk" />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20 }}>
                    <h3 style={{ margin: "0 0 12px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>FUEL COST ESTIMATOR</h3>
                    {[
                      { label: "Route A Fuel", value: `$${result.routeA.fuel.toFixed(0)}`, km: result.routeA.distance, best: true },
                      { label: "Route B Fuel", value: `$${result.routeB.fuel.toFixed(0)}`, km: result.routeB.distance, best: false },
                    ].map(({ label, value, km, best }) => (
                      <div key={label} style={{ background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: 12, marginBottom: 8 }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 13 }}>{label}</span>
                          <span style={{ color: best ? "#22c55e" : "#f59e0b", fontWeight: 700 }}>{value}</span>
                        </div>
                        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 4 }}>{km}km · ~{Math.round(km * 0.35)}L diesel{best ? " · Most economical" : ""}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20, flex: 1 }}>
                    <h3 style={{ margin: "0 0 12px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>PORT CONGESTION</h3>
                    <div style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", marginBottom: 8 }}>Estimated port wait</div>
                    <div style={{ fontSize: 24, fontWeight: 700, color: "#a78bfa", marginBottom: 4 }}>{Math.round(route.borderRisk * 0.3)} min</div>
                    <RiskBadge value={Math.round(route.borderRisk * 0.9)} label="Port Congestion Level" />
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", marginTop: 8 }}>Impact on schedule: {Math.round(route.borderRisk * 0.005 * 60)} min delay</div>
                  </div>
                </div>
              </div>
            )}

            {/* Alerts Tab */}
            {tab === "alerts" && (
              <div style={{ animation: "slideIn 0.3s ease" }}>
                <h3 style={{ margin: "0 0 16px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>ALERT CENTER</h3>
                {result.alerts.map((alert, i) => {
                  const colors = { critical: "#ef4444", warning: "#f59e0b", info: "#00c8ff" };
                  const icons = { critical: "🚨", warning: "⚠️", info: "ℹ️" };
                  const c = colors[alert.severity];
                  return (
                    <div key={i} style={{ background: `rgba(${alert.severity === "critical" ? "239,68,68" : alert.severity === "warning" ? "245,158,11" : "0,200,255"},0.06)`, border: `1px solid ${c}30`, borderRadius: 12, padding: "14px 16px", marginBottom: 10, borderLeft: `4px solid ${c}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                        <span style={{ fontWeight: 600, color: c, fontSize: 14 }}>{icons[alert.severity]} {alert.type}</span>
                        <span style={{ fontSize: 11, color: c, background: `${c}20`, padding: "2px 8px", borderRadius: 8, textTransform: "uppercase" }}>{alert.severity}</span>
                      </div>
                      <p style={{ margin: 0, color: "rgba(255,255,255,0.7)", fontSize: 13 }}>{alert.msg}</p>
                    </div>
                  );
                })}
              </div>
            )}

            {/* History Tab */}
            {tab === "history" && (
              <div style={{ animation: "slideIn 0.3s ease" }}>
                <h3 style={{ margin: "0 0 16px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>ROUTE HISTORY</h3>
                {history.length === 0 ? <p style={{ color: "rgba(255,255,255,0.3)" }}>No history yet.</p> : history.map((h, i) => (
                  <div key={i} onClick={() => { setOrigin(h.origin); setDestination(h.destination); }}
                    style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "14px 16px", marginBottom: 8, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: 14, color: "#fff", fontWeight: 500 }}>{h.origin} → {h.destination}</div>
                      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", marginTop: 2 }}>{h.date}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: "#22c55e" }}>{h.score}</div>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>SCORE</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Saved Tab */}
            {tab === "saved" && (
              <div style={{ animation: "slideIn 0.3s ease" }}>
                <h3 style={{ margin: "0 0 16px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>SAVED ROUTES</h3>
                {saved.length === 0 ? <p style={{ color: "rgba(255,255,255,0.3)" }}>No saved routes. Click "Save Route" after analysis.</p> : saved.map((s, i) => (
                  <div key={i} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "14px 16px", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ cursor: "pointer" }} onClick={() => { setOrigin(s.origin); setDestination(s.destination); }}>
                      <div style={{ fontSize: 14, color: "#fff", fontWeight: 500 }}>⭐ {s.origin} → {s.destination}</div>
                    </div>
                    <button onClick={() => removeRoute(i)} style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, padding: "4px 10px", color: "#ef4444", fontSize: 12, cursor: "pointer" }}>Remove</button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Empty state */}
        {!result && !loading && (
          <div style={{ textAlign: "center", padding: "60px 20px", color: "rgba(255,255,255,0.2)" }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🚚</div>
            <div style={{ fontSize: 16 }}>Enter origin and destination to analyze your route</div>
            <div style={{ fontSize: 13, marginTop: 8 }}>AI-powered ETA, risk analysis, and logistics recommendations</div>
          </div>
        )}

        {loading && (
          <div style={{ textAlign: "center", padding: "60px 20px" }}>
            <div style={{ width: 48, height: 48, borderRadius: "50%", border: "3px solid #00c8ff", borderTopColor: "transparent", animation: "spin 1s linear infinite", margin: "0 auto 20px" }} />
            <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 14 }}>Analyzing route intelligence...</div>
          </div>
        )}

        {/* Footer */}
        <div style={{ marginTop: 32, paddingTop: 20, borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.2)" }}>🚚 AI Logistics Copilot — Route Intelligence Platform</span>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.2)" }}>Data refreshed on each analysis</span>
        </div>
      </div>
    </div>
  );
}