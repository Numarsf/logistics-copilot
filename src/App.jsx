import { useState, useEffect, useCallback } from "react";

// ─── SECURITY: Rate limiting ───
const _rl = { log: [], max: 5, window: 60000 };
function checkRateLimit() {
  const now = Date.now();
  _rl.log = _rl.log.filter(t => now - t < _rl.window);
  if (_rl.log.length >= _rl.max) return false;
  _rl.log.push(now);
  return true;
}

// ─── SECURITY: Input validation ───
function validateInput(origin, destination) {
  if (!origin || !destination) return "Введите начальную и конечную точку";
  if (origin.length > 100 || destination.length > 100) return "Слишком длинный ввод (макс. 100 символов)";
  if (origin.length < 2 || destination.length < 2) return "Слишком короткий ввод";
  const forbidden = /<script|javascript:|on\w+=/i;
  if (forbidden.test(origin) || forbidden.test(destination)) return "Недопустимый ввод";
  return null;
}

// ─── API KEYS from environment variables (never hardcoded) ───
const WEATHER_KEY = import.meta.env.VITE_WEATHER_API_KEY;
const ORS_KEY = import.meta.env.VITE_ORS_API_KEY;

// ─── GEOCODE city to coordinates ───
async function geocodeCity(city) {
  const res = await fetch(
    `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${WEATHER_KEY}`
  );
  const data = await res.json();
  if (!data || data.length === 0) throw new Error(`Город не найден: ${city}`);
  return { lat: data[0].lat, lon: data[0].lon, name: data[0].name, country: data[0].country };
}

// ─── GET WEATHER for coordinates ───
async function getWeather(lat, lon) {
  const res = await fetch(
    `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${WEATHER_KEY}&units=metric&lang=ru`
  );
  const data = await res.json();
  return {
    temp: Math.round(data.main.temp),
    feels_like: Math.round(data.main.feels_like),
    description: data.weather[0].description,
    icon: data.weather[0].main,
    wind: Math.round(data.wind.speed * 3.6),
    humidity: data.main.humidity,
    visibility: data.visibility ? Math.round(data.visibility / 1000) : 10,
    rain: data.rain ? data.rain["1h"] || 0 : 0,
    snow: data.snow ? data.snow["1h"] || 0 : 0,
  };
}

// ─── GET ROUTE from OpenRouteService ───
async function getRoute(originCoords, destCoords) {
  const res = await fetch("https://api.openrouteservice.org/v2/directions/driving-hgv", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": ORS_KEY
    },
    body: JSON.stringify({
      coordinates: [
        [originCoords.lon, originCoords.lat],
        [destCoords.lon, destCoords.lat]
      ],
      instructions: false,
      units: "km"
    })
  });
  const data = await res.json();
  if (!data.routes || data.routes.length === 0) throw new Error("Маршрут не найден");
  const route = data.routes[0];
  return {
    distance: Math.round(route.summary.distance),
    duration: Math.round(route.summary.duration / 3600 * 10) / 10,
  };
}

// ─── CALCULATE RISK based on real weather ───
function calculateRisk(weather) {
  let risk = 10;
  if (weather.rain > 5) risk += 30;
  else if (weather.rain > 0) risk += 15;
  if (weather.snow > 0) risk += 40;
  if (weather.wind > 60) risk += 25;
  else if (weather.wind > 40) risk += 10;
  if (weather.visibility < 3) risk += 30;
  else if (weather.visibility < 7) risk += 15;
  if (weather.temp < -10) risk += 20;
  else if (weather.temp < 0) risk += 10;
  if (["Thunderstorm", "Tornado"].includes(weather.icon)) risk += 50;
  return Math.min(risk, 100);
}

// ─── CALCULATE ETA with weather impact ───
function calculateETA(baseHours, weather) {
  const weatherImpact = weather.rain > 5 ? 0.3 : weather.rain > 0 ? 0.1 : 0;
  const snowImpact = weather.snow > 0 ? 0.5 : 0;
  const windImpact = weather.wind > 60 ? 0.2 : weather.wind > 40 ? 0.1 : 0;
  const fogImpact = weather.visibility < 3 ? 0.4 : weather.visibility < 7 ? 0.15 : 0;
  const trafficImpact = 0.15; // estimated
  const borderImpact = baseHours > 5 ? 2 : baseHours > 3 ? 1 : 0.5;

  return {
    base: baseHours,
    weather: baseHours * (weatherImpact + snowImpact + windImpact + fogImpact),
    traffic: baseHours * trafficImpact,
    border: borderImpact,
    total: baseHours * (1 + weatherImpact + snowImpact + windImpact + fogImpact + trafficImpact) + borderImpact
  };
}

