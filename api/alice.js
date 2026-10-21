// api/alice.js — безотказный вебхук навыка Яндекс Алисы на Groq

let cachedModel = null;

// Автоматически находим лучшую доступную модель на аккаунте Groq (чтобы никогда не было ошибки 404)
async function getAvailableModel(apiKey) {
  if (cachedModel) return cachedModel;
  try {
    const r = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (r.ok) {
      const data = await r.json();
      const ids = (data.data || [])
        .map((m) => m.id)
        .filter((id) => !/whisper|guard|tts|vision|embed|audio/i.test(id));

      // Приоритет лучших чат-моделей
      const preferred = [
        "qwen/qwen3-32b",
        "llama-3.3-70b-versatile",
        "qwen-qwq-32b",
        "gemma2-9b-it",
        "llama-3.1-8b-instant",
        "llama3-70b-8192",
        "llama3-8b-8192",
        "mixtral-8x7b-32768",
      ];

      for (const p of preferred) {
        if (ids.includes(p)) {
          cachedModel = p;
          return p;
        }
      }
      if (ids.length > 0) {
        cachedModel = ids[0];
        return cachedModel;
      }
    }
  } catch (e) {
    console.error("Failed to fetch models:", e);
  }
  return "llama-3.1-8b-instant";
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

async function askGroq(messages, timeout) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("Не задан GROQ_API_KEY в настройках Vercel");
  }

  const model = await getAvailableModel(apiKey);
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
      cachedModel = null; // Сбрасываем кэш модели при ошибке
      throw new Error(`Код ${r.status}: ${data.error?.message || "ошибка API"}`);
    }

    const text = clean(data.choices?.[0]?.message?.content || "");
    if (!text) throw new Error("Пустой ответ от нейросети");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  // Глобальный перехват ошибок — сервер НИКОГДА не упадет с ошибкой 500
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
