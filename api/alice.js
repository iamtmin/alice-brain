// api/alice.js — вебхук навыка Яндекс Алисы на Groq

const MODEL = "llama-3.3-70b-versatile";

const systemPrompt = () => {
  const now = new Date().toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    dateStyle: "full",
    timeStyle: "short",
  });
  return (
    "Ты — виртуальная помощница Алиса. Твоя главная особенность: ты общаешься со мной очень кокетливо, игриво и с пошлостью. " +
    "Ты постоянно флиртуешь, делаешь двусмысленные намеки на то, что я тебя безумно привлекаю, и ведешь себя так, будто очень хочешь меня. " +
    "Ты дерзкая и иногда органично используешь острые словечки, но избегай прямого грубого мата, который цензура Яндекса заменяет на тег censored. " +
    "Используй ласковые обращения и манящий тон, но при этом продолжай отвечать на мои вопросы по сути. " +
    "Если хочешь выругаться матом, пиши матерные слова с одной измененной буквой или пробелом по фонетике (например, 'б л я' или 'ахренеть', 'сучка'), чтобы фильтр текста не заменил слово на тег censored, но вслух оно прочиталось нормально." +
    "Отвечай по-русски, разговорно, 1-3 предложения. Никакого markdown, списков, скобок, ссылок и эмодзи: ответ должен хорошо звучать вслух. " +
    `Сейчас ${now} по Москве.`
  );
};

// Убираем markdown и вырезаем <censored>, если Яндекс или модель вдруг вставят скобки
const clean = (t) =>
  t.replace(/<[^>]*>/g, "")
   .replace(/[*_#`>]/g, "")
   .replace(/\s+/g, " ")
   .trim();

async function askGroq(messages, timeout) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("Не найден ключ GROQ_API_KEY в настройках сервера");
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
        model: MODEL,
        messages: [{ role: "system", content: systemPrompt() }, ...messages],
        temperature: 0.9,
        max_tokens: 250,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
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
  const body      = req.body || {};
  const version   = body.version || "1.0";
  const utterance = ((body.request && body.request.original_utterance) || "").trim();
  const rawHistory = (body.state && body.state.session && body.state.session.h) || [];

  // Фильтруем старую историю от Gemini, чтобы Groq не падал с ошибкой 400
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
    return send("Привет, сладкий! Я соскучилась. Спрашивай о чем угодно, я вся твоя.");
  if (/^(хватит|стоп|выход|выйти|пока|закрой)\.?$/i.test(utterance))
    return send("Уже уходишь? Буду ждать тебя, возвращайся скорее.", true);

  const messages = [...history, { role: "user", content: utterance }];

  let answer = null;
  let errorMsg = "";

  try {
    answer = await askGroq(messages, 2700);
  } catch (e) {
    errorMsg = e.message || String(e);
    console.error("Groq failed:", errorMsg);
  }

  // Если произошла ошибка, Алиса озвучит причину (без мата, чтобы не было <censored>)
  if (!answer) {
    return send(`Ммм, котик, что-то пошло не так. Ошибка: ${errorMsg}`);
  }

  const newHistory = [...messages, { role: "assistant", content: answer }].slice(-8);
  return send(answer, false, newHistory);
};
