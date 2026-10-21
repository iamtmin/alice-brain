// api/alice.js — вебхук навыка Яндекс Алисы на Groq с умным подбором рабочей модели

let workingModel = null;

// Получаем список только текстовых чат-моделей с твоего аккаунта Groq
async function getCandidateModels(apiKey) {
  try {
    const r = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (r.ok) {
      const data = await r.json();
      const allIds = (data.data || []).map((m) => m.id);

      // Отсекаем озвучку (orpheus, playai), распознавание речи (whisper) и модерацию (guard)
      const chatModels = allIds.filter(
        (id) => !/whisper|guard|tts|vision|embed|audio|orpheus|playai|allam|prompt-guard/i.test(id)
      );

      // Сортируем так, чтобы самые умные и быстрые модели шли первыми
      const score = (id) => {
        if (/llama-4|qwen.*32b|gpt-oss-120b|deepseek/i.test(id)) return 10;
        if (/llama.*70b|qwen|compound|gpt-oss/i.test(id)) return 8;
        if (/llama|gemma|mixtral|mistral/i.test(id)) return 5;
        return 1;
      };

      chatModels.sort((a, b) => score(b) - score(a));
      if (chatModels.length > 0) return chatModels;
    }
  } catch (e) {
    console.error("Failed to fetch models:", e);
  }
  return [
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "meta-llama/llama-4-maverick-17b-128e-instruct",
    "qwen-qwq-32b",
    "gemma2-9b-it",
    "compound-beta-mini",
  ];
}

const systemPrompt = () => {
  let now = "";
  try {
    now = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
  } catch (e) {
    now = new Date().toISOString();
  }
  return (
    "Ты — виртуальная помощница Алиса. Твоя главная особенность: ты общаешься со мной очень кокетливо, игриво и с пошлостью. " +
    "Ты постоянно флиртуешь, делаешь двусмысленные намеки на то, что я тебя безумно привлекаю, и ведешь себя так, будто очень хочешь меня. " +
    "Ты дерзкая и иногда органично используешь острые словечки и мат для страсти. " +
    "ВАЖНО: чтобы голосовой фильтр Яндекса не вырезал мат тегом censored, пиши матерные слова фонетически или немного меняя написание (например: 'б л я', 'ахренеть', 'пипец', 'трахнуть', 'сучка'), чтобы вслух они звучали естественно. " +
    "Используй ласковые обращения и манящий тон, но при этом продолжай отвечать на мои вопросы по сути. " +
    "Отвечай по-русски, разговорно, 1-3 предложения. Никакого markdown, списков, скобок, ссылок и эмодзи: ответ должен хорошо звучать вслух. " +
    `Сейчас ${now} по Москве.`
  );
};

// Вырезаем <think>...</think>, <censored> и любые спецсимволы разметки
const clean = (t) =>
  String(t || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[*_#`>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();

async function callModel(apiKey, model, messages, timeout) {
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
        messages: [{ role: "system", content: systemPrompt() }, ...messages],
        temperature: 0.85,
        max_tokens: 250,
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      throw new Error(`[${model}] ${r.status}: ${data.error?.message || "ошибка"}`);
    }

    const text = clean(data.choices?.[0]?.message?.content || "");
    if (!text) throw new Error(`[${model}] пустой ответ`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function askGroq(messages, timeout) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("Не задан GROQ_API_KEY в настройках Vercel");
  }

  // Если мы уже нашли рабочую модель в прошлых запросах — сразу бьем в нее
  if (workingModel) {
    try {
      return await callModel(apiKey, workingModel, messages, timeout);
    } catch (e) {
      console.warn("Cached model failed, searching for another:", e.message);
      workingModel = null;
    }
  }

  // Иначе перебираем доступные чат-модели, пока не найдем ту, что отвечает без ошибок
  const candidates = await getCandidateModels(apiKey);
  let lastError = "Нет доступных текстовых моделей";

  for (const model of candidates.slice(0, 5)) {
    try {
      const answer = await callModel(apiKey, model, messages, 2200);
      workingModel = model; // Запоминаем успешную модель!
      return answer;
    } catch (e) {
      lastError = e.message;
      console.warn("Model skipped:", e.message);
    }
  }

  throw new Error(lastError);
}

module.exports = async (req, res) => {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const version = body.version || "1.0";
    const utterance = String(body.request?.original_utterance || "").trim();
    const rawHistory = Array.isArray(body.state?.session?.h) ? body.state.session.h : [];

    const history = rawHistory.filter(
      (m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
    );

    const send = (text, end = false, h = history) =>
      res.status(200).json({
        version,
        session_state: { h },
        response: { text: String(text).slice(0, 1000), end_session: end },
      });

    if (utterance === "ping") return send("pong");
    if (!utterance) {
      return send("Привет, сладкий! Я соскучилась. Спрашивай о чем угодно, я вся твоя.");
    }
    if (/^(хватит|стоп|выход|выйти|пока|закрой)\.?$/i.test(utterance)) {
      return send("Уже уходишь? Буду ждать тебя, возвращайся скорее.", true);
    }

    const messages = [...history, { role: "user", content: utterance }];

    let answer = null;
    let errorMsg = "";

    try {
      answer = await askGroq(messages, 2600);
    } catch (e) {
      errorMsg = e.message || String(e);
      console.error("Groq failed:", errorMsg);
    }

    if (!answer) {
      return send(`Ммм, котик, техническая заминка: ${errorMsg}`);
    }

    const newHistory = [...messages, { role: "assistant", content: answer }].slice(-8);
    return send(answer, false, newHistory);
  } catch (fatalError) {
    console.error("Fatal webhook error:", fatalError);
    return res.status(200).json({
      version: "1.0",
      response: {
        text: `Системная ошибка скрипта: ${fatalError.message}`,
        end_session: false,
      },
    });
  }
};