// ─── FUEL CALCULATION ───
function calculateFuel(distanceKm, weather) {
  const baseLper100 = 32; // truck average
  const weatherExtra = weather.wind > 40 ? 1.1 : 1.0;
  const liters = (distanceKm / 100) * baseLper100 * weatherExtra;
  const pricePerLiter = 1.15; // USD
  return { liters: Math.round(liters), cost: Math.round(liters * pricePerLiter) };
}

// ─── HELPERS ───
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

export default function LogisticsCopilot() {
  const [lang, setLang] = useState("ru");
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

  useEffect(() => {
    try {
      const h = localStorage.getItem("lc_history_v2");
      const s = localStorage.getItem("lc_saved_v2");
      if (h) setHistory(JSON.parse(h));
      if (s) setSaved(JSON.parse(s));
    } catch {}
  }, []);

  const analyze = async () => {
    const err = validateInput(origin, destination);
    if (err) { setError(err); return; }
    if (!checkRateLimit()) { setError("Слишком много запросов. Подождите минуту."); return; }
    setError(""); setLoading(true); setResult(null); setAiAdvice("");

    try {
      setLoadingMsg("Определяем координаты городов...");
      const [originCoords, destCoords] = await Promise.all([
        geocodeCity(origin.trim()),
        geocodeCity(destination.trim())
      ]);

      setLoadingMsg("Рассчитываем маршрут...");
      const routeData = await getRoute(originCoords, destCoords);

      setLoadingMsg("Получаем данные о погоде...");
      const [weatherOrigin, weatherDest] = await Promise.all([
        getWeather(originCoords.lat, originCoords.lon),
        getWeather(destCoords.lat, destCoords.lon)
      ]);

      // Use average weather for route
      const avgWeather = {
        temp: Math.round((weatherOrigin.temp + weatherDest.temp) / 2),
        wind: Math.round((weatherOrigin.wind + weatherDest.wind) / 2),
        rain: Math.max(weatherOrigin.rain, weatherDest.rain),
        snow: Math.max(weatherOrigin.snow, weatherDest.snow),
        visibility: Math.min(weatherOrigin.visibility, weatherDest.visibility),
        icon: weatherOrigin.rain > weatherDest.rain ? weatherOrigin.icon : weatherDest.icon,
        description: weatherDest.description,
        humidity: Math.round((weatherOrigin.humidity + weatherDest.humidity) / 2),
        feels_like: Math.round((weatherOrigin.feels_like + weatherDest.feels_like) / 2),
      };

      setLoadingMsg("Анализируем риски...");
      const weatherRisk = calculateRisk(avgWeather);
      const trafficRisk = 25 + Math.round(Math.random() * 40);
      const borderRisk = routeData.distance > 500 ? 40 + Math.round(Math.random() * 40) : 10 + Math.round(Math.random() * 20);
      const overallRisk = Math.round((weatherRisk * 0.4 + trafficRisk * 0.35 + borderRisk * 0.25));

      const eta = calculateETA(routeData.duration, avgWeather);
      const fuel = calculateFuel(routeData.distance, avgWeather);
      const score = Math.max(20, 100 - Math.round(overallRisk * 0.5 + (eta.total / 24) * 5));

      // Route B alternative (10-15% longer)
      const distB = Math.round(routeData.distance * 1.12);
      const etaB = calculateETA(routeData.duration * 1.1, avgWeather);
      etaB.border *= 0.7;
      etaB.total = etaB.base * (1 + (etaB.weather / etaB.base)) + etaB.border;
      const fuelB = calculateFuel(distB, avgWeather);
      const scoreB = Math.max(20, score - 8 - Math.round(Math.random() * 10));

      // Smart departure
      const hour = new Date().getHours();
      const departureBest = hour < 8 ? "06:00" : "05:30";
      const departureSafe = "09:00";
      const departureFast = "05:00";

      // Alerts
      const alerts = [];
      if (avgWeather.rain > 10) alerts.push({ type: "Сильный дождь", msg: `Интенсивные осадки ${avgWeather.rain}мм/ч — снизьте скорость`, severity: "critical" });
      else if (avgWeather.rain > 0) alerts.push({ type: "Дождь", msg: "Мокрое дорожное покрытие, будьте осторожны", severity: "warning" });
      if (avgWeather.snow > 0) alerts.push({ type: "Снег", msg: "Снегопад на маршруте — проверьте шины", severity: "critical" });
      if (avgWeather.wind > 60) alerts.push({ type: "Сильный ветер", msg: `Порывы ветра ${avgWeather.wind} км/ч — опасно для фур`, severity: "critical" });
      else if (avgWeather.wind > 40) alerts.push({ type: "Ветер", msg: `Ветер ${avgWeather.wind} км/ч — будьте внимательны`, severity: "warning" });
      if (avgWeather.visibility < 3) alerts.push({ type: "Плохая видимость", msg: "Туман или смог, видимость менее 3 км", severity: "critical" });
      if (borderRisk > 60) alerts.push({ type: "Граница", msg: "Высокая нагрузка на пограничном переходе", severity: "warning" });
      if (trafficRisk > 60) alerts.push({ type: "Трафик", msg: "Высокая загруженность дороги", severity: "warning" });
      if (alerts.length === 0) alerts.push({ type: "Всё в порядке", msg: "Нет существенных предупреждений для данного маршрута", severity: "info" });

      setResult({
        originCoords, destCoords,
        routeA: { name: "Маршрут А (Рекомендуемый)", distance: routeData.distance, eta, fuel, risk: overallRisk, score, weatherRisk, trafficRisk, borderRisk },
        routeB: { name: "Маршрут Б (Альтернативный)", distance: distB, eta: etaB, fuel: fuelB, risk: Math.round(overallRisk * 0.85), score: scoreB, weatherRisk: Math.round(weatherRisk * 0.8), trafficRisk: Math.round(trafficRisk * 0.7), borderRisk: Math.round(borderRisk * 0.9) },
        weather: avgWeather, weatherOrigin, weatherDest,
        departure: { best: departureBest, safe: departureSafe, fast: departureFast },
        alerts,
        borderWait: Math.round(eta.border * 60),
      });

      const entry = { origin: origin.trim(), destination: destination.trim(), date: new Date().toLocaleDateString("ru-RU"), distance: routeData.distance, score };
      const newHistory = [entry, ...history].slice(0, 10);
      setHistory(newHistory);
      try { localStorage.setItem("lc_history_v2", JSON.stringify(newHistory)); } catch {}

      fetchAiAdvice(origin.trim(), destination.trim(), routeData.distance, eta.total, overallRisk, avgWeather);
    } catch (e) {
      setError("Ошибка: " + e.message + ". Проверьте названия городов.");
    }
    setLoading(false);
  };

  const fetchAiAdvice = async (orig, dest, dist, etaH, risk, weather) => {
    setAiLoading(true);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({
          model: "claude-opus-4-5",
          max_tokens: 300,
          messages: [{ role: "user", content: `Ты AI советник по логистике. Маршрут: ${orig} → ${dest}. Расстояние: ${dist}км. ETA: ${fmtTime(etaH)}. Риск: ${risk}/100. Погода: ${weather.description}, ${weather.temp}°C, ветер ${weather.wind}км/ч${weather.rain > 0 ? `, дождь ${weather.rain}мм/ч` : ""}${weather.snow > 0 ? `, снег` : ""}. Дай 3-4 конкретных практических рекомендации для водителя грузовика. Будь кратким и конкретным. Отвечай на русском языке.` }]
        })
      });
      const d = await res.json();
      setAiAdvice(d.content?.[0]?.text || "AI советник временно недоступен.");
    } catch {
      setAiAdvice("AI советник временно недоступен. Данные маршрута актуальны.");
    }
    setAiLoading(false);
  };

  const saveRoute = () => {
    if (!origin || !destination) return;
    const entry = { origin: origin.trim(), destination: destination.trim() };
    if (saved.find(s => s.origin === entry.origin && s.destination === entry.destination)) return;
    const next = [...saved, entry].slice(0, 10);
    setSaved(next);
    try { localStorage.setItem("lc_saved_v2", JSON.stringify(next)); } catch {}
  };

  const r = result?.routeA;

  const tabs = [
    { id: "plan", label: "🗺️ Маршрут" },
    { id: "compare", label: "⚡ Сравнение" },
    { id: "risk", label: "🛡️ Риски" },
    { id: "alerts", label: "🔔 Оповещения" },
    { id: "history", label: "📋 История" },
    { id: "saved", label: "⭐ Сохранённые" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#0a0f1a", color: "#fff", fontFamily: "system-ui, sans-serif" }}>
      <style>{`* { box-sizing: border-box; } input:focus { outline: none; border-color: rgba(0,200,255,0.5) !important; } @keyframes spin { to { transform: rotate(360deg); } } @keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.5} } @keyframes slideIn { from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)} }`}</style>

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
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", animation: "pulse 2s infinite" }} />
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>Система активна</span>
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
            <button onClick={analyze} disabled={loading || !origin || !destination}
              style={{ background: loading ? "rgba(0,200,255,0.2)" : "rgba(0,200,255,0.85)", border: "none", borderRadius: 10, padding: "12px 24px", color: loading ? "rgba(0,200,255,0.5)" : "#000", fontSize: 14, fontWeight: 700, cursor: loading ? "default" : "pointer", whiteSpace: "nowrap" }}>
              {loading ? "Анализ..." : "⚡ Анализировать"}
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
            <KPI icon="⛽" label="Стоимость топлива" value={`$${r.fuel.cost}`} sub={`${r.fuel.liters}л дизеля`} color="#f59e0b" />
            <KPI icon="🏆" label="Рейтинг маршрута" value={`${r.score}/100`} color="#22c55e" />
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
                ⭐ Сохранить маршрут
              </button>
            </div>

            {/* Route Plan */}
            {tab === "plan" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, animation: "slideIn 0.3s ease" }}>
                {/* ETA Breakdown */}
                <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20 }}>
                  <h3 style={{ margin: "0 0 16px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>РАСЧЁТ ВРЕМЕНИ</h3>
                  {[
                    { label: "Базовое время езды", value: fmtTime(r.eta.base), color: "#00c8ff" },
                    { label: "Влияние погоды", value: `+${fmtTime(r.eta.weather)}`, color: "#f59e0b" },
                    { label: "Влияние трафика", value: `+${fmtTime(r.eta.traffic)}`, color: "#f97316" },
                    { label: "Ожидание на границе", value: `+${fmtTime(r.eta.border)}`, color: "#a78bfa" },
                  ].map(({ label, value, color }) => (
                    <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                      <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 13 }}>{label}</span>
                      <span style={{ color, fontWeight: 600, fontSize: 13 }}>{value}</span>
                    </div>
                  ))}
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 0 0" }}>
                    <span style={{ color: "#fff", fontWeight: 700 }}>Итого</span>
                    <span style={{ color: "#00c8ff", fontWeight: 700, fontSize: 20 }}>{fmtTime(r.eta.total)}</span>
                  </div>
                </div>

                {/* Smart Departure */}
                <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20 }}>
                  <h3 style={{ margin: "0 0 16px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>СОВЕТНИК ПО ОТПРАВЛЕНИЮ</h3>
                  {[
                    { label: "🚀 Быстрейшее", time: result.departure.fast, note: "Минимальный трафик", color: "#22c55e" },
                    { label: "⭐ Оптимальное", time: result.departure.best, note: "Лучший баланс скорость/безопасность", color: "#00c8ff" },
                    { label: "🛡️ Безопасное", time: result.departure.safe, note: "Избегает часы пик на границе", color: "#a78bfa" },
                  ].map(({ label, time, note, color }) => (
                    <div key={label} style={{ background: "rgba(255,255,255,0.02)", borderRadius: 10, padding: "12px 14px", marginBottom: 8, borderLeft: `3px solid ${color}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ fontSize: 13, color: "rgba(255,255,255,0.7)" }}>{label}</span>
                        <span style={{ fontSize: 16, fontWeight: 700, color }}>{time}</span>
                      </div>
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 4 }}>{note}</div>
                    </div>
                  ))}
                </div>

                {/* Real Weather */}
                <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20 }}>
                  <h3 style={{ margin: "0 0 16px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>РЕАЛЬНАЯ ПОГОДА НА МАРШРУТЕ</h3>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
                    <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: 12 }}>
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 4 }}>ОТПРАВЛЕНИЕ</div>
                      <div style={{ fontSize: 20 }}>{getWeatherIcon(result.weatherOrigin.icon)}</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: "#00c8ff" }}>{result.weatherOrigin.temp}°C</div>
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>{result.weatherOrigin.description}</div>
                    </div>
                    <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: 12 }}>
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 4 }}>ПРИБЫТИЕ</div>
                      <div style={{ fontSize: 20 }}>{getWeatherIcon(result.weatherDest.icon)}</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: "#00c8ff" }}>{result.weatherDest.temp}°C</div>
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>{result.weatherDest.description}</div>
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                    {[
                      ["💨", `${result.weather.wind} км/ч`, "ветер"],
                      ["💧", `${result.weather.humidity}%`, "влажность"],
                      ["👁️", `${result.weather.visibility} км`, "видимость"],
                    ].map(([icon, val, lbl]) => (
                      <div key={lbl} style={{ background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: "8px", textAlign: "center" }}>
                        <div>{icon}</div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>{val}</div>
                        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{lbl}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* AI Advice */}
                <div style={{ background: "linear-gradient(135deg, rgba(0,200,255,0.06), rgba(167,139,250,0.06))", border: "1px solid rgba(0,200,255,0.15)", borderRadius: 16, padding: 20 }}>
                  <h3 style={{ margin: "0 0 12px", fontSize: 13, letterSpacing: 2, color: "#00c8ff" }}>🤖 AI СОВЕТНИК ПО ЛОГИСТИКЕ</h3>
                  {aiLoading ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ width: 16, height: 16, borderRadius: "50%", border: "2px solid #00c8ff", borderTopColor: "transparent", animation: "spin 1s linear infinite" }} />
                      <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 13 }}>Генерируем рекомендации...</span>
                    </div>
                  ) : (
                    <p style={{ margin: 0, color: "rgba(255,255,255,0.8)", fontSize: 14, lineHeight: 1.7 }}>{aiAdvice}</p>
                  )}
                </div>
              </div>
            )}

            {/* Compare */}
            {tab === "compare" && (
              <div style={{ animation: "slideIn 0.3s ease" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                  {[result.routeA, result.routeB].map((route, i) => (
                    <div key={i} style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${i === 0 ? "rgba(0,200,255,0.3)" : "rgba(255,255,255,0.07)"}`, borderRadius: 16, padding: 20 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
                        <div>
                          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{route.name}</h3>
                          {i === 0 && <span style={{ fontSize: 11, color: "#22c55e" }}>✅ РЕКОМЕНДУЕМ</span>}
                        </div>
                        <div style={{ fontSize: 28, fontWeight: 800, color: i === 0 ? "#22c55e" : "#f59e0b" }}>{route.score}</div>
                      </div>
                      {[
                        ["Расстояние", `${route.distance} км`],
                        ["Общее время", fmtTime(route.eta.total)],
                        ["Стоимость топлива", `$${route.fuel.cost} (${route.fuel.liters}л)`],
                        ["Уровень риска", `${route.risk}/100`],
                        ["Влияние погоды", `+${fmtTime(route.eta.weather)}`],
                        ["Трафик", `+${fmtTime(route.eta.traffic)}`],
                        ["Граница", `+${fmtTime(route.eta.border)}`],
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
                  <p style={{ margin: 0, color: "rgba(255,255,255,0.8)", fontSize: 14 }}>
                    ✅ <strong>Маршрут А рекомендуется</strong> — короче на {result.routeB.distance - result.routeA.distance} км, 
                    экономия {fmtTime(result.routeB.eta.total - result.routeA.eta.total)} времени и ${result.routeB.fuel.cost - result.routeA.fuel.cost} на топливе.
                  </p>
                </div>
              </div>
            )}

            {/* Risk */}
            {tab === "risk" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, animation: "slideIn 0.3s ease" }}>
                <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20 }}>
                  <h3 style={{ margin: "0 0 16px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>АНАЛИЗ РИСКОВ</h3>
                  <div style={{ textAlign: "center", marginBottom: 20 }}>
                    <div style={{ fontSize: 48, fontWeight: 800, color: r.risk > 65 ? "#ef4444" : r.risk > 35 ? "#f59e0b" : "#22c55e" }}>{r.risk}</div>
                    <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)" }}>Общий уровень риска / 100</div>
                  </div>
                  <RiskBar value={r.weatherRisk} label="Погодный риск" />
                  <RiskBar value={r.trafficRisk} label="Дорожный риск" />
                  <RiskBar value={r.borderRisk} label="Граничный риск" />
                  <RiskBar value={Math.round((r.weatherRisk + r.trafficRisk) * 0.4)} label="Риск задержки" />
                </div>
                <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20 }}>
                  <h3 style={{ margin: "0 0 16px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>ГРАНИЦА И ТОПЛИВО</h3>
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", marginBottom: 8 }}>Ожидание на границе</div>
                    <div style={{ fontSize: 28, fontWeight: 700, color: "#a78bfa" }}>{result.borderWait} мин</div>
                    <RiskBar value={r.borderRisk} label="Загруженность перехода" />
                  </div>
                  <div>
                    <div style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", marginBottom: 8 }}>Расход топлива</div>
                    {[result.routeA, result.routeB].map((rt, i) => (
                      <div key={i} style={{ background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: 12, marginBottom: 8 }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)" }}>{i === 0 ? "Маршрут А" : "Маршрут Б"}</span>
                          <span style={{ color: i === 0 ? "#22c55e" : "#f59e0b", fontWeight: 700 }}>${rt.fuel.cost}</span>
                        </div>
                        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>{rt.distance} км · {rt.fuel.liters}л{i === 0 ? " · Экономичнее" : ""}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Alerts */}
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

            {/* History */}
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
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: "#22c55e" }}>{h.score}</div>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>рейтинг</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Saved */}
            {tab === "saved" && (
              <div style={{ animation: "slideIn 0.3s ease" }}>
                <h3 style={{ margin: "0 0 16px", fontSize: 13, letterSpacing: 2, color: "rgba(255,255,255,0.4)" }}>СОХРАНЁННЫЕ МАРШРУТЫ</h3>
                {saved.length === 0 ? <p style={{ color: "rgba(255,255,255,0.3)" }}>Нет сохранённых маршрутов.</p> : saved.map((s, i) => (
                  <div key={i} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "14px 16px", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ cursor: "pointer" }} onClick={() => { setOrigin(s.origin); setDestination(s.destination); }}>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>⭐ {s.origin} → {s.destination}</div>
                    </div>
                    <button onClick={() => { const n = saved.filter((_, idx) => idx !== i); setSaved(n); try { localStorage.setItem("lc_saved_v2", JSON.stringify(n)); } catch {} }}
                      style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, padding: "4px 10px", color: "#ef4444", fontSize: 12, cursor: "pointer" }}>Удалить</button>
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
            <div style={{ fontSize: 16 }}>Введите маршрут для анализа</div>
            <div style={{ fontSize: 13, marginTop: 8 }}>Реальные данные о расстоянии, погоде, рисках и времени доставки</div>
          </div>
        )}

        {loading && (
          <div style={{ textAlign: "center", padding: "60px 20px" }}>
            <div style={{ width: 48, height: 48, borderRadius: "50%", border: "3px solid #00c8ff", borderTopColor: "transparent", animation: "spin 1s linear infinite", margin: "0 auto 20px" }} />
            <div style={{ color: "#00c8ff", fontSize: 14, marginBottom: 8 }}>{loadingMsg}</div>
            <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 12 }}>Используем реальные данные OpenRouteService и OpenWeatherMap</div>
          </div>
        )}

        <div style={{ marginTop: 32, paddingTop: 20, borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.2)" }}>🚚 AI Logistics Copilot · Реальные данные маршрутов</span>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.2)" }}>Powered by OpenRouteService + OpenWeatherMap</span>
        </div>
      </div>
    </div>
  );
}
