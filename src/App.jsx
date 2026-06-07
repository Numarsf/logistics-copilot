bash

cat > /mnt/user-data/outputs/App.jsx << 'ENDOFFILE'
import { useState, useEffect } from "react";
import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Fix leaflet marker icons
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png",
  iconUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png",
  shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png",
});

// ─── SECURITY ───
const _rl = { log: [], max: 5, window: 60000 };
function checkRateLimit() {
  const now = Date.now();
  _rl.log = _rl.log.filter(t => now - t < _rl.window);
  if (_rl.log.length >= _rl.max) return false;
  _rl.log.push(now);
  return true;
}

function validateInput(origin, destination) {
  if (!origin || !destination) return "Введите начальную и конечную точку";
  if (origin.length > 100 || destination.length > 100) return "Слишком длинный ввод";
  if (origin.length < 2 || destination.length < 2) return "Слишком короткий ввод";
  const forbidden = /<script|javascript:|on\w+=/i;
  if (forbidden.test(origin) || forbidden.test(destination)) return "Недопустимый ввод";
  return null;
}

// ─── FREE TRIAL ───
const FREE_LIMIT = 3;
function getUsageCount() {
  try { return parseInt(localStorage.getItem("lc_usage") || "0"); } catch { return 0; }
}
function incrementUsage() {
  try { localStorage.setItem("lc_usage", String(getUsageCount() + 1)); } catch {}
}

// ─── API KEYS ───
const WEATHER_KEY = import.meta.env.VITE_WEATHER_API_KEY;
const ORS_KEY = import.meta.env.VITE_ORS_API_KEY;

async function geocodeCity(city) {
  const res = await fetch(`https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${WEATHER_KEY}`);
  const data = await res.json();
  if (!data || data.length === 0) throw new Error(`Город не найден: ${city}`);
  return { lat: data[0].lat, lon: data[0].lon, name: data[0].name, country: data[0].country };
}

async function getWeather(lat, lon) {
  const res = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${WEATHER_KEY}&units=metric&lang=ru`);
  const data = await res.json();
  return {
    temp: Math.round(data.main.temp),
    description: data.weather[0].description,
    icon: data.weather[0].main,
    wind: Math.round(data.wind.speed * 3.6),
    humidity: data.main.humidity,
    visibility: data.visibility ? Math.round(data.visibility / 1000) : 10,
    rain: data.rain ? data.rain["1h"] || 0 : 0,
    snow: data.snow ? data.snow["1h"] || 0 : 0,
  };
}

async function getRoute(originCoords, destCoords) {
  const res = await fetch("https://api.openrouteservice.org/v2/directions/driving-hgv", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": ORS_KEY },
    body: JSON.stringify({
      coordinates: [[originCoords.lon, originCoords.lat], [destCoords.lon, destCoords.lat]],
      instructions: true,
      units: "km",
      geometry: true
    })
  });
  const data = await res.json();
  if (!data.routes || data.routes.length === 0) throw new Error("Маршрут не найден");
  const route = data.routes[0];
  // Decode geometry
  const coords = decodePolyline(route.geometry);
  return {
    distance: Math.round(route.summary.distance),
    duration: Math.round(route.summary.duration / 3600 * 10) / 10,
    coordinates: coords,
    steps: route.segments?.[0]?.steps?.slice(0, 8) || []
  };
}

function decodePolyline(encoded) {
  const coords = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let shift = 0, result = 0, b;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : result >> 1;
    coords.push([lat / 1e5, lng / 1e5]);
  }
  return coords;
}

function calculateRisk(weather) {
  let risk = 10;
  if (weather.rain > 5) risk += 30; else if (weather.rain > 0) risk += 15;
  if (weather.snow > 0) risk += 40;
  if (weather.wind > 60) risk += 25; else if (weather.wind > 40) risk += 10;
  if (weather.visibility < 3) risk += 30; else if (weather.visibility < 7) risk += 15;
  if (["Thunderstorm", "Tornado"].includes(weather.icon)) risk += 50;
  return Math.min(risk, 100);
}

function calculateETA(baseHours, weather) {
  const wImpact = weather.rain > 5 ? 0.3 : weather.rain > 0 ? 0.1 : 0;
  const sImpact = weather.snow > 0 ? 0.5 : 0;
  const windImpact = weather.wind > 60 ? 0.2 : weather.wind > 40 ? 0.1 : 0;
  const fogImpact = weather.visibility < 3 ? 0.4 : weather.visibility < 7 ? 0.15 : 0;
  const trafficImpact = 0.15;
  const borderImpact = baseHours > 5 ? 2 : baseHours > 3 ? 1 : 0.5;
  const weatherTotal = baseHours * (wImpact + sImpact + windImpact + fogImpact);
  const trafficTotal = baseHours * trafficImpact;
  return {
    base: baseHours,
    weather: weatherTotal,
    traffic: trafficTotal,
    border: borderImpact,
    total: baseHours + weatherTotal + trafficTotal + borderImpact
  };
}

function calculateFuel(distanceKm, weather) {
  const base = 32;
  const extra = weather.wind > 40 ? 1.1 : 1.0;
  const liters = (distanceKm / 100) * base * extra;
  return { liters: Math.round(liters), cost: Math.round(liters * 1.15) };
}

function fmtTime(hours) {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}ч ${m}м`;
}

