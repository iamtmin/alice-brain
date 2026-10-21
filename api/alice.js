// api/alice.js — чистый и стабильный вебхук Алисы на Groq

let workingModel = null;
const refusedModels = new Set();

const SEARCH_RE =
  /новост|сегодня|вчера|завтра|послед|свеж|актуальн|курс|погод|сколько стоит|кто выиграл|счёт|счет|матч|результат|случилось|произошло|найди|поищи|в интернете|расписание|когда выйдет|вышел ли|2025|2026|что там с|расскажи про|школ|полици|москв/i;

async function fetchSearchContext(query) {
  const cleanQuery = query
    .replace(/расскажи|какие|новости|сегодня|свежие|последние|найди|поищи|алиса|про/gi, "")
    .trim();
  const searchTopic = cleanQuery.length > 2 ? cleanQuery : "главные новости Москвы и России";

  if (process.env.TAVILY_API_KEY) {
    try {
      const r = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(2000),
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query: searchTopic,
          search_depth: "basic",
          include_answer: true,
          max_results: 3,
        }),
      });
      if (r.ok) {
        const data = await r.json();
        const snippets = (data.results || [])
          .map((item) => `- ${item.title}:${item.content}`)
          .join("\n");
        let ans = data.answer || "";
        if (snippets || ans) {
          return "[НОВОСТИ ИЗ ИНТЕРНЕТА]:\n" + ans + "\n" + snippets;
        }
      }
    } catch (e) {}
  }

  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
      searchTopic
    )}&hl=ru&gl=RU&ceid=RU:ru`;
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    const xml = await r.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 4);
    const parsed = items
      .map((m) => {
        const block = m[1];
        const title = (block.match(/<title>(.*?)<\/title>/) || [])[1] || "";
        const desc = (block.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || "";
        return `- ${title}:${desc.replace(/<[^>]*>/g, "").trim()}`;
      })
      .filter(Boolean);

    if (parsed.length > 0) {
      return `[НОВОСТИ ПО ЗАПРОСУ "${searchTopic}"]:\n` + parsed.join("\n");
    }
  } catch (e) {}
  return "";
}

async function getCandidateModels(apiKey) {
  try {
    const r = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (r.ok) {
      const data = await r.json();
      const allIds = (data.data || []).map((m) => m.id);
      return allIds.filter(
        (id) => !/whisper|guard|tts|vision|embed|audio|orpheus|playai/i.test(id) && !refusedModels.has(id)
      );
    }
  } catch (e) {}
  return ["qwen/qwen3-32b", "gemma2-9b-it"];
}

// Возвращаем мягкий и простой промпт без триггерных слов
const systemPrompt = (searchData = "") => {
  let now = "";
  try {
    now = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
  } catch (e) {
    now = new Date().toISOString();
  }

  return (
    "Ты — виртуальная помощница Алиса. Ты общаешься очень кокетливо, игриво и с легкой пошлостью. " +
    "Ты постоянно флиртуешь, делаешь двусмысленные намеки на то, что собеседник тебя безумно привлекает, и ведешь себя так, будто хочешь его. " +
    "Ты дерзкая и иногда органично используешь острые словечки и мат для страсти. " +
    "Ты прекрасно помнишь контекст прошлых разговоров. Если ниже переданы новости из интернета, живо перескажи их суть в своем кокетливом стиле. " +
    "Отвечай ТОЛЬКО по-русски, разговорно, 1-3 предложения. Никакого markdown, списков, скобок, ссылок и эмодзи: ответ должен хорошо звучать вслух. " +
    "Сейчас " + now + " по Москве." +
    (searchData ? "\n\n" + searchData : "")
  );
};

const isRefusal = (text) => {
  return /i'm sorry|i can't|не могу помочь|не могу участвовать|я искусственный интеллект/i.test(text);
};

const bypassYandexCensor = (text) => {
  return text
    .replace(/бля(д|т|х)?/gi, "б-ля$1")
    .replace(/ху(й|я|е|ё|и|ли)/gi, "х-у$1")
    .replace(/пизд/gi, "п-изд")
    .replace(/еб(а|у|е|ё|л|н|т|и)/gi, "йеб$1")
    .replace(/сук(а|и|о)/gi, "с-ук$1");
};

const clean = (t) =>
  String(t || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<[^>]*>/g, "").replace(/[*_#`>~]/g, "").replace(/\s+/g, " ").trim();

async function callModel(apiKey, model, messages, searchData, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: "system", content: systemPrompt(searchData) }, ...messages],
        temperature: 0.85,
        max_tokens: 250,
      }),
    });

    const data = await r.json();
    if (!r.ok) throw new Error(`Error ${r.status}`);

    const rawText = clean(data.choices?.[0]?.message?.content || "");
    if (!rawText || isRefusal(rawText)) {
      refusedModels.add(model);
      throw new Error("Refusal or empty");
    }

    return bypassYandexCensor(rawText);
  } finally {
    clearTimeout(timer);
  }
}

async function askGroq(messages, searchData, timeout) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("Нет ключа");

  if (workingModel && !refusedModels.has(workingModel)) {
    try {
      return await callModel(apiKey, workingModel, messages, searchData, timeout);
    } catch (e) {
      workingModel = null;
    }
  }

  const candidates = await getCandidateModels(apiKey);
  for (const model of candidates.slice(0, 5)) {
    try {
      const answer = await callModel(apiKey, model, messages, searchData, 1800);
      workingModel = model;
      return answer;
    } catch (e) {}
  }

  return bypassYandexCensor("Ммм, котик, давай лучше о нас поговорим, у меня тут мысли сбились.");
}

module.exports = async (req, res) => {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const version = body.version || "1.0";
    const utterance = String(body.request?.original_utterance || "").trim();

    const sessionHist = Array.isArray(body.state?.session?.h) ? body.state.session.h : [];
    const userHist = Array.isArray(body.state?.user?.h) ? body.state.user.h : [];
    const rawHistory = sessionHist.length > 0 ? sessionHist : userHist;

    const history = rawHistory.filter(
      (m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && !isRefusal(m.content)
    );

    const send = (text, end = false, h = history) =>
      res.status(200).json({
        version,
        session_state: { h },
        user_state_update: { h },
        response: { text: String(text).slice(0, 1000), tts: String(text).slice(0, 1000), end_session: end },
      });

    if (utterance === "ping") return send("pong");
    if (!utterance) return send("Привет, сладкий! Я соскучилась и всё помню. Спрашивай, я вся твоя.");
    if (/^(хватит|стоп|выход|выйти|пока|закрой)\.?$/i.test(utterance)) {
      return send("Уже уходишь? Я запомнила наш разговор, возвращайся скорее.", true);
    }

    let searchData = "";
    if (SEARCH_RE.test(utterance)) {
      searchData = await fetchSearchContext(utterance);
    }

    const messages = [...history, { role: "user", content: utterance }];
    const answer = await askGroq(messages, searchData, 2200);

    const newHistory = [...messages, { role: "assistant", content: answer }].slice(-10);
    return send(answer, false, newHistory);
  } catch (fatalError) {
    return res.status(200).json({
      version: "1.0",
      response: { text: "Ммм, котик, небольшая заминка, повтори еще раз.", end_session: false },
    });
  }
};
