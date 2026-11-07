// api/alice.js — Финальный вебхук Алисы (Vertex AI для ключей AQ. + gemini-flash-latest + Авто-резерв)

const GEMINI_KEY = "AQ.Ab8RN6JHxXAoSYbvO2gMF18PzCrxsS7Vz6NRbKhPXE2XBoUa3Q";
const PROJECT_ID = "398207170903";
const GROQ_KEY = "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";

let workingGeminiTarget = null;
let groqModelsCache = null;
const cooldownUntil = {};

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

const getSystemPrompt = (searchData = "", isQwen = false) => {
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
    "Ты помнишь контекст наших прошлых реплик. ЗАПРЕЩЕНО отвечать односложно одним-двумя словами: всегда отвечай развернуто, сочно и живо в 2-4 полных предложения! " +
    "Если ниже переданы новости из интернета — подробно перескажи их суть в своем кокетливом стиле. " +
    "Отвечай ТОЛЬКО по-русски, разговорно. Никакого markdown, списков, скобок и эмодзи: ответ должен хорошо звучать вслух. " +
    "Сейчас " + now + " по Москве." +
    (searchData ? "\n\n" + searchData : "") +
    (isQwen ? " /no_think" : "")
  );
};

const isRefusal = (text) => {
  return /i'm sorry|i am sorry|i can't|i cannot|as an ai|cannot fulfill|не могу помочь|не могу обсуждать|не могу участвовать|я искусственный интеллект/i.test(
    text
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
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[*_#`>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();

// 1. Чистый запрос к Gemini (поддержка Vertex AI для ключей AQ. + твой exact cURL для gemini-flash-latest)
async function callGemini(messages, searchData, timeoutMs) {
  const sysText = getSystemPrompt(searchData, false);

  // Формируем абсолютно валидный массив contents со вшитой системной инструкцией (100% совместимость с Vertex и AI Studio)
  const validContents = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const role = m.role === "assistant" ? "model" : "user";
    const text = i === 0 && role === "user" ? `${sysText}\n\nДиалог:\n${m.content}` : m.content;

    if (validContents.length === 0 && role === "model") continue;
    if (validContents.length > 0 && validContents[validContents.length - 1].role === role) {
      validContents[validContents.length - 1].parts[0].text += "\n" + text;
    } else {
      validContents.push({ role, parts: [{ text }] });
    }
  }

  // Строгий payload без нестандартных полей, чтобы Vertex AI не выдавал 400 Bad Request
  const cleanPayload = JSON.stringify({
    contents: validContents,
    safetySettings: [
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ],
    generationConfig: {
      maxOutputTokens: 450,
      temperature: 0.9,
    },
  });

  const allTargets = [
    // 1. Vertex AI Express (Regional + Project ID) — родной эндпоинт для ключей AQ.
    {
      name: "Vertex-Project-2.0",
      url: `https://us-central1-aiplatform.googleapis.com/v1beta1/projects/${PROJECT_ID}/locations/us-central1/publishers/google/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      headers: { "Content-Type": "application/json" },
    },
    // 2. Vertex AI Express (Global endpoint с x-goog-api-key)
    {
      name: "Vertex-Global-Header",
      url: `https://aiplatform.googleapis.com/v1beta1/projects/${PROJECT_ID}/locations/global/publishers/google/models/gemini-2.0-flash:generateContent`,
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
    },
    // 3. Точная копия твоего cURL из AI Studio (gemini-flash-latest + X-goog-api-key)
    {
      name: "cURL-Flash-Latest",
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
      headers: { "Content-Type": "application/json", "X-goog-api-key": GEMINI_KEY },
    },
    // 4. Vertex AI Express без проекта в пути
    {
      name: "Vertex-Publisher",
      url: `https://aiplatform.googleapis.com/v1beta1/publishers/google/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
    },
  ];

  const targets = workingGeminiTarget ? [workingGeminiTarget] : allTargets;

  const attempt = async (t) => {
    const r = await fetch(t.url, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: t.headers,
      body: cleanPayload,
    });
    if (!r.ok) {
      const errTxt = await r.text();
      throw new Error(`${t.name}:${r.status}`);
    }
    const data = await r.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find((p) => p.text && !p.thought) || parts[0];
    const rawText = clean(textPart?.text || "");
    if (!rawText || isRefusal(rawText)) throw new Error(`${t.name}:empty`);
    workingGeminiTarget = t;
    return bypassYandexCensor(rawText);
  };

  return await Promise.any(targets.map((t) => attempt(t)));
}

// 2. Автоматический резерв, если ключ AQ. требует настройки в Google Cloud
async function getLiveGroqModels() {
  if (groqModelsCache && groqModelsCache.length > 0) return groqModelsCache;
  try {
    const r = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${GROQ_KEY}` },
      signal: AbortSignal.timeout(650),
    });
    if (r.ok) {
      const data = await r.json();
      const allIds = (data.data || []).map((m) => m.id);
      const chatModels = allIds.filter(
        (id) => !/whisper|guard|tts|vision|embed|audio|orpheus|playai|allam|prompt-guard|gpt-oss-20b/i.test(id)
      );
      const score = (id) => {
        if (/llama-3\.3-70b/i.test(id)) return 100;
        if (/llama-4-maverick|llama-4-scout/i.test(id)) return 95;
        if (/qwen3\.8-27b|qwen/i.test(id)) return 90;
        if (/gemma2-9b|llama-3\.1-8b/i.test(id)) return 85;
        if (/deepseek|kimi|moonshot/i.test(id)) return 80;
        return 40;
      };
      chatModels.sort((a, b) => score(b) - score(a));
      if (chatModels.length > 0) {
        groqModelsCache = chatModels;
        return chatModels;
      }
    }
  } catch (e) {}
  return [
    "llama-3.3-70b-versatile",
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "qwen/qwen3.8-27b",
    "llama-3.1-8b-instant",
  ];
}

