// api/alice.js — вебхук навыка Яндекс Алисы на Gemini

const SMART = "gemini-2.5-flash-preview-05-20";
const LITE  = "gemini-2.5-flash-lite-preview-06-17";

// Только эти темы требуют поиска и умной модели
const SEARCH_RE =
  /новост|сегодня|вчера|завтра|послед|свеж|актуальн|курс валют|погод|сколько стоит|кто выиграл|счёт|счет|матч|результат|случилось|найди|поищи|в интернете|расписание|когда выйдет|вышел ли|2025|2026/i;

// Сложные вопросы — умная модель без поиска
const SMART_RE =
  /объясни|расскажи подробно|почему|как работает|что такое|в чём разница|сравни|проанализируй|напиши|придумай|помоги|посоветуй|рекомендуй/i;

const systemPrompt = () => {
  const now = new Date().toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    dateStyle: "full",
    timeStyle: "short",
  });
  return (
    "Ты умный, живой и остроумный голосовой собеседник в Яндекс Алисе. " +
    "Можешь обсуждать любые темы: наука, учёба, жизнь, советы, шутки, идеи. " +
    "Отвечай по-русски, разговорно, 1-3 предложения. Никакого markdown, списков, ссылок и эмодзи: " +
    "ответ должен хорошо звучать вслух. " +
    "Если вопрос про новости или свежие события — кратко назови источник. " +
    `Сейчас ${now} по Москве.`
  );
};

const clean = (t) =>
  t.replace(/\[\d+(?:,\s*\d+)*\]/g, "").replace(/[*_#`>]/g, "").replace(/\s+/g, " ").trim();

async function ask(model, useSearch, contents, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt() }] },
          contents,
          tools: useSearch ? [{ google_search: {} }] : undefined,
          generationConfig: {
            maxOutputTokens: 250,
            temperature: 0.8,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }
    );
    const data = await r.json();
    if (!r.ok) throw new Error(`${model} ${r.status} ${JSON.stringify(data).slice(0, 200)}`);
    const text = clean(
      (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("")
    );
    if (!text) throw new Error(`${model} empty`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  const body      = req.body || {};
  const version   = body.version || "1.0";
  const utterance = ((body.request && body.request.original_utterance) || "").trim();
  const history   = (body.state && body.state.session && body.state.session.h) || [];

  const send = (text, end = false, h = history) =>
    res.status(200).json({
      version,
      session_state: { h },
      response: { text: text.slice(0, 1000), end_session: end },
    });

  if (utterance === "ping") return send("pong");
  if (!utterance)
    return send("Привет! Я подключена к Gemini. Спрашивай что угодно, хоть про свежие новости.");
  if (/^(хватит|стоп|выход|выйти|пока|закрой)\.?$/i.test(utterance))
    return send("Хорошо, до связи!", true);

  const contents = [...history, { role: "user", parts: [{ text: utterance }] }];

  const wantsSearch = SEARCH_RE.test(utterance);
  const wantsSmart  = SMART_RE.test(utterance);

  let answer = null;

  if (wantsSearch) {
    // Новости/факты: пробуем умную с поиском, запасной — lite без поиска параллельно
    const [smart, lite] = await Promise.allSettled([
      ask(SMART, true,  contents, 3800),
      ask(LITE,  false, contents, 3800),
    ]);
    answer = smart.status === "fulfilled" ? smart.value : null;
    if (!answer) answer = lite.status === "fulfilled" ? lite.value : null;

  } else if (wantsSmart) {
    // Сложный вопрос: умная без поиска, запасной lite параллельно
    const [smart, lite] = await Promise.allSettled([
      ask(SMART, false, contents, 3800),
      ask(LITE,  false, contents, 3800),
    ]);
    answer = smart.status === "fulfilled" ? smart.value : null;
    if (!answer) answer = lite.status === "fulfilled" ? lite.value : null;

  } else {
    // Простой разговор (привет, как дела, шутка и т.д.) — сразу lite, быстро
    try {
      answer = await ask(LITE, false, contents, 3800);
    } catch (e) {
      console.error("lite failed:", String(e).slice(0, 200));
    }
  }

  if (!answer) return send("Что-то пошло не так, повтори, пожалуйста.");

  const newHistory = [...contents, { role: "model", parts: [{ text: answer }] }].slice(-8);
  return send(answer, false, newHistory);
};
