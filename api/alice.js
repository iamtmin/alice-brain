// api/alice.js — вебхук навыка Яндекс Алисы на Gemini (с поиском Google для свежих фактов)

const SMART = "gemini-2.5-flash";
const LITE = "gemini-2.5-flash-lite";

// Если в реплике есть такие слова, подключаем поиск Google
const SEARCH_RE =
  /новост|сегодня|сейчас|вчера|завтра|послед|свеж|актуальн|курс|погод|цен[аыу]|сколько стоит|кто выиграл|счёт|счет|матч|результат|происходит|случилось|найди|поищи|погугли|в интернете|расписание|когда выйдет|вышел|2025|2026/i;

const systemPrompt = () => {
  const now = new Date().toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    dateStyle: "full",
    timeStyle: "short",
  });
  return (
    "Ты умный, живой и остроумный голосовой собеседник в Яндекс Алисе. " +
    "Можешь обсуждать любые темы: наука, учёба, жизнь, советы, шутки, идеи. " +
    "Отвечай по-русски, разговорно, 2-4 предложения. Никакого markdown, списков, ссылок и эмодзи: " +
    "ответ должен хорошо звучать вслух. Если вопрос про новости, цены, события или свежие факты, " +
    "опирайся на поиск и коротко назови источник. Если не знаешь, так и скажи. " +
    `Сейчас ${now} по Москве.`
  );
};

const clean = (t) =>
  t
    .replace(/\[\d+(?:,\s*\d+)*\]/g, "")
    .replace(/[*_#`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();

async function ask(model, search, contents, timeout) {
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
          tools: search ? [{ google_search: {} }] : undefined,
          generationConfig: {
            maxOutputTokens: 350,
            temperature: 0.8,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }
    );
    const data = await r.json();
    if (!r.ok) throw new Error(`${model} ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
    const text = clean(
      (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("")
    );
    if (!text) throw new Error(`${model} empty answer`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

const safe = (p) =>
  p.catch((e) => {
    console.error(String(e.message || e.name).slice(0, 400));
    return null;
  });

module.exports = async (req, res) => {
  const body = req.body || {};
  const version = body.version || "1.0";
  const utterance = ((body.request && body.request.original_utterance) || "").trim();
  const history = (body.state && body.state.session && body.state.session.h) || [];

  const send = (text, end = false, h = history) =>
    res.status(200).json({
      version,
      session_state: { h },
      response: { text: text.slice(0, 1000), end_session: end },
    });

  if (utterance === "ping") return send("pong");
  if (!utterance) return send("Привет! Я подключена к Gemini. Спрашивай что угодно, хоть про свежие новости.");
  if (/^(хватит|стоп|выход|выйти|пока|закрой)\.?$/i.test(utterance))
    return send("Хорошо, до связи!", true);

  const contents = [...history, { role: "user", parts: [{ text: utterance }] }];
  const wantsSearch = SEARCH_RE.test(utterance);

  // Запасной быстрый ответ стартует параллельно, чтобы успеть в лимит Яндекса (~4,5 с)
  const lite = safe(ask(LITE, false, contents, 3700));

  let answer = wantsSearch
    ? await safe(ask(SMART, true, contents, 3600))
    : await safe(ask(SMART, false, contents, 2700));
  if (!answer) answer = await lite;

  if (!answer) return send("Я не успела подумать. Повтори вопрос, пожалуйста.");

  const newHistory = [...contents, { role: "model", parts: [{ text: answer }] }].slice(-8);
  return send(answer, false, newHistory);
};
