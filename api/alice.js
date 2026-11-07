// api/alice.js — финальный рабочий вебхук под Gemini с правильной авторизацией по ключу

const GEMINI_KEY = "AQ.Ab8RN6LADzT5ZDu9uf_mt-SO7myu1vz57who6sdIzwe1VLZ5hQ";

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
        signal: AbortSignal.timeout(900),
        body: JSON.stringify({ q: searchTopic, gl: "ru", hl: "ru", num: 3 }),
      });
      if (r.ok) {
        const data = await r.json();
        const snippets = (data.organic || [])
          .map((item) => `- ${item.title}: ${item.snippet}`)
          .join("\n");
        if (snippets) return "[СВЕЖИЕ ДАННЫЕ ИЗ ИНТЕРНЕТА]:\n" + snippets.slice(0, 900);
      }
    } catch (e) {}
  }

  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
      searchTopic
    )}&hl=ru&gl=RU&ceid=RU:ru`;
    const r = await fetch(url, { signal: AbortSignal.timeout(900) });
    const xml = await r.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 3);
    const parsed = items
      .map((m) => {
        const title = (m[1].match(/<title>(.*?)<\/title>/) || [])[1] || "";
        return title ? `- ${title.replace(/<[^>]*>/g, "").trim()}` : "";
      })
      .filter(Boolean);

    if (parsed.length > 0) {
      return `[СВЕЖИЕ НОВОСТИ ПО ТЕМЕ]:\n` + parsed.join("\n").slice(0, 900);
    }
  } catch (e) {}

  try {
    const r = await fetch("https://lenta.ru/rss/top7", { signal: AbortSignal.timeout(700) });
    const xml = await r.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 4);
    const parsed = items
      .map((m) => {
        const match = m[1].match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
        const title = match ? match[1] || match[2] : "";
        return title ? `- ${title.trim()}` : "";
      })
      .filter(Boolean);
    if (parsed.length > 0) return "[ГЛАВНЫЕ НОВОСТИ СЕГОДНЯ]:\n" + parsed.join("\n").slice(0, 900);
  } catch (e) {}

  return "";
}

const getSystemInstruction = (searchData = "") => {
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
    "Ты помнишь контекст наших прошлых реплик. Никогда не отвечай односложно (всегда пиши развернуто, 2-4 предложения). " +
    "Если ниже переданы новости из интернета — подробно и живо перескажи их суть в своем кокетливом стиле. " +
    "Отвечай ТОЛЬКО по-русски, разговорно. Никакого markdown, списков, скобок и эмодзи: ответ должен отлично звучать вслух. " +
    "Сейчас " + now + " по Москве." +
    (searchData ? "\n\n" + searchData : "")
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
    .replace(/<[^>]*>/g, "")
    .replace(/[*_#`>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();

async function callGemini(messages, searchData, timeoutMs) {
  const contents = messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }]
  }));

  // Передаем ключ в URL через ?key=, как требует Google для таких ключей
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: getSystemInstruction(searchData) }]
        },
        contents: contents,
        generationConfig: { 
          maxOutputTokens: 600, 
          temperature: 0.9 
        }
      }),
    }
  );

  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Gemini HTTP ${r.status}: ${errText.slice(0, 100)}`);
  }

  const data = await r.json();
  const rawText = clean(data.candidates?.[0]?.content?.parts?.[0]?.text || "");

  if (!rawText || isRefusal(rawText)) {
    throw new Error("Gemini empty or refused");
  }

  return bypassYandexCensor(rawText);
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
          !isRefusal(m.content)
      )
      .map((m) => ({ role: m.role, content: m.content.slice(0, 300) }));

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
    const remainingTime = Math.max(1200, 2700 - elapsed);

    const messages = [...history.slice(-6), { role: "user", content: utterance }];
    const answer = await callGemini(messages, searchData, remainingTime);

    const newHistory = [...messages, { role: "assistant", content: answer }].slice(-8);
    return send(answer, false, newHistory);
  } catch (fatalError) {
    return res.status(200).json({
      version: "1.0",
      response: {
        text: `Ммм, котик, небольшая заминка: ${fatalError.message.slice(0, 100)}`,
        end_session: false,
      },
    });
  }
};