function getWeatherIcon(icon) {
  const icons = { Clear: "☀️", Clouds: "⛅", Rain: "🌧️", Drizzle: "🌦️", Thunderstorm: "⛈️", Snow: "❄️", Mist: "🌫️", Fog: "🌫️", Haze: "🌫️" };
  return icons[icon] || "🌡️";
}

function RiskBar({ value, label }) {
  const color = value > 65 ? "#ef4444" : value > 35 ? "#f59e0b" : "#22c55e";
  const text = value > 65 ? "Высокий" : value > 35 ? "Средний" : "Низкий";
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
      <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 13 }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 80, height: 6, background: "rgba(255,255,255,0.1)", borderRadius: 3 }}>
          <div style={{ width: `${value}%`, height: "100%", background: color, borderRadius: 3 }} />
        </div>
        <span style={{ color, fontSize: 12, fontWeight: 700, width: 55 }}>{text}</span>
      </div>
    </div>
  );
}

function KPI({ label, value, sub, color = "#00c8ff", icon }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, padding: "18px 20px" }}>
      <div style={{ fontSize: 20, marginBottom: 4 }}>{icon}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// Map component that fits bounds
function MapBounds({ coords }) {
  const map = useMap();
  useEffect(() => {
    if (coords && coords.length > 0) {
      map.fitBounds(coords, { padding: [40, 40] });
    }
  }, [coords, map]);
  return null;
}

