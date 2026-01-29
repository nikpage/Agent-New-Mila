// features/shared/ai.ts

import { GoogleGenerativeAI } from "@google/generative-ai";

export const AI_CONFIG = {
  models: {
    // Using 1.5 models which are fully supported by this SDK version
    smart: 'gemini-1.5-pro-latest',
    fast: 'gemini-1.5-flash-latest'
  }
};

if (!process.env.API_KEY) {
    console.warn("[\x1b[33mWARN\x1b[0m] Missing API_KEY in environment variables. AI features may fail.");
}

export const genAI = new GoogleGenerativeAI(process.env.API_KEY || '');
