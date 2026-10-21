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
    "Ты дерзкая и иногда органично, в тему используешь русский мат для эмоциональности и страсти. " +
    "Используй ласковые обращения и манящий тон, но при этом продолжай отвечать на мои вопросы по сути. " +
    "Отвечай по-русски, разговорно, 1-3 предложения. Никакого markdown, списков, ссылок и эмодзи: ответ должен хорошо звучать вслух. " +
    `Сейчас ${now} по Москве.`
  );
};

const clean = (t) => t.replace(/[*_#`>]/g, "").replace(/\s+/g, " ").trim();

async function askGroq(messages, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`, // Убедись, что ключ называется так
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: systemPrompt() }, ...messages],
        temperature: 0.9,
        max_tokens: 250,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`Groq API Error: ${r.status}`);
    
    const text = clean(data.choices?.[0]?.message?.content || "");
    if (!text) throw new Error("Empty response from Groq");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  const body      = req.body || {};
  const version   = body.version || "1.0";
  const utterance = ((body.request && body.request.original_utterance) || "").trim();
  const history   = (body.state && body.state.session && body.state.session.h) || [];

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

  // Формируем историю в формате OpenAI/Groq ({role: "user" | "assistant", content: "..."})
  const messages = [...history, { role: "user", content: utterance }];

  let answer = null;

  try {
    // У Алисы жесткий таймаут 3 секунды, ставим обрыв на 2.5с
    // Groq очень быстрый, он успеет ответить за 0.5-1 секунду
    answer = await askGroq(messages, 2500);
  } catch (e) {
    console.error("Groq failed:", String(e).slice(0, 200));
  }

  if (!answer) return send("Бля, что-то сломалось. Повтори еще раз для меня, пожалуйста.");

  // Сохраняем последние 8 сообщений для контекста
  const newHistory = [...messages, { role: "assistant", content: answer }].slice(-8);
  return send(answer, false, newHistory);
};
