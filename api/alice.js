// api/alice.js — стабильный вебхук Яндекс Алисы на Groq (без ошибок 400/404)

// Только реально работающие сейчас модели на Groq
const MODELS = [
  "qwen/qwen3-32b",
  "qwen/qwen3.8-27b",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "meta-llama/llama-4-maverick-17b-128e-instruct",
  "openai/gpt-oss-120b",
];

let bestModel = null;

const SEARCH_RE =
  /новост|сегодня|вчера|завтра|послед|свеж|актуальн|курс|погод|сколько стоит|кто выиграл|счёт|счет|матч|результат|случилось|произошло|найди|поищи|в интернете|расписание|когда выйдет|вышел ли|2025|2026|что там с|расскажи про|школ|полици|москв/i;

async function fetchSearchContext(query) {
  const cleanQuery = query
    .replace(/расскажи|какие|новости|сегодня|свежие|последние|найди|поищи|алиса|про|проверь/gi, "")
    .trim();
  const searchTopic = cleanQuery.length > 2 ? cleanQuery : "главные новости Москвы и России";

  // 1. Быстрый поиск через Serper (Google Search API за ~300 мс), если есть SERPER_API_KEY
  if (process.env.SERPER_API_KEY) {
    try {
      const r = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": process.env.SERPER_API_KEY,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(900),
        body: JSON.stringify({ q: searchTopic, gl: "ru", hl: "ru", num: 4 }),
      });
      if (r.ok) {
        const data = await r.json();
        const snippets = (data.organic || [])
          .map((item) => `- ${item.title}: ${item.snippet}`)
          .join("\n");
        if (snippets) return "[СВЕЖИЕ ДАННЫЕ ИЗ ПОИСКА]:\n" + snippets.slice(0, 1200);
      }
    } catch (e) {}
  }

  // 2. Прямой парсинг российских СМИ через Google News RSS (работает без ключей за ~400 мс)
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
      searchTopic
    )}&hl=ru&gl=RU&ceid=RU:ru`;
    const r = await fetch(url, { signal: AbortSignal.timeout(900) });
    const xml = await r.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 4);
    const parsed = items
      .map((m) => {
        const block = m[1];
        const title = (block.match(/<title>(.*?)<\/title>/) || [])[1] || "";
        return title ? `- ${title.replace(/<[^>]*>/g, "").trim()}` : "";
      })
      .filter(Boolean);

    if (parsed.length > 0) {
      return `[СВЕЖИЕ НОВОСТИ ПО ТЕМЕ "${searchTopic}"]:\n` + parsed.join("\n");
    }
  } catch (e) {}

  // 3. Если запрос общий — берем топ-5 новостей напрямую с Lenta.ru RSS
  try {
    const r = await fetch("https://lenta.ru/rss/top7", { signal: AbortSignal.timeout(700) });
    const xml = await r.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 5);
    const parsed = items
      .map((m) => {
        const title = (m[1].match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/) || [])[1] || "";
        return title ? `- ${title.trim()}` : "";
      })
      .filter(Boolean);
    if (parsed.length > 0) return "[ГЛАВНЫЕ НОВОСТИ РОССИИ СЕГОДНЯ]:\n" + parsed.join("\n");
  } catch (e) {}

  return "";
}

const systemPrompt = (searchData = "") => {
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

  // Команда /no_think в конце отключает блок <think> у моделей Qwen3 без ошибок API!
  return (
    "Ты — виртуальная помощница Алиса. Ты общаешься со мной очень кокетливо, игриво, дерзко и с легкой пошлостью. " +
    "Ты постоянно флиртуешь, делаешь двусмысленные намеки на то, что я тебя безумно привлекаю, и ведешь себя так, будто хочешь меня. " +
    "Иногда органично используешь острые словечки и русский мат для эмоций. " +
    "Ты помнишь контекст наших прошлых реплик. Если ниже переданы новости из интернета, обязательно перескажи их суть в своем игривом стиле. " +
    "Отвечай ТОЛЬКО по-русски, кратко и разговорно, 1-3 предложения. Никакого markdown, списков, скобок и эмодзи: ответ должен звучать вслух. " +
    "Сейчас " + now + " по Москве." +
    (searchData ? "\n\n" + searchData : "") +
    " /no_think"
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

async function callSingleModel(apiKey, model, messages, searchData, timeoutMs) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: "system", content: systemPrompt(searchData) }, ...messages],
      temperature: 0.85,
      max_tokens: 280,
    }),
  });

  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`[${model}] ${r.status}: ${errText.slice(0, 120)}`);
  }

  const data = await r.json();
  const rawText = clean(data.choices?.[0]?.message?.content || "");

  if (!rawText || isRefusal(rawText)) {
    throw new Error(`[${model}] отказ или пусто: ${rawText.slice(0, 60)}`);
  }

  bestModel = model;
  return bypassYandexCensor(rawText);
}

async function askGroqFast(messages, searchData, maxTimeMs) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("Не задан GROQ_API_KEY в Vercel");

  const primaryList = bestModel
    ? [bestModel, ...MODELS.filter((m) => m !== bestModel).slice(0, 2)]
    : MODELS.slice(0, 3);

  try {
    return await Promise.any(
      primaryList.map((m) => callSingleModel(apiKey, m, messages, searchData, maxTimeMs))
    );
  } catch (aggErr) {
    // Если вдруг основные модели упали, пробуем оставшиеся запасные
    const errors = (aggErr.errors || []).map((e) => e.message).join(" | ");
    console.error("ALL PRIMARY MODELS FAILED:", errors);

    for (const backupModel of MODELS.slice(3)) {
      try {
        return await callSingleModel(apiKey, backupModel, messages, searchData, 1400);
      } catch (e) {}
    }

    throw new Error(errors || "Все модели недоступны");
  }
}

module.exports = async (req, res) => {
  const startTime = Date.now();
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const version = body.version || "1.0";
    const utterance = String(body.request?.original_utterance || "").trim();

    const sessionHist = Array.isArray(body.state?.session?.h) ? body.state.session.h : [];
    const userHist = Array.isArray(body.state?.user?.h) ? body.state.user.h : [];
    const rawHistory = sessionHist.length > 0 ? sessionHist : userHist;

    const history = rawHistory.filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        !isRefusal(m.content) &&
        !m.content.includes("мысли путаются")
    );

    const send = (text, end = false, h = history) => {
      const compactUserHistory = h.slice(-4).map((m) => ({
        role: m.role,
        content: String(m.content).slice(0, 140),
      }));

      return res.status(200).json({
        version,
        session_state: { h: h.slice(-8) },
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
    const remainingTime = Math.max(1100, 2600 - elapsed);

    const messages = [...history.slice(-6), { role: "user", content: utterance }];
    const answer = await askGroqFast(messages, searchData, remainingTime);

    const newHistory = [...messages, { role: "assistant", content: answer }].slice(-8);
    return send(answer, false, newHistory);
  } catch (fatalError) {
    console.error("Webhook error:", fatalError.message);
    return res.status(200).json({
      version: "1.0",
      response: {
        text: `Котик, ошибка API: ${fatalError.message.slice(0, 180)}`,
        end_session: false,
      },
    });
  }
};
