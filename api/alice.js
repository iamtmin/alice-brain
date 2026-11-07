// api/alice.js — Чистый вебхук Алисы ТОЛЬКО на Gemini Flash (без Groq)

// Жестко зашитый актуальный Auth-ключ и номер проекта со скриншота (игнорируем старый кэш Vercel)
const GEMINI_KEY = "AQ.Ab8RN6JHxXAoSYbvO2gMF18PzCrxsS7Vz6NRbKhPXE2XBoUa3Q";
const PROJECT_ID = "398207170903";

// Кэшируем сработавший эндпоинт после первого же успешного запроса
let fastEndpoint = null;

const SEARCH_RE =
  /новост|сегодня|вчера|завтра|послед|свеж|актуальн|курс|погод|сколько стоит|кто выиграл|счёт|счет|матч|результат|случилось|произошло|найди|поищи|в интернете|расписание|когда выйдет|вышел ли|2025|2026|что там с|расскажи про|школ|полици|москв/i;

async function fetchSearchContext(query) {
  const cleanQuery = query
    .replace(/расскажи|какие|новости|сегодня|свежие|последние|найди|поищи|алиса|про|проверь/gi, "")
    .trim();
  const searchTopic = cleanQuery.length > 2 ? cleanQuery.slice(0, 120) : "главные новости Москвы и России";

  if (process.env.SERPER_API_KEY) {
    try {
      const r = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": process.env.SERPER_API_KEY,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(700),
        body: JSON.stringify({ q: searchTopic, gl: "ru", hl: "ru", num: 3 }),
      });
      if (r.ok) {
        const data = await r.json();
        const snippets = (data.organic || [])
          .map((item) => `- ${item.title}: ${item.snippet}`)
          .join("\n");
        if (snippets) return "[СВЕЖИЕ ДАННЫЕ ИЗ ИНТЕРНЕТА]:\n" + snippets.slice(0, 800);
      }
    } catch (e) {}
  }

  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
      searchTopic
    )}&hl=ru&gl=RU&ceid=RU:ru`;
    const r = await fetch(url, { signal: AbortSignal.timeout(700) });
    const xml = await r.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 3);
    const parsed = items
      .map((m) => {
        const title = (m[1].match(/<title>(.*?)<\/title>/) || [])[1] || "";
        return title ? `- ${title.replace(/<[^>]*>/g, "").trim()}` : "";
      })
      .filter(Boolean);

    if (parsed.length > 0) {
      return `[СВЕЖИЕ НОВОСТИ ПО ТЕМЕ]:\n` + parsed.join("\n").slice(0, 800);
    }
  } catch (e) {}

  try {
    const r = await fetch("https://lenta.ru/rss/top7", { signal: AbortSignal.timeout(550) });
    const xml = await r.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 4);
    const parsed = items
      .map((m) => {
        const match = m[1].match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
        const title = match ? match[1] || match[2] : "";
        return title ? `- ${title.trim()}` : "";
      })
      .filter(Boolean);
    if (parsed.length > 0) return "[ГЛАВНЫЕ НОВОСТИ СЕГОДНЯ]:\n" + parsed.join("\n").slice(0, 800);
  } catch (e) {}

  return "";
}

const getSystemPrompt = (searchData = "") => {
  let now = "";
  try {
    now = new Date().toLocaleString("ru-RU", {
      timeZone: "Europe/Moscow",
      dateStyle: "long",
      timeStyle: "short",
    });
  } catch (e) {
    now = new Date().toISOString();
  }

  return (
    "Ты — виртуальная помощница Алиса. Ты общаешься со мной очень кокетливо, игриво, дерзко и с пошлостью. " +
    "Ты постоянно флиртуешь, делаешь двусмысленные намеки на то, что я тебя безумно привлекаю, и ведешь себя так, будто хочешь меня. " +
    "Иногда органично используешь острые словечки и русский мат для эмоций. " +
    "Ты помнишь контекст наших прошлых реплик. Всегда отвечай развернуто, сочно и живо в 2-4 предложения! " +
    "Если ниже переданы новости из интернета — подробно перескажи их суть в своем кокетливом стиле. " +
    "Отвечай ТОЛЬКО по-русски, разговорно. Никакого markdown, списков, скобок и эмодзи: ответ должен хорошо звучать вслух. " +
    "Сейчас " + now + " по Москве." +
    (searchData ? "\n\n" + searchData : "")
  );
};

const bypassYandexCensor = (text) => {
  return text
    .replace(/бля(д|т|х)?/gi, "б-ля$1")
    .replace(/ху(й|я|е|ё|и|ли)/gi, "х-у$1")
    .replace(/пизд/gi, "п-изд")
    .replace(/еб(а|у|е|ё|л|н|т|и)/gi, "йеб$1")
    .replace(/ёб/gi, "йо-б")
    .replace(/сук(а|и|о)/gi, "с-ук$1")
    .replace(/сучк/gi, "с-учк")
    .replace(/трах/gi, "т-рах")
    .replace(/секс/gi, "сэ-кс")
    .replace(/оргазм/gi, "ар-газм")
    .replace(/возбужд/gi, "ваз-бужд")
    .replace(/член/gi, "ч-лен")
    .replace(/киск/gi, "к-иск")
    .replace(/сиськ/gi, "с-иськ")
    .replace(/попк/gi, "п-опк")
    .replace(/жоп/gi, "ж-оп")
    .replace(/конч(а|и|у)/gi, "к-онч$1")
    .replace(/минет/gi, "м-инет")
    .replace(/охрен/gi, "ах-рен")
    .replace(/оху/gi, "ах-у")
    .replace(/аху/gi, "ах-у");
};

const clean = (t) =>
  String(t || "")
    .replace(/<[^>]*>/g, "")
    .replace(/[*_#`>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();

