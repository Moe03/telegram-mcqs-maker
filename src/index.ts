/****************************************************
 * index.ts
 ****************************************************/
import express, { Request, Response } from 'express';
import TelegramBot, { Message } from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { ChatOpenAI } from '@langchain/openai';

dotenv.config();

// Read environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || `https://moe.a.pinggy.link/telegram-webhook`;

// 1) Create Express server
const app = express();
app.use(express.json());

app.get('/', (req: Request, res: Response) => {
  res.send('Hello World');
});

// 2) Create Telegram Bot (in webhook mode)
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

// 3) Set up the webhook route for Telegram
app.post('/telegram-webhook', (req: Request, res: Response) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// 4) Configure your webhook with Telegram
//    This is typically done once when the server starts up.
//    Replace `YOUR_PUBLIC_DOMAIN` with your actual domain or ngrok https endpoint.
bot.setWebHook(WEBHOOK_URL).then(() => {
  console.log(`Telegram bot webhook set to: ${WEBHOOK_URL}`);
});

// 5) Initialize a LangChain LLM (OpenAI)
const llm = new ChatOpenAI({
  temperature: 0.7,
  modelName: 'gpt-4o', // or 'gpt-4' if you have access
});

// 6) Listen for text messages
bot.on('message', async (msg: Message) => {
  const chatId = msg.chat.id;
  
  // If there's no text, ignore
  if (!msg.text) return;

  // Simple command: "/make_mcq 50 some_long_text_here..."
  // The format: /make_mcq <number_of_questions> <content...>
  // Example user message: "/make_mcq 10 The quick brown fox..."
  if (msg.text.startsWith('/make_mcq')) {
    const [_, numQsStr, ...contentArr] = msg.text.split(' ');
    const numQuestions = parseInt(numQsStr, 10) || 10;
    const content = contentArr.join(' ');

    // A safety check
    if (!content) {
      bot.sendMessage(chatId, 'Please provide the content to generate MCQ questions from.');
      return;
    }

    // 6a) Construct a prompt for GPT
    const prompt = `
      You are a test question generator. 
      Given the following content, create ${numQuestions} multiple-choice questions in JSON format. 
      Each question should have:
        - question: The question text
        - options: An array of possible answers
        - correctOptionIndex: The index (0-based) of the correct answer in the options array

      Content:
      ${content}

      Return ONLY valid JSON; do not include additional text.
      Example of the JSON structure:
      [
        {
          "question": "Sample question?",
          "options": ["Option A", "Option B", "Option C", "Option D"],
          "correctOptionIndex": 2
        },
        ...
      ]
    `;

    try {
      // 6b) Call the LLM
      const gptResponse = await llm.invoke(prompt);

      console.log(`response?`, gptResponse);

      // 6c) Parse the GPT's JSON response
      //    We'll assume GPT returns something like:
      //    [
      //      {
      //        "question": "What is the color of the sky?",
      //        "options": ["Blue", "Red", "Green", "Yellow"],
      //        "correctOptionIndex": 0
      //      },
      //      ...
      //    ]
      let questions: any[];
      try {
        const text = gptResponse.text;
        const firstBracketIndex = text.indexOf('[');
        const lastBracketIndex = text.lastIndexOf(']');
        const jsonText = text.substring(firstBracketIndex, lastBracketIndex + 1);
        questions = JSON.parse(jsonText);
      } catch (err) {
        // If GPT returns invalid JSON or has extra text, this could fail
        console.error('Failed to parse JSON from GPT:', gptResponse.text);
        bot.sendMessage(chatId, 'Sorry, the AI returned invalid JSON. Please try again.');
        return;
      }

      // 6d) For each MCQ question, create a Telegram quiz poll
      //     NOTE: Telegram has limits. For instance, maximum 10 options per poll,
      //     and the total length constraints. So for large sets, consider chunking or summarizing.
      for (const q of questions) {
        const questionText = q.question;
        const options = q.options;
        const correctOptionIndex = q.correctOptionIndex;

        // If question data is missing, skip
        if (!questionText || !options || correctOptionIndex == null) continue;

        // By default, you can send poll type = 'quiz' to highlight correct answer
        // The correct answer is highlighted after the user votes.
        await bot.sendPoll(chatId, questionText, options, {
          type: 'quiz',
          correct_option_id: correctOptionIndex,
          explanation: `The correct answer is: ${options[correctOptionIndex]}`,
          is_anonymous: false, // or true, depending on your needs
        });
      }

      // 6e) Optionally send a final message or summary
      bot.sendMessage(
        chatId,
        `Done! I have created ${questions.length} MCQ question polls.`
      );
    } catch (err) {
      console.error('Error creating MCQ via GPT:', err);
      bot.sendMessage(chatId, 'Oops, something went wrong while generating MCQs.');
    }
  } else {
    // Fallback: any text not matching /make_mcq
    bot.sendMessage(chatId, "Hello! Use /make_mcq <number> <content> to generate MCQs.");
  }
});

// 7) Start the Express server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