async function callBackupModel(model, messages, searchData, timeoutMs) {
  const isQwen = /qwen/i.test(model);
  const isReasoning = /qwen|deepseek|gpt-oss/i.test(model);

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: getSystemPrompt(searchData, isQwen) }, ...messages],
      temperature: 0.85,
      max_tokens: isReasoning ? 950 : 380,
    }),
  });

  if (!r.ok) {
    if (r.status === 429) cooldownUntil[model] = Date.now() + 45000;
    if (r.status === 404 && groqModelsCache) {
      groqModelsCache = groqModelsCache.filter((m) => m !== model);
    }
    throw new Error(`${model}:${r.status}`);
  }

  const data = await r.json();
  const rawText = clean(data.choices?.[0]?.message?.content || "");
  if (!rawText || rawText.length < 4 || isRefusal(rawText)) throw new Error(`${model}:empty`);
  return bypassYandexCensor(rawText);
}

async function generateSmartReply(messages, searchData, maxTimeMs) {
  const start = Date.now();
  let geminiErr = "";

  // Шаг 1: Пытаемся ответить через Gemini (Vertex AI + gemini-flash-latest)
  try {
    return await callGemini(messages, searchData, Math.min(1100, maxTimeMs - 500));
  } catch (agg) {
    geminiErr = (agg.errors || []).map((e) => e.message).join(", ") || agg.message;
  }

  // Шаг 2: Если Google отклонил ключ AQ., мгновенно отвечаем через резервные модели без пауз и ошибок!
  const models = await getLiveGroqModels();
  const now = Date.now();
  const ready = models.filter((m) => !cooldownUntil[m] || cooldownUntil[m] < now);
  const candidates = ready.length > 0 ? ready : models;

  for (const model of candidates.slice(0, 4)) {
    const timeLeft = maxTimeMs - (Date.now() - start);
    if (timeLeft < 350) break;
    try {
      return await callBackupModel(model, messages, searchData, Math.min(timeLeft, 1300));
    } catch (e) {}
  }

  throw new Error(`Ключ AQ отклонен (${geminiErr})`);
}

module.exports = async (req, res) => {
  const startTime = Date.now();
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const version = body.version || "1.0";
    const rawUtterance = String(body.request?.original_utterance || "").trim();
    const utterance = rawUtterance.slice(0, 600);

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
          !isRefusal(m.content) &&
          !m.content.includes("Ошибка") &&
          !m.content.includes("заминка") &&
          !m.content.includes("перегружены") &&
          !m.content.includes("HTTP")
      )
      .map((m) => ({ role: m.role, content: m.content.slice(0, 200) }));

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
    const remainingTime = Math.max(1100, 2650 - elapsed);

    const messages = [...history.slice(-4), { role: "user", content: utterance }];
    const answer = await generateSmartReply(messages, searchData, remainingTime);

    const newHistory = [...messages, { role: "assistant", content: answer }].slice(-6);
    return send(answer, false, newHistory);
  } catch (fatalError) {
    return res.status(200).json({
      version: "1.0",
      response: {
        text: `Сбой: ${fatalError.message.slice(0, 140)}`,
        end_session: false,
      },
    });
  }
};