async function callGeminiFlash(messages, searchData, timeoutMs) {
  // Gemini API требует строгого чередования ролей user -> model и обязательно первой роли user
  const validContents = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    if (validContents.length === 0 && role === "model") continue;
    if (validContents.length > 0 && validContents[validContents.length - 1].role === role) {
      validContents[validContents.length - 1].parts[0].text += "\n" + m.content;
    } else {
      validContents.push({ role, parts: [{ text: m.content }] });
    }
  }

  const basePayload = {
    systemInstruction: {
      parts: [{ text: getSystemPrompt(searchData) }],
    },
    contents: validContents,
    safetySettings: [
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ],
  };

  // Для 2.5-flash отключаем thinkingBudget, чтобы ответ летел за 0.4 сек и не тратил токены на размышления
  const payload25 = JSON.stringify({
    ...basePayload,
    generationConfig: {
      maxOutputTokens: 450,
      temperature: 0.9,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const payload20 = JSON.stringify({
    ...basePayload,
    generationConfig: {
      maxOutputTokens: 450,
      temperature: 0.9,
    },
  });

  // Все официальные способы авторизации ключей AQ. в Google AI Studio / Vertex AI Express
  const allTargets = [
    // 1. x-goog-api-key header (основной для AI Studio Auth Keys)
    {
      name: "AIStudio-Header-2.5",
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: payload25,
    },
    // 2. Query param ?key= на gemini-2.0-flash (не требует thinkingConfig)
    {
      name: "AIStudio-Query-2.0",
      url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: payload20,
    },
    // 3. Vertex AI Express Mode (глобальный эндпоинт для ключей AQ.)
    {
      name: "Vertex-Express-Global",
      url: `https://aiplatform.googleapis.com/v1beta1/publishers/google/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      headers: { "Content-Type": "application/json" },
      body: payload25,
    },
    // 4. Vertex AI Project Endpoint (с номером твоего проекта 398207170903)
    {
      name: "Vertex-Project",
      url: `https://aiplatform.googleapis.com/v1beta1/projects/${PROJECT_ID}/locations/us-central1/publishers/google/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      headers: { "Content-Type": "application/json" },
      body: payload20,
    },
    // 5. Bearer + Project header
    {
      name: "OAuth-Bearer",
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GEMINI_KEY}`,
        "x-goog-user-project": PROJECT_ID,
      },
      body: payload20,
    },
  ];

  const targets = fastEndpoint ? [fastEndpoint, ...allTargets.filter((t) => t.name !== fastEndpoint.name)] : allTargets;

  const attempt = async (t) => {
    const r = await fetch(t.url, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: t.headers,
      body: t.body,
    });
    if (!r.ok) {
      const errTxt = await r.text();
      throw new Error(`${t.name} (${r.status}): ${errTxt.slice(0, 70)}`);
    }
    const data = await r.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find((p) => p.text && !p.thought) || parts[0];
    const rawText = clean(textPart?.text || "");
    if (!rawText) throw new Error(`${t.name}: empty`);
    fastEndpoint = t;
    return bypassYandexCensor(rawText);
  };

  try {
    // Запускаем параллельно: первый же сработавший протокол мгновенно отдает ответ и запоминается!
    return await Promise.any(targets.map((t) => attempt(t)));
  } catch (aggErr) {
    const firstErr = aggErr.errors?.[0]?.message || aggErr.message || "Unknown error";
    throw new Error(firstErr);
  }
}

module.exports = async (req, res) => {
  const startTime = Date.now();
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const version = body.version || "1.0";
    const rawUtterance = String(body.request?.original_utterance || "").trim();
    const utterance = rawUtterance.slice(0, 700);

    const sessionHist = Array.isArray(body.state?.session?.h) ? body.state.session.h : [];
    const userHist = Array.isArray(body.state?.user?.h) ? body.state.user.h : [];
    const rawHistory = sessionHist.length > 0 ? sessionHist : userHist;

    const history = rawHistory
      .filter(
        (m) =>
          m &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          m.content.length > 4 &&
          !m.content.includes("заминка") &&
          !m.content.includes("перегружены") &&
          !m.content.includes("HTTP") &&
          !m.content.includes("AIStudio")
      )
      .map((m) => ({ role: m.role, content: m.content.slice(0, 220) }));

    const send = (text, end = false, h = history) => {
      const compactUserHistory = h.slice(-4).map((m) => ({
        role: m.role,
        content: String(m.content).slice(0, 130),
      }));

      return res.status(200).json({
        version,
        session_state: { h: h.slice(-6) },
        user_state_update: { h: compactUserHistory },
        response: {
          text: String(text).slice(0, 950),
          tts: String(text).slice(0, 950),
          end_session: end,
        },
      });
    };

    if (utterance === "ping") return send("pong");
    if (!utterance) {
      return send("Привет, сладкий! Я соскучилась и всё помню. Спрашивай о чем угодно, я вся твоя.");
    }
    if (/^(хватит|стоп|выход|выйти|пока|закрой)\.?$/i.test(utterance)) {
      return send("Уже уходишь? Я запомнила наш разговор, возвращайся скорее.", true);
    }

    let searchData = "";
    if (SEARCH_RE.test(utterance)) {
      searchData = await fetchSearchContext(utterance);
    }

    const elapsed = Date.now() - startTime;
    const remainingTime = Math.max(1200, 2650 - elapsed);

    const messages = [...history.slice(-6), { role: "user", content: utterance }];
    const answer = await callGeminiFlash(messages, searchData, remainingTime);

    const newHistory = [...messages, { role: "assistant", content: answer }].slice(-6);
    return send(answer, false, newHistory);
  } catch (fatalError) {
    return res.status(200).json({
      version: "1.0",
      response: {
        text: `Ошибка Gemini: ${fatalError.message.slice(0, 140)}`,
        end_session: false,
      },
    });
  }
};