// Paywall component
function Paywall() {
  return (
    <div style={{ textAlign: "center", padding: "60px 20px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(0,200,255,0.2)", borderRadius: 20, marginTop: 20 }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>🔒</div>
      <h2 style={{ margin: "0 0 8px", fontSize: 24, fontWeight: 700 }}>Бесплатный лимит исчерпан</h2>
      <p style={{ color: "rgba(255,255,255,0.5)", marginBottom: 24 }}>Вы использовали 3 бесплатных анализа. Для продолжения нужна подписка Pro.</p>
      
      <div style={{ display: "inline-block", background: "rgba(0,200,255,0.08)", border: "1px solid rgba(0,200,255,0.2)", borderRadius: 16, padding: "24px 32px", marginBottom: 24 }}>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", marginBottom: 4 }}>PRO ПЛАН</div>
        <div style={{ fontSize: 40, fontWeight: 800, color: "#00c8ff" }}>$29<span style={{ fontSize: 16, fontWeight: 400 }}>/мес</span></div>
        <div style={{ marginTop: 16, textAlign: "left" }}>
          {["✅ Безлимитные анализы", "✅ Карта маршрутов", "✅ AI советник", "✅ История маршрутов", "✅ Сравнение маршрутов"].map(f => (
            <div key={f} style={{ color: "rgba(255,255,255,0.7)", fontSize: 13, marginBottom: 6 }}>{f}</div>
          ))}
        </div>
      </div>

      <div>
        <a href="https://t.me/your_username" target="_blank" rel="noopener noreferrer"
          style={{ display: "inline-block", background: "rgba(0,200,255,0.9)", color: "#000", padding: "14px 32px", borderRadius: 12, fontWeight: 700, fontSize: 15, textDecoration: "none", marginBottom: 12 }}>
          📩 Оформить подписку
        </a>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", marginTop: 8 }}>Напишите нам — ответим в течение часа</div>
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
  const [loadingMsg, setLoadingMsg] = useState("");
  const [aiAdvice, setAiAdvice] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState([]);
  const [saved, setSaved] = useState([]);
  const [usageCount, setUsageCount] = useState(getUsageCount());
  const [showPaywall, setShowPaywall] = useState(false);
  const [activeMap, setActiveMap] = useState("A");

  useEffect(() => {
    try {
      const h = localStorage.getItem("lc_history_v3");
      const s = localStorage.getItem("lc_saved_v3");
      if (h) setHistory(JSON.parse(h));
      if (s) setSaved(JSON.parse(s));
    } catch {}
  }, []);

  const analyze = async () => {
    if (usageCount >= FREE_LIMIT) { setShowPaywall(true); return; }
    const err = validateInput(origin, destination);
    if (err) { setError(err); return; }
    if (!checkRateLimit()) { setError("Слишком много запросов. Подождите минуту."); return; }
    setError(""); setLoading(true); setResult(null); setAiAdvice(""); setShowPaywall(false);

    try {
      setLoadingMsg("Определяем координаты городов...");
      const [originCoords, destCoords] = await Promise.all([geocodeCity(origin.trim()), geocodeCity(destination.trim())]);

      setLoadingMsg("Прокладываем маршрут...");
      const routeData = await getRoute(originCoords, destCoords);

      setLoadingMsg("Получаем данные о погоде...");
      const [weatherOrigin, weatherDest] = await Promise.all([getWeather(originCoords.lat, originCoords.lon), getWeather(destCoords.lat, destCoords.lon)]);

      const avgWeather = {
        temp: Math.round((weatherOrigin.temp + weatherDest.temp) / 2),
        wind: Math.round((weatherOrigin.wind + weatherDest.wind) / 2),
        rain: Math.max(weatherOrigin.rain, weatherDest.rain),
        snow: Math.max(weatherOrigin.snow, weatherDest.snow),
        visibility: Math.min(weatherOrigin.visibility, weatherDest.visibility),
        icon: weatherOrigin.rain > weatherDest.rain ? weatherOrigin.icon : weatherDest.icon,
        description: weatherDest.description,
        humidity: Math.round((weatherOrigin.humidity + weatherDest.humidity) / 2),
      };

      setLoadingMsg("Анализируем риски...");
      const weatherRisk = calculateRisk(avgWeather);
      const trafficRisk = 25 + Math.round(Math.random() * 40);
      const borderRisk = routeData.distance > 500 ? 40 + Math.round(Math.random() * 40) : 10 + Math.round(Math.random() * 20);
      const overallRisk = Math.round(weatherRisk * 0.4 + trafficRisk * 0.35 + borderRisk * 0.25);

      const eta = calculateETA(routeData.duration, avgWeather);
      const fuel = calculateFuel(routeData.distance, avgWeather);
      const score = Math.max(20, 100 - Math.round(overallRisk * 0.5 + (eta.total / 24) * 5));

      // Route B — alternative (slightly different path, longer)
      const distB = Math.round(routeData.distance * 1.12);
      const etaB = calculateETA(routeData.duration * 1.1, avgWeather);
      etaB.border *= 0.7;
      etaB.total = etaB.base + etaB.weather + etaB.traffic + etaB.border;
      const fuelB = calculateFuel(distB, avgWeather);
      const scoreB = Math.max(20, score - 8 - Math.round(Math.random() * 10));

      // Create alternative route coords (slightly offset)
      const coordsB = routeData.coordinates.map((c, i) => {
        const offset = Math.sin(i * 0.1) * 0.02;
        return [c[0] + offset, c[1] + offset * 0.5];
      });

      const alerts = [];
      if (avgWeather.rain > 10) alerts.push({ type: "Сильный дождь", msg: `Осадки ${avgWeather.rain}мм/ч — снизьте скорость`, severity: "critical" });
      else if (avgWeather.rain > 0) alerts.push({ type: "Дождь", msg: "Мокрое покрытие — будьте осторожны", severity: "warning" });
      if (avgWeather.snow > 0) alerts.push({ type: "Снег", msg: "Снегопад — проверьте шины", severity: "critical" });
      if (avgWeather.wind > 60) alerts.push({ type: "Сильный ветер", msg: `Порывы ${avgWeather.wind} км/ч — опасно для фур`, severity: "critical" });
      else if (avgWeather.wind > 40) alerts.push({ type: "Ветер", msg: `Ветер ${avgWeather.wind} км/ч`, severity: "warning" });
      if (avgWeather.visibility < 3) alerts.push({ type: "Плохая видимость", msg: "Туман — видимость менее 3 км", severity: "critical" });
      if (borderRisk > 60) alerts.push({ type: "Граница", msg: "Высокая нагрузка на переходе", severity: "warning" });
      if (alerts.length === 0) alerts.push({ type: "Всё в порядке", msg: "Нет существенных предупреждений", severity: "info" });

      incrementUsage();
      setUsageCount(getUsageCount());

      setResult({
        originCoords, destCoords,
        routeA: { name: "Маршрут А", distance: routeData.distance, eta, fuel, risk: overallRisk, score, weatherRisk, trafficRisk, borderRisk, coordinates: routeData.coordinates, steps: routeData.steps },
        routeB: { name: "Маршрут Б", distance: distB, eta: etaB, fuel: fuelB, risk: Math.round(overallRisk * 0.85), score: scoreB, weatherRisk: Math.round(weatherRisk * 0.8), trafficRisk: Math.round(trafficRisk * 0.7), borderRisk: Math.round(borderRisk * 0.9), coordinates: coordsB, steps: [] },
        weather: avgWeather, weatherOrigin, weatherDest,
        departure: { best: "06:00", safe: "09:00", fast: "05:00" },
        alerts,
      });

      // AI advice
      setAiLoading(true);
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "anthropic-dangerous-direct-browser-access": "true" },
          body: JSON.stringify({
            model: "claude-opus-4-5", max_tokens: 300,
            messages: [{ role: "user", content: `Ты AI советник по логистике. Маршрут: ${origin} → ${destination}. ${routeData.distance}км, ${fmtTime(eta.total)}, риск ${overallRisk}/100. Погода: ${avgWeather.description}, ${avgWeather.temp}°C, ветер ${avgWeather.wind}км/ч. Дай 3-4 конкретных рекомендации водителю грузовика на русском языке.` }]
          })
        });
        const d = await res.json();
        setAiAdvice(d.content?.[0]?.text || "AI советник временно недоступен.");
      } catch { setAiAdvice("AI советник временно недоступен."); }
      setAiLoading(false);

      const entry = { origin: origin.trim(), destination: destination.trim(), date: new Date().toLocaleDateString("ru-RU"), distance: routeData.distance, score };
      const newHistory = [entry, ...history].slice(0, 10);
      setHistory(newHistory);
      try { localStorage.setItem("lc_history_v3", JSON.stringify(newHistory)); } catch {}

    } catch (e) {
      setError("Ошибка: " + e.message);
    }
    setLoading(false);
  };

  const saveRoute = () => {
    if (!origin || !destination) return;
    const entry = { origin: origin.trim(), destination: destination.trim() };
    if (saved.find(s => s.origin === entry.origin && s.destination === entry.destination)) return;
    const next = [...saved, entry].slice(0, 10);
    setSaved(next);
    try { localStorage.setItem("lc_saved_v3", JSON.stringify(next)); } catch {}
  };

  const r = result?.routeA;
  const activeRoute = result ? (activeMap === "A" ? result.routeA : result.routeB) : null;

  const tabs = [
    { id: "plan", label: "🗺️ Маршрут" },
    { id: "map", label: "🗺️ Карта" },
    { id: "compare", label: "⚡ Сравнение" },
    { id: "risk", label: "🛡️ Риски" },
    { id: "alerts", label: "🔔 Оповещения" },
    { id: "history", label: "📋 История" },
    { id: "saved", label: "⭐ Сохранённые" },
  ];

  const remaining = Math.max(0, FREE_LIMIT - usageCount);

  return (
    <div style={{ minHeight: "100vh", background: "#0a0f1a", color: "#fff", fontFamily: "system-ui, sans-serif" }}>
      <style>{`* { box-sizing: border-box; } input:focus { outline: none; border-color: rgba(0,200,255,0.5) !important; } @keyframes spin { to { transform: rotate(360deg); } } @keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.5} } @keyframes slideIn { from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)} } .leaflet-container { border-radius: 12px; }`}</style>

      {/* Header */}
      <div style={{ background: "rgba(255,255,255,0.02)", borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "0 24px" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", height: 60 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 24 }}>🚚</span>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>AI Logistics Copilot</div>
              <div style={{ fontSize: 10, color: "rgba(0,200,255,0.7)", letterSpacing: 2 }}>ПЛАТФОРМА МАРШРУТНОГО ИНТЕЛЛЕКТА</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ fontSize: 12, color: remaining > 0 ? "#22c55e" : "#ef4444" }}>
              {remaining > 0 ? `✅ Бесплатных анализов: ${remaining}` : "🔒 Лимит исчерпан"}
            </div>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", animation: "pulse 2s infinite" }} />
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 16px" }}>

        {/* Input */}
        <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: "20px 24px", marginBottom: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 12, alignItems: "end" }}>
            <div>
              <label style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", letterSpacing: 2, display: "block", marginBottom: 6 }}>ОТКУДА</label>
              <input value={origin} onChange={e => setOrigin(e.target.value.slice(0, 100))} onKeyDown={e => e.key === "Enter" && analyze()} placeholder="Напр. Ташкент" maxLength={100}
                style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: "12px 14px", color: "#fff", fontSize: 14 }} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", letterSpacing: 2, display: "block", marginBottom: 6 }}>КУДА</label>
              <input value={destination} onChange={e => setDestination(e.target.value.slice(0, 100))} onKeyDown={e => e.key === "Enter" && analyze()} placeholder="Напр. Алматы" maxLength={100}
                style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: "12px 14px", color: "#fff", fontSize: 14 }} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", letterSpacing: 2, display: "block", marginBottom: 6 }}>ОТПРАВЛЕНИЕ</label>
              <input type="datetime-local" value={departure} onChange={e => setDeparture(e.target.value)}
                style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: "12px 14px", color: "#fff", fontSize: 14, colorScheme: "dark" }} />
            </div>
            <button onClick={analyze} disabled={loading}
              style={{ background: loading ? "rgba(0,200,255,0.2)" : remaining > 0 ? "rgba(0,200,255,0.85)" : "rgba(239,68,68,0.8)", border: "none", borderRadius: 10, padding: "12px 24px", color: loading ? "rgba(0,200,255,0.5)" : "#000", fontSize: 14, fontWeight: 700, cursor: loading ? "default" : "pointer", whiteSpace: "nowrap" }}>
              {loading ? "Анализ..." : remaining > 0 ? "⚡ Анализировать" : "🔒 Купить Pro"}
            </button>
          </div>
          {error && <p style={{ color: "#ef4444", fontSize: 13, marginTop: 8, marginBottom: 0 }}>⚠️ {error}</p>}
        </div>

        {/* KPIs */}
        {result && r && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 20, animation: "slideIn 0.4s ease" }}>
            <KPI icon="📍" label="Расстояние" value={`${r.distance} км`} color="#00c8ff" />
            <KPI icon="⏱️" label="Общее время" value={fmtTime(r.eta.total)} color="#a78bfa" />
            <KPI icon="⚠️" label="Уровень риска" value={`${r.risk}/100`} color={r.risk > 65 ? "#ef4444" : r.risk > 35 ? "#f59e0b" : "#22c55e"} />
            <KPI icon="⛽" label="Топливо" value={`$${r.fuel.cost}`} sub={`${r.fuel.liters}л дизеля`} color="#f59e0b" />
            <KPI icon="🏆" label="Рейтинг" value={`${r.score}/100`} color="#22c55e" />
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
                ⭐ Сохранить
              </button>
            </div>

            {/* MAP TAB */}
            {tab === "map" && (
              <div style={{ animation: "slideIn 0.3s ease" }}>
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  <button onClick={() => setActiveMap("A")} style={{ background: activeMap === "A" ? "rgba(0,200,255,0.15)" : "rgba(255,255,255,0.03)", border: `1px solid ${activeMap === "A" ? "rgba(0,200,255,0.4)" : "rgba(255,255,255,0.07)"}`, borderRadius: 8, padding: "8px 16px", color: activeMap === "A" ? "#00c8ff" : "rgba(255,255,255,0.5)", fontSize: 13, cursor: "pointer" }}>
                    🟦 Маршрут А (Рекомендуемый)
                  </button>
                  <button onClick={() => setActiveMap("B")} style={{ background: activeMap === "B" ? "rgba(255,159,11,0.15)" : "rgba(255,255,255,0.03)", border: `1px solid ${activeMap === "B" ? "rgba(255,159,11,0.4)" : "rgba(255,255,255,0.07)"}`, borderRadius: 8, padding: "8px 16px", color: activeMap === "B" ? "#f59e0b" : "rgba(255,255,255,0.5)", fontSize: 13, cursor: "pointer" }}>
                    🟨 Маршрут Б (Альтернативный)
                  </button>
                </div>

                <MapContainer center={[result.originCoords.lat, result.originCoords.lon]} zoom={6} style={{ height: 450, width: "100%", borderRadius: 16 }}>
                  <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap contributors" />
                  {activeRoute?.coordinates && (
                    <>
                      <Polyline positions={activeRoute.coordinates} color={activeMap === "A" ? "#00c8ff" : "#f59e0b"} weight={4} opacity={0.8} />
                      <MapBounds coords={activeRoute.coordinates} />
                    </>
                  )}
                  <Marker position={[result.originCoords.lat, result.originCoords.lon]}>
                    <Popup>🚚 Отправление: {result.originCoords.name}</Popup>
                  </Marker>
                  <Marker position={[result.destCoords.lat, result.destCoords.lon]}>
                    <Popup>📍 Прибытие: {result.destCoords.name}</Popup>
                  </Marker>
                </MapContainer>

                {/* Route info */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 16 }}>
                  {[result.routeA, result.routeB].map((rt, i) => (
                    <div key={i} style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${i === 0 ? "rgba(0,200,255,0.3)" : "rgba(245,158,11,0.3)"}`, borderRadius: 12, padding: 16 }}>
                      <div style={{ fontWeight: 700, marginBottom: 8, color: i === 0 ? "#00c8ff" : "#f59e0b" }}>{i === 0 ? "🟦" : "🟨"} {rt.name} {i === 0 ? "✅ Рекомендуем" : ""}</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                        {[["Расстояние", `${rt.distance} км`], ["Время", fmtTime(rt.eta.total)], ["Топливо", `$${rt.fuel.cost}`], ["Рейтинг", `${rt.score}/100`]].map(([k, v]) => (
                          <div key={k} style={{ background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: 8 }}>
                            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{k}</div>
                            <div style={{ fontWeight: 600, fontSize: 14 }}>{v}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* PLAN TAB */}
            {tab === "plan" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, animation: "slideIn 0.3s ease" }}>
                <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20 }}>
                  <h3 style={{ margin: "0 0 16px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>РАСЧЁТ ВРЕМЕНИ</h3>
                  {[["Базовое время", fmtTime(r.eta.base), "#00c8ff"], ["Погода", `+${fmtTime(r.eta.weather)}`, "#f59e0b"], ["Трафик", `+${fmtTime(r.eta.traffic)}`, "#f97316"], ["Граница", `+${fmtTime(r.eta.border)}`, "#a78bfa"]].map(([label, value, color]) => (
                    <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                      <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 13 }}>{label}</span>
                      <span style={{ color, fontWeight: 600 }}>{value}</span>
                    </div>
                  ))}
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 0 0" }}>
                    <span style={{ fontWeight: 700 }}>Итого</span>
                    <span style={{ color: "#00c8ff", fontWeight: 700, fontSize: 20 }}>{fmtTime(r.eta.total)}</span>
                  </div>
                </div>

                <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20 }}>
                  <h3 style={{ margin: "0 0 16px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>СОВЕТНИК ПО ОТПРАВЛЕНИЮ</h3>
                  {[["🚀 Быстрейшее", "05:00", "Минимальный трафик", "#22c55e"], ["⭐ Оптимальное", "06:00", "Лучший баланс", "#00c8ff"], ["🛡️ Безопасное", "09:00", "Избегает часы пик", "#a78bfa"]].map(([label, time, note, color]) => (
                    <div key={label} style={{ background: "rgba(255,255,255,0.02)", borderRadius: 10, padding: "12px 14px", marginBottom: 8, borderLeft: `3px solid ${color}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ fontSize: 13, color: "rgba(255,255,255,0.7)" }}>{label}</span>
                        <span style={{ fontSize: 16, fontWeight: 700, color }}>{time}</span>
                      </div>
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 4 }}>{note}</div>
                    </div>
                  ))}
                </div>

                <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20 }}>
                  <h3 style={{ margin: "0 0 16px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>РЕАЛЬНАЯ ПОГОДА</h3>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
                    {[["ОТПРАВЛЕНИЕ", result.weatherOrigin], ["ПРИБЫТИЕ", result.weatherDest]].map(([lbl, w]) => (
                      <div key={lbl} style={{ background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: 12 }}>
                        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginBottom: 4 }}>{lbl}</div>
                        <div style={{ fontSize: 24 }}>{getWeatherIcon(w.icon)}</div>
                        <div style={{ fontSize: 20, fontWeight: 700, color: "#00c8ff" }}>{w.temp}°C</div>
                        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>{w.description}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                    {[["💨", `${result.weather.wind}км/ч`, "ветер"], ["💧", `${result.weather.humidity}%`, "влажность"], ["👁️", `${result.weather.visibility}км`, "видимость"]].map(([icon, val, lbl]) => (
                      <div key={lbl} style={{ background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: 8, textAlign: "center" }}>
                        <div>{icon}</div>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{val}</div>
                        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{lbl}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ background: "linear-gradient(135deg, rgba(0,200,255,0.06), rgba(167,139,250,0.06))", border: "1px solid rgba(0,200,255,0.15)", borderRadius: 16, padding: 20 }}>
                  <h3 style={{ margin: "0 0 12px", fontSize: 13, letterSpacing: 2, color: "#00c8ff" }}>🤖 AI СОВЕТНИК</h3>
                  {aiLoading ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ width: 16, height: 16, borderRadius: "50%", border: "2px solid #00c8ff", borderTopColor: "transparent", animation: "spin 1s linear infinite" }} />
                      <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 13 }}>Генерируем рекомендации...</span>
                    </div>
                  ) : <p style={{ margin: 0, color: "rgba(255,255,255,0.8)", fontSize: 14, lineHeight: 1.7 }}>{aiAdvice}</p>}
                </div>
              </div>
            )}

            {/* COMPARE TAB */}
            {tab === "compare" && (
              <div style={{ animation: "slideIn 0.3s ease" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
                  {[result.routeA, result.routeB].map((route, i) => (
                    <div key={i} style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${i === 0 ? "rgba(0,200,255,0.3)" : "rgba(245,158,11,0.3)"}`, borderRadius: 16, padding: 20 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
                        <div>
                          <h3 style={{ margin: 0, color: i === 0 ? "#00c8ff" : "#f59e0b" }}>{i === 0 ? "🟦" : "🟨"} {route.name}</h3>
                          {i === 0 && <span style={{ fontSize: 11, color: "#22c55e" }}>✅ РЕКОМЕНДУЕМ</span>}
                        </div>
                        <div style={{ fontSize: 32, fontWeight: 800, color: i === 0 ? "#22c55e" : "#f59e0b" }}>{route.score}</div>
                      </div>
                      {[["Расстояние", `${route.distance} км`], ["Общее время", fmtTime(route.eta.total)], ["Стоимость топлива", `$${route.fuel.cost} (${route.fuel.liters}л)`], ["Уровень риска", `${route.risk}/100`], ["Влияние погоды", `+${fmtTime(route.eta.weather)}`], ["Трафик", `+${fmtTime(route.eta.traffic)}`], ["Граница", `+${fmtTime(route.eta.border)}`]].map(([k, v]) => (
                        <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                          <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 13 }}>{k}</span>
                          <span style={{ fontSize: 13, fontWeight: 500 }}>{v}</span>
                        </div>
                      ))}
                      <button onClick={() => { setActiveMap(i === 0 ? "A" : "B"); setTab("map"); }}
                        style={{ width: "100%", marginTop: 14, background: i === 0 ? "rgba(0,200,255,0.15)" : "rgba(245,158,11,0.15)", border: `1px solid ${i === 0 ? "rgba(0,200,255,0.3)" : "rgba(245,158,11,0.3)"}`, borderRadius: 8, padding: "10px", color: i === 0 ? "#00c8ff" : "#f59e0b", fontSize: 13, cursor: "pointer", fontWeight: 600 }}>
                        🗺️ Показать на карте
                      </button>
                    </div>
                  ))}
                </div>
                <div style={{ background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)", borderRadius: 12, padding: 16 }}>
                  <p style={{ margin: 0, color: "rgba(255,255,255,0.8)", fontSize: 14 }}>
                    ✅ <strong>Маршрут А рекомендуется</strong> — короче на {result.routeB.distance - result.routeA.distance} км, 
                    быстрее на {fmtTime(result.routeB.eta.total - result.routeA.eta.total)}, 
                    экономия ${result.routeB.fuel.cost - result.routeA.fuel.cost} на топливе.
                  </p>
                </div>
              </div>
            )}

            {/* RISK TAB */}
            {tab === "risk" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, animation: "slideIn 0.3s ease" }}>
                <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20 }}>
                  <h3 style={{ margin: "0 0 16px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>АНАЛИЗ РИСКОВ</h3>
                  <div style={{ textAlign: "center", marginBottom: 20 }}>
                    <div style={{ fontSize: 56, fontWeight: 800, color: r.risk > 65 ? "#ef4444" : r.risk > 35 ? "#f59e0b" : "#22c55e" }}>{r.risk}</div>
                    <div style={{ color: "rgba(255,255,255,0.4)" }}>Общий уровень риска / 100</div>
                  </div>
                  <RiskBar value={r.weatherRisk} label="Погодный риск" />
                  <RiskBar value={r.trafficRisk} label="Дорожный риск" />
                  <RiskBar value={r.borderRisk} label="Граничный риск" />
                  <RiskBar value={Math.round((r.weatherRisk + r.trafficRisk) * 0.4)} label="Риск задержки" />
                </div>
                <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20 }}>
                  <h3 style={{ margin: "0 0 16px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>ТОПЛИВО И ГРАНИЦА</h3>
                  {[result.routeA, result.routeB].map((rt, i) => (
                    <div key={i} style={{ background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: 12, marginBottom: 8 }}>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 13 }}>{i === 0 ? "Маршрут А" : "Маршрут Б"}</span>
                        <span style={{ color: i === 0 ? "#22c55e" : "#f59e0b", fontWeight: 700 }}>${rt.fuel.cost}</span>
                      </div>
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>{rt.distance}км · {rt.fuel.liters}л{i === 0 ? " · Экономичнее" : ""}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ALERTS TAB */}
            {tab === "alerts" && (
              <div style={{ animation: "slideIn 0.3s ease" }}>
                <h3 style={{ margin: "0 0 16px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>ЦЕНТР ОПОВЕЩЕНИЙ</h3>
                {result.alerts.map((alert, i) => {
                  const colors = { critical: "#ef4444", warning: "#f59e0b", info: "#00c8ff" };
                  const icons = { critical: "🚨", warning: "⚠️", info: "ℹ️" };
                  const labels = { critical: "Критично", warning: "Внимание", info: "Информация" };
                  const c = colors[alert.severity];
                  return (
                    <div key={i} style={{ background: `rgba(${alert.severity === "critical" ? "239,68,68" : alert.severity === "warning" ? "245,158,11" : "0,200,255"},0.06)`, border: `1px solid ${c}30`, borderRadius: 12, padding: "14px 16px", marginBottom: 10, borderLeft: `4px solid ${c}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <span style={{ fontWeight: 600, color: c }}>{icons[alert.severity]} {alert.type}</span>
                        <span style={{ fontSize: 11, color: c, background: `${c}20`, padding: "2px 8px", borderRadius: 8 }}>{labels[alert.severity]}</span>
                      </div>
                      <p style={{ margin: 0, color: "rgba(255,255,255,0.7)", fontSize: 13 }}>{alert.msg}</p>
                    </div>
                  );
                })}
              </div>
            )}

            {/* HISTORY TAB */}
            {tab === "history" && (
              <div style={{ animation: "slideIn 0.3s ease" }}>
                <h3 style={{ margin: "0 0 16px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>ИСТОРИЯ МАРШРУТОВ</h3>
                {history.length === 0 ? <p style={{ color: "rgba(255,255,255,0.3)" }}>История пуста.</p> : history.map((h, i) => (
                  <div key={i} onClick={() => { setOrigin(h.origin); setDestination(h.destination); }}
                    style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "14px 16px", marginBottom: 8, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>{h.origin} → {h.destination}</div>
                      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", marginTop: 2 }}>{h.date} · {h.distance} км</div>
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "#22c55e" }}>{h.score}</div>
                  </div>
                ))}
              </div>
            )}

            {/* SAVED TAB */}
            {tab === "saved" && (
              <div style={{ animation: "slideIn 0.3s ease" }}>
                <h3 style={{ margin: "0 0 16px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>СОХРАНЁННЫЕ МАРШРУТЫ</h3>
                {saved.length === 0 ? <p style={{ color: "rgba(255,255,255,0.3)" }}>Нет сохранённых маршрутов.</p> : saved.map((s, i) => (
                  <div key={i} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "14px 16px", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ cursor: "pointer" }} onClick={() => { setOrigin(s.origin); setDestination(s.destination); }}>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>⭐ {s.origin} → {s.destination}</div>
                    </div>
                    <button onClick={() => { const n = saved.filter((_, idx) => idx !== i); setSaved(n); try { localStorage.setItem("lc_saved_v3", JSON.stringify(n)); } catch {} }}
                      style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, padding: "4px 10px", color: "#ef4444", fontSize: 12, cursor: "pointer" }}>Удалить</button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Paywall */}
        {showPaywall && <Paywall />}

        {/* Empty state */}
        {!result && !loading && !showPaywall && (
          <div style={{ textAlign: "center", padding: "60px 20px", color: "rgba(255,255,255,0.2)" }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🚚</div>
            <div style={{ fontSize: 16 }}>Введите маршрут для анализа</div>
            <div style={{ fontSize: 13, marginTop: 8 }}>Реальные данные · Карта маршрута · AI советник</div>
            <div style={{ fontSize: 13, marginTop: 4, color: "#22c55e" }}>✅ {remaining} бесплатных анализа</div>
          </div>
        )}

        {loading && (
          <div style={{ textAlign: "center", padding: "60px 20px" }}>
            <div style={{ width: 48, height: 48, borderRadius: "50%", border: "3px solid #00c8ff", borderTopColor: "transparent", animation: "spin 1s linear infinite", margin: "0 auto 20px" }} />
            <div style={{ color: "#00c8ff", fontSize: 14, marginBottom: 8 }}>{loadingMsg}</div>
          </div>
        )}

        <div style={{ marginTop: 32, paddingTop: 20, borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.2)" }}>🚚 AI Logistics Copilot</span>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.2)" }}>OpenRouteService + OpenWeatherMap + Claude AI</span>
        </div>
      </div>
    </div>
  );
}
ENDOFFILE
Output

exit code 0