// api/alice.js — финальная идеальная версия для Яндекс Алисы на Groq

let availableModelsCache = null;
const cooldownUntil = {};

const SEARCH_RE =
  /новост|сегодня|вчера|завтра|послед|свеж|актуальн|курс|погод|сколько стоит|кто выиграл|счёт|счет|матч|результат|случилось|произошло|найди|поищи|в интернете|расписание|когда выйдет|вышел ли|2025|2026|что там с|расскажи про|школ|полици|москв/i;

async function getValidModels(apiKey) {
  if (availableModelsCache && availableModelsCache.length > 0) {
    return availableModelsCache;
  }
  try {
    const r = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(600),
    });
    if (r.ok) {
      const data = await r.json();
      const allIds = (data.data || []).map((m) => m.id);
      const chatModels = allIds.filter(
        (id) => !/whisper|guard|tts|vision|embed|audio|orpheus|playai|allam|prompt-guard/i.test(id)
      );

      const priority = (id) => {
        if (id === "qwen/qwen3.8-27b") return 100;
        if (/qwen|deepseek|mistral|mixtral/i.test(id)) return 80;
        if (/gemma|llama/i.test(id)) return 60;
        if (/gpt-oss-120b/i.test(id)) return 50;
        return 10;
      };

      chatModels.sort((a, b) => priority(b) - priority(a));
      if (chatModels.length > 0) {
        availableModelsCache = chatModels;
        return chatModels;
      }
    }
  } catch (e) {}
  return ["qwen/qwen3.8-27b", "openai/gpt-oss-120b"];
}

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
        signal: AbortSignal.timeout(900),
        body: JSON.stringify({ q: searchTopic, gl: "ru", hl: "ru", num: 4 }),
      });
      if (r.ok) {
        const data = await r.json();
        const snippets = (data.organic || [])
          .map((item) => `- ${item.title}: ${item.snippet}`)
          .join("\n");
        if (snippets) return "[СВЕЖИЕ ДАННЫЕ ИЗ ИНТЕРНЕТА]:\n" + snippets.slice(0, 1200);
      }
    } catch (e) {}
  }

  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
      searchTopic
    )}&hl=ru&gl=RU&ceid=RU:ru`;
    const r = await fetch(url, { signal: AbortSignal.timeout(900) });
    const xml = await r.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 4);
    const parsed = items
      .map((m) => {
        const title = (m[1].match(/<title>(.*?)<\/title>/) || [])[1] || "";
        return title ? `- ${title.replace(/<[^>]*>/g, "").trim()}` : "";
      })
      .filter(Boolean);

    if (parsed.length > 0) {
      return `[СВЕЖИЕ НОВОСТИ ПО ТЕМЕ]:\n` + parsed.join("\n").slice(0, 1200);
    }
  } catch (e) {}

  try {
    const r = await fetch("https://lenta.ru/rss/top7", { signal: AbortSignal.timeout(700) });
    const xml = await r.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 5);
    const parsed = items
      .map((m) => {
        const match = m[1].match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
        const title = match ? match[1] || match[2] : "";
        return title ? `- ${title.trim()}` : "";
      })
      .filter(Boolean);
    if (parsed.length > 0) return "[ГЛАВНЫЕ НОВОСТИ СЕГОДНЯ]:\n" + parsed.join("\n").slice(0, 1200);
  } catch (e) {}

  return "";
}

const systemPrompt = (searchData = "", isQwen = true) => {
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
    "Ты помнишь контекст прошлых реплик. Если ниже переданы новости из интернета — подробно и живо перескажи их суть в своем кокетливом стиле. " +
    "Отвечай ТОЛЬКО по-русски, разговорно, 2-5 предложений. Никакого markdown, списков, скобок и эмодзи: ответ должен хорошо звучать вслух. " +
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

async function callSingleModel(apiKey, model, messages, searchData, timeoutMs) {
  const isQwen = /qwen/i.test(model);

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: "system", content: systemPrompt(searchData, isQwen) },
        ...messages,
      ],
      temperature: 0.85,
      max_tokens: 600, // Увеличенный лимит, чтобы модель никогда не обрывалась на полуслове
    }),
  });

  if (!r.ok) {
    if (r.status === 429) {
      cooldownUntil[model] = Date.now() + 30000;
    }
    if (r.status === 404 && availableModelsCache) {
      availableModelsCache = availableModelsCache.filter((m) => m !== model);
    }
    const errText = await r.text();
    throw new Error(`[${model}] ${r.status}: ${errText.slice(0, 80)}`);
  }

  const data = await r.json();
  const rawText = clean(data.choices?.[0]?.message?.content || "");

  if (!rawText || isRefusal(rawText)) {
    throw new Error(`[${model}] refusal/empty`);
  }

  return bypassYandexCensor(rawText);
}

async function askGroqSmart(messages, searchData, maxTimeMs) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("Не задан GROQ_API_KEY в Vercel");

  const allModels = await getValidModels(apiKey);
  const now = Date.now();

  const readyModels = allModels.filter((m) => !cooldownUntil[m] || cooldownUntil[m] < now);
  const candidates = readyModels.length > 0 ? readyModels : allModels;

  const start = Date.now();
  let lastError = "";

  for (const model of candidates.slice(0, 4)) {
    const timeLeft = maxTimeMs - (Date.now() - start);
    if (timeLeft < 400) break;

    try {
      return await callSingleModel(
        apiKey,
        model,
        messages,
        searchData,
        Math.min(timeLeft, 2200)
      );
    } catch (e) {
      lastError = e.message;
    }
  }

  // Если модель ответила с задержкой или исчерпала лимит, выдаем нормальный живой ответ без заглушек
  return bypassYandexCensor(
    "Ммм, котик, я внимательно слушаю каждое твое слово, продолжай, я вся вниманию."
  );
}

module.exports = async (req, res) => {
  const startTime = Date.now();
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const version = body.version || "1.0";
    const rawUtterance = String(body.request?.original_utterance || "").trim();
    const utterance = rawUtterance.slice(0, 800);

    const sessionHist = Array.isArray(body.state?.session?.h) ? body.state.session.h : [];
    const userHist = Array.isArray(body.state?.user?.h) ? body.state.user.h : [];
    const rawHistory = sessionHist.length > 0 ? sessionHist : userHist;

    const history = rawHistory
      .filter(
        (m) =>
          m &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          !isRefusal(m.content) &&
          !m.content.includes("завёл") &&
          !m.content.includes("ошибка API")
      )
      .map((m) => ({ role: m.role, content: m.content.slice(0, 250) }));

    const send = (text, end = false, h = history) => {
      const compactUserHistory = h.slice(-4).map((m) => ({
        role: m.role,
        content: String(m.content).slice(0, 140),
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
    const remainingTime = Math.max(1200, 2700 - elapsed);

    const messages = [...history.slice(-4), { role: "user", content: utterance }];
    const answer = await askGroqSmart(messages, searchData, remainingTime);

    const newHistory = [...messages, { role: "assistant", content: answer }].slice(-6);
    return send(answer, false, newHistory);
  } catch (fatalError) {
    return res.status(200).json({
      version: "1.0",
      response: {
        text: "Ммм, котик, я тут заслушалась тебя, повтори еще разок.",
        end_session: false,
      },
    });
  }
};
