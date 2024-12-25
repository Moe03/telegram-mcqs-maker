/****************************************************
 * index.ts
 ****************************************************/
import express, { Request, Response } from "express";
import TelegramBot, { Message } from "node-telegram-bot-api";
import dotenv from "dotenv";
import { ChatOpenAI } from "@langchain/openai";
import { supportedModels } from "./zod_stuff";
import { ChatAnthropic } from "@langchain/anthropic";

dotenv.config();

// Read environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5000;
const WEBHOOK_URL =
  process.env.NODE_ENV === "production"
    ? process.env.WEBHOOK_URL
    : `https://moe.a.pinggy.link/telegram-webhook`;

// 1) Create Express server
const app = express();
app.use(express.json());

app.get("/", (req: Request, res: Response) => {
  res.send("Hello World");
});

// 2) Create Telegram Bot (in webhook mode)
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

// 3) Set up the webhook route for Telegram
app.post("/telegram-webhook", (req: Request, res: Response) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// 4) Configure your webhook with Telegram
//    This is typically done once when the server starts up.
//    Replace `YOUR_PUBLIC_DOMAIN` with your actual domain or ngrok https endpoint.
bot.setWebHook(WEBHOOK_URL || "").then(() => {
  console.log(`Telegram bot webhook set to: ${WEBHOOK_URL}`);
});

// 6) Listen for text messages
bot.on("message", async (msg: Message) => {
    try {
        const chatId = msg.chat.id;

        // If there's no text, ignore
        if (!msg.text) return;
      
        // Simple command: "/make_mcq 50 some_long_text_here..."
        // The format: /make_mcq <number_of_questions> <content...>
        // Example user message: "/make_mcq 10 The quick brown fox..."
        if (msg.text.startsWith("/make_mcq")) {
          const [_, numQsStr, ...contentArr] = msg.text.split(" ");
          const modelName = numQsStr.split(" ")[0];
          const content = contentArr.join(" ");
      
          // A safety check
          if (!content) {
            bot.sendMessage(
              chatId,
              "Please provide the content to generate MCQ questions from."
            );
            return;
          }
      
          if (!modelName) {
            bot.sendMessage(
              chatId,
              "Please provide the model name to generate MCQ questions from."
            );
            return;
          }
      
          const parsedModelName = supportedModels.find(
            (model) => model.toLowerCase() === modelName.toLowerCase()
          );
          if (!parsedModelName) {
            bot.sendMessage(
              chatId,
              "Please provide a valid model name to generate MCQ questions from."
            );
            return;
          }
      
          // 5) Initialize a LangChain LLM (OpenAI)
          let llm;
          if (parsedModelName?.includes("claude")) {
            llm = new ChatAnthropic({
              temperature: 0.7,
              modelName: parsedModelName, // or 'gpt-4' if you have access
            });
          } else {
            llm = new ChatOpenAI({
              temperature: parsedModelName === "o1-preview" ? 1 : 0.7,
              modelName: parsedModelName, // or 'gpt-4' if you have access
            });
          }
      
          // 6a) Construct a prompt for GPT
          const prompt = `
            You are a test question generator. 
            Given the following content, instructions create multiple-choice questions in JSON format. 
            Each question should have:
              - question: The question text
              - options: An array of possible answers
              - correctOptionIndex: The index (0-based) of the correct answer in the options array
              - explanation: Explanation of the correct answer
            Content:
            ${content}
      
            Return ONLY valid JSON; do not include additional text.
            Example of the JSON structure:
            [
              {
                "question": "Sample question?",
                "options": ["Option A", "Option B", "Option C", "Option D"],
                "correctOptionIndex": 2,
                "explanation": "Explanation of the correct answer"
              },
              ...
            ]
          `;
      
          try {
            // 6b) Call the LLM
            const gptResponse = await llm.invoke(prompt);
      
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
              const text: string =
                typeof gptResponse.content === "string"
                  ? gptResponse.content
                  : gptResponse.content[0].type === "text"
                  ? gptResponse.content[0].text
                  : "";
              const firstBracketIndex = text.indexOf("[");
              const lastBracketIndex = text.lastIndexOf("]");
              const jsonText = text.substring(
                firstBracketIndex,
                lastBracketIndex + 1
              );
              questions = JSON.parse(jsonText);
            } catch (err) {
              // If GPT returns invalid JSON or has extra text, this could fail
              console.error("Failed to parse JSON from GPT:", gptResponse.text);
              bot.sendMessage(
                chatId,
                "Sorry, the AI returned invalid JSON. Please try again."
              );
              return;
            }
      
            // 6d) For each MCQ question, create a Telegram quiz poll
            //     NOTE: Telegram has limits. For instance, maximum 10 options per poll,
            //     and the total length constraints. So for large sets, consider chunking or summarizing.
            for (const q of questions) {
              const questionText = q.question;
              const options = q.options?.map((option: string) => option.slice(0, 100));
              const correctOptionIndex = q.correctOptionIndex;
              const explanation = q.explanation;
      
              // If question data is missing, skip
              if (!questionText || !options || correctOptionIndex == null) continue;
      
              // By default, you can send poll type = 'quiz' to highlight correct answer
              // The correct answer is highlighted after the user votes.
              try {
                await bot.sendPoll(
                  chatId,
                  questionText?.slice(0, 200) || "",
                  options,
                  {
                    type: "quiz",
                    correct_option_id: correctOptionIndex,
                    explanation: explanation,
                    is_anonymous: false, // or true, depending on your needs
                  }
                );
              } catch (error) {
                console.error("Error sending poll:", error);
                bot.sendMessage(
                  chatId,
                  `Oops, something went wrong while sending the poll: ${error?.toString()}`
                );
              }
            }
      
            // 6e) Optionally send a final message or summary
      
            bot.sendMessage(
              chatId,
              `Done! I have created ${questions.length} MCQ question polls.`
            );
          } catch (err) {
            console.error("Error creating MCQ via GPT:", err);
            bot.sendMessage(
              chatId,
              "Oops, something went wrong while generating MCQs."
            );
          }
        } else {
          // Fallback: any text not matching /make_mcq
          bot.sendMessage(
            chatId,
            "Hello! Use /make_mcq <model> <prompt> to generate MCQs, supported models are: \n\n " +
              supportedModels.join(", ")
          );
        }
  } catch (error) {
    console.error("Error processing message:", error);
  }
});

// 7) Start the Express server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
