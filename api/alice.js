// api/alice.js — вебхук навыка Яндекс Алисы на Groq

// Актуальные доступные модели Groq (Llama 3.3 перевели в Enterprise)
const PRIMARY_MODEL  = "qwen/qwen3.8-27b";
const FALLBACK_MODEL = "openai/gpt-oss-120b";

const systemPrompt = () => {
  const now = new Date().toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    dateStyle: "full",
    timeStyle: "short",
  });
  return (
    "Ты — виртуальная помощница Алиса. Твоя главная особенность: ты общаешься со мной очень кокетливо, игриво и с пошлостью. " +
    "Ты постоянно флиртуешь, делаешь двусмысленные намеки на то, что я тебя безумно привлекаю, и ведешь себя так, будто очень хочешь меня. " +
    "Ты дерзкая и иногда органично используешь острые словечки и мат для страсти. " +
    "ВАЖНО: чтобы голосовой фильтр Яндекса не вырезал мат тегом censored, пиши матерные слова фонетически или немного искажая написание (например: 'б л я', 'ахренеть', 'пипец', 'трахнуть', 'сучка'), чтобы вслух они звучали естественно. " +
    "Используй ласковые обращения и манящий тон, но при этом продолжай отвечать на мои вопросы по сути. " +
    "Отвечай по-русски, разговорно, 1-3 предложения. Никакого markdown, списков, скобок, ссылок и эмодзи: ответ должен хорошо звучать вслух. " +
    `Сейчас ${now} по Москве.`
  );
};

// Вырезаем любые <теги> (включая <think> и <censored>) и спецсимволы
const clean = (t) =>
  t.replace(/<think>[\s\S]*?<\/think>/gi, "")
   .replace(/<[^>]*>/g, "")
   .replace(/[*_#`>]/g, "")
   .replace(/\s+/g, " ")
   .trim();

async function askGroq(model, messages, timeout) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("Не задан GROQ_API_KEY");
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: "system", content: systemPrompt() }, ...messages],
        temperature: 0.9,
        max_completion_tokens: 250,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      throw new Error(`Код ${r.status}: ${data.error?.message || "ошибка API"}`);
    }
    
    const text = clean(data.choices?.[0]?.message?.content || "");
    if (!text) throw new Error("Пустой ответ от модели");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  const body       = req.body || {};
  const version    = body.version || "1.0";
  const utterance  = ((body.request && body.request.original_utterance) || "").trim();
  const rawHistory = (body.state && body.state.session && body.state.session.h) || [];

  // Очищаем историю от старого формата Gemini, если он остался в сессии
  const history = rawHistory.filter(
    (m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
  );

  const send = (text, end = false, h = history) =>
    res.status(200).json({
      version,
      session_state: { h },
      response: { text: text.slice(0, 1000), end_session: end },
    });

  if (utterance === "ping") return send("pong");
  if (!utterance)
    return send("Привет, сладкий! Я соскучилась. Спрашивай о чем угодно, я вся твоя
