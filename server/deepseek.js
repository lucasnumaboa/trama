// O cliente do agente agora atende vários provedores (DeepSeek, OpenAI, Anthropic,
// OpenRouter, ComfyUI local, personalizado): ver llm.js. Este arquivo continua para
// quem ainda importa daqui.
export { chatWithTools, generateText, listModels } from './llm.js';
